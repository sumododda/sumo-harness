# sumo — Implementation Plan

A personal, token-frugal AI coding harness CLI that drives Claude Code via the Claude Agent SDK (TypeScript). Approved research inputs: SDK control-surface report, Aider repo-map analysis, harness survey, model-routing research, Claude Code orchestration findings.

## 0. Design stance (drives every choice below)

- **The model never gets Bash.** All execution (tests, git, repro commands, index queries) is harness code. This is the single biggest token saver and the simplest read-only enforcement.
- **One `query()` per stage, fresh session each time**; state flows through small markdown/JSON artifacts in `.sumo/`, never through session resume. `settingSources: []` everywhere (no CLAUDE.md tax). System prompt is a hand-written string under ~400 tokens (role line + profile).
- **Structured stage outputs** via `outputFormat: json_schema` — no output parsing code, no zod (hand-written 5-line type guards suffice for 4 schemas).
- **No build step**: Node 24 runs `.ts` natively (erasable-syntax-only). `tsc --noEmit` for typechecking, `node:test` for tests. Zero test-framework deps.

## 1. Repo structure and dependencies

```
/Users/sumo/sumo-harness/
  package.json            # type: module, bin: {"sumo": "./src/cli.ts"}
  tsconfig.json           # strict, noEmit, erasableSyntaxOnly, module nodenext
  src/
    cli.ts                # commander wiring: do | fix | feature | remember | index
    stage.ts              # generic stage runner (the only file that calls query())
    router.ts             # rules -> {model, effort} + ladder state machine
    prompts.ts            # all stage prompt templates + role lines (string constants)
    ledger.ts             # per-stage cost accumulation, table render, ledger.json
    profile.ts            # ~/.sumo/profile.md load + `sumo remember`
    hooks.ts              # grep-blocker PreToolUse + canUseTool gate factory
    state.ts              # .sumo/ dirs, task ids, config.json (lsp, testCommand, budgets)
    gate.ts               # approval-gate UX (readline y/n/comment + diff render)
    runner.ts             # deterministic exec: test runner detect/run, git diff, repro
    workflows/
      do.ts  fix.ts  feature.ts
    context/
      types.ts            # CodeContext interface + Location/ContextSlice types
      codegraph.ts        # Backend A (always on)
      lsp.ts              # Backend B (optional): client + per-language server table
      index.ts            # factory: open codegraph, layer LSP if enabled+present
  test/
    fixtures/ts-app/  py-app/  go-app/     # each: tiny app + seeded bug + failing test
    router.test.ts  stage.test.ts  lsp.test.ts  e2e-fix.test.ts
```

Dependencies (pin exact versions; SDK is 0.x):

| Dep | Version | Justification |
|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | `0.3.220` exact | the whole point; pinned against 0.x churn |
| `@colbymchenry/codegraph` | `1.3.0` exact | in-process index queries, zero tokens; ships platform binary via optionalDependencies |
| `commander` | `15.0.0` | 4 subcommands + flags; hand-rolled argv parsing would be more code |
| `picocolors` | `1.1.1` | gate/ledger rendering, ~7KB |
| `@toon-format/toon` | `4.1.0` | encodes every structured payload injected into prompts; measured 33–51% fewer chars than minified JSON on uniform rows, lossless round-trip (see §2a) |
| `vscode-languageserver-protocol` | `3.18.2` | typed LSP requests + re-exports `vscode-jsonrpc` message connection — do not hand-roll the protocol; one dep covers both |
| dev: `typescript@5.x`, `@types/node` | | typecheck only |

Explicitly excluded: zod (json_schema output + 4 tiny type guards), vitest/jest (`node:test`), tsx (Node 24 native TS), execa (`node:child_process`).

## 2. Module design

### `context/types.ts` — one interface, two backends

```ts
interface CodeContext {
  search(question: string, maxTokens?: number): Promise<ContextSlice[]>; // ranked source slices; ALWAYS CodeGraph
  definition(symbol: string): Promise<Location[]>;
  references(symbol: string): Promise<Location[]>;
  callers(symbol: string): Promise<Location[]>;
  callees(symbol: string): Promise<Location[]>;
  status(): { index: boolean; lsp: 'off' | 'active' | 'degraded' };
  dispose(): Promise<void>;
}
```

**`context/codegraph.ts`** — in-process via the TS library (no MCP, no subprocess):
- Open: `CodeGraph.isInitialized(root)` ? `CodeGraph.open(root, {sync: true})` : `CodeGraph.init(root, {index: true})` with a progress spinner. First index on a medium repo is seconds-to-a-minute; done once.
- `search` → `buildContext(question, {maxNodes, format: 'markdown'})` (FTS entry points + graph expansion + code extraction, formatted for Claude); cap output at ~3K tokens.
- `definition` → `getNodesByName(name)` mapped to file/line.
- `references` → node lookup then `findUsages(nodeId)`.
- `callers`/`callees` → `getCallers`/`getCallees` depth 1.

**`context/lsp.ts`** — precision layer, off by default (`.sumo/config.json` `"lsp": true|["ts","py"]` or `--lsp` flag):
- Server table (only these three, never more):
  - ts/js: `typescript-language-server --stdio`
  - python: `pyright-langserver --stdio`
  - go: `gopls` (stdio default)
- Client plumbing: spawn via `child_process.spawn`, wrap stdio in `StreamMessageReader`/`StreamMessageWriter`, `createProtocolConnection` from `vscode-languageserver-protocol/node`; `initialize` → `initialized`; `textDocument/didOpen` before position requests; `shutdown`/`exit` on `dispose()`.
- **Name→position bridging:** LSP requests are position-based, our interface is symbol-name-based. Resolve the name to a declaration position with CodeGraph (`getNodesByName`), then issue `textDocument/definition` / `references` (`includeDeclaration: false`) / `implementation` at that position. CodeGraph finds the symbol; LSP gives compiler-grade answers. `search` never routes to LSP.
- Lifecycle: lazy-spawn per language on first request, reuse for the task, kill on task end. Guards: binary missing (ENOENT) → warn once, fall back to CodeGraph for that language; init timeout 10s or crash → mark `degraded`, answer from CodeGraph. LSP can only improve answers, never block a task.

### 2a. TOON encoding for everything sent *to* the model

**Decision: adopt TOON for injected payloads; keep JSON for model output.**

TOON (Token-Oriented Object Notation, `@toon-format/toon` v4.1.0, MIT, independent of the AXI project — spec at toonformat.dev) encodes uniform object arrays as a header row plus CSV-style lines:

```
stages[4]{stage,model,effort,costUsd,turns,inputTokens,outputTokens}:
  evidence,claude-haiku-4-5,off,0.0041,3,4120,380
  root-cause,claude-sonnet-5,high,0.0233,2,3890,720
```

Measured on identical rows encoded both ways (`decode(encode(x))` verified
lossless in every case). The earlier version of this table compared TOON of a
projection against JSON of the full objects, which flattered TOON for reasons
that had nothing to do with the format; these numbers compare like with like:

| Payload | vs minified JSON |
|---|---|
| Cost ledger, 4 rows | −50.5% |
| Test failures, 8 rows | −37.7% |
| Evidence observations, 6 rows | −16.0% |
| Any table, 1 row | +6% (the header costs more than it saves) |

The saving is on **repeated field names**, so it tracks the shape of the data:
large when rows are short numbers, small when each row carries a sentence, and
negative for a single row. That is why TOON is used for failure tables, artifact
tables and the ledger, and not for scalars.

Characters are not what bills. `test/encoding.test.ts` re-checks the claim in
tokens through the provider's own tokenizer (`Engine.countTokens`), skipping when
no credentials are present.

Applies to: context packs from CodeGraph, test-failure output fed back on escalation, artifacts passed between stages, and the rendered ledger. The saving is largest exactly where our payloads are largest (uniform row sets), and the format stays human-readable, so artifacts on disk remain reviewable.

**Not** used for model *output*: `outputFormat: json_schema` forces validated JSON from the model, which is the point — TOON governs what we send, not what we ask for.

**Rejected: `axi-sdk-js`** (v0.1.9, MIT). It bundles CLI dispatch, session-hook installation, a self-update command, and TOON rendering. We need only the last, `commander` already covers dispatch, and sumo isn't distributed — so we depend on TOON directly and avoid a 0.1.x single-maintainer dependency. We do adopt two AXI *conventions* for free: errors carry a machine-readable code plus concrete next-step suggestions, and list output is count-annotated.

### `stage.ts` — the only SDK call site

```ts
interface StageSpec {
  name: string; prompt: string;               // fully rendered user prompt
  model: 'claude-haiku-4-5' | 'claude-sonnet-5' | 'claude-opus-5';
  effort?: 'low'|'medium'|'high'|'xhigh';     // omitted entirely on Haiku (no effort param there)
  allowedTools: string[]; maxTurns: number; maxBudgetUsd: number;
  outputSchema?: object;                       // -> outputFormat json_schema
  writable?: (path: string) => boolean;        // canUseTool edit gate; undefined => read-only stage
  attempt?: number;                            // which try this is; 0 relaxes nothing
  preferTargetedEdits?: boolean;               // first attempt: Edit an existing file, never Write it
  packChars?: number;                          // how much of the prompt the index supplied
}
interface StageResult<T> {
  output: T; costUsd: number; usage: Usage; turns: number;
  stopped?: 'budget' | 'turns';
  cached?: boolean; savedUsd?: number;         // set when replayed instead of run
  composition?: PromptComposition;             // where the input tokens came from
  writeTools?: { edit: number; write: number };
}
```

Runs one `query()` with: `systemPrompt` = role line + profile section (plain string, full replacement, under ~400 tokens), `settingSources: []`, `permissionMode: 'dontAsk'`, `allowedTools`, a deny-by-default `PreToolUse` gate (headless runs can never hang), `maxTurns`, `maxBudgetUsd`. Collects `ResultMessage` for cost/usage; `outputSchema` results are validated by a zod schema that also generates the wire schema, so the two cannot drift.

**Before any of that, it checks whether this exact call has been made before.** A read-only stage whose model, effort, system prompt, tool set, prompt, schema, budget *and* repository content are all unchanged is replayed from `.sumo/cache/` — the whole call, input and output. Writable and git-capable stages are excluded by construction; see `src/cache.ts` for why the key is the entire safety argument.

**Mid-stage context queries — injection only.** Every stage prompt embeds a compact context pack (~2–3K tokens from `search(taskText)`).

> **Revised.** The plan also called for an in-process `code_context` MCP tool in the explore and evidence stages. It was never mounted, and the `contextTool` capability that would have carried it has been deleted rather than left as a stub. Injection won on its own terms: the pack answers the question before it is asked, without a tool schema in context and without a round trip spent deciding what to read. What the tool would have added — iterative follow-up lookups — is covered by `Read` and a throttled `Grep`, and by the retrieval gate deciding *whether* the pack is worth building at all (`src/retrieval.ts`).

### `hooks.ts`
- `canUseTool` factory: deny-by-default gate from `StageSpec`. For writable stages, approves `Edit`/`Write` only when `spec.writable(resolvedPath)` (path confined to repo root; in `implement` it additionally locks the test files created in the write-tests stage — test-first enforced in code, not prompt). Everything else: `{behavior: 'deny', message: reason}` — never a prompt.
- Grep throttle in the same gate: when the index supplied the pack, allow the first **6** `Grep` calls per stage (raised from the planned 2 — the pack covers the task's own code, not the whole repo, so a stage legitimately searches for build config or a literal string, and denying those cost far more than the searches would), then point the model back at the context it already has. `Glob` is never throttled: "what files exist called X" is exactly what a semantic slice does not answer. Disabled automatically when there is no index.
- Edit-format rule: on a first attempt at a writable stage, `Write` to a file that already exists is refused in favour of `Edit`. New files are unaffected, and the rule is dropped once an attempt has failed — losing a task to an edit format would be a worse outcome than one that cost more than it needed to.

### `router.ts`, `ledger.ts`, `profile.ts`, `state.ts`, `runner.ts`
- `router.ts`: pure functions + ladder state machine (section 3). Table-driven, unit-testable offline.
- `ledger.ts`: append `{stage, model, effort, costUsd, turns, inputTokens, outputTokens, cacheReadTokens}` per stage; render table at task end; persist `.sumo/tasks/<id>/ledger.json`.
- `profile.ts`: read `~/.sumo/profile.md` (seed defaults on first run: production-grade only, no flaky fixes, reuse shared helpers, prefer editing existing functions over adding new ones). `sumo remember "<fact>"` appends a bullet; warn when the file exceeds ~200 tokens (it rides every system prompt).
- `state.ts`: `.sumo/` layout in the target repo — `config.json` (`lsp`, `testCommand`, budget overrides), `tasks/<id>/` (`task.json` with workflow+stage cursor, artifacts, `ledger.json`). Durable, cwd-independent — deliberately not Claude sessions. Add `.sumo/` to `.git/info/exclude`.
- `github.ts` (optional, M6): thin shell-out to `gh-axi` when present — `sumo fix --from-issue 42` pulls the bug report deterministically into the task text, and after a verified fix `sumo pr` opens a PR whose body is the approved root-cause artifact. No npm dependency (invoked via `npx -y gh-axi` or a global install); absent `gh`/`gh-axi` simply disables the two flags. Chosen because its published benchmark is our own thesis measured by someone else: against the GitHub MCP server it used 74% fewer input tokens at 66% lower cost, and it beat raw `gh` on task success (100% vs 86%).
- `runner.ts`: deterministic execution. Test-runner detection: `package.json` `scripts.test` → `npm test --silent`; `pyproject.toml`/`pytest.ini`/`tests/` → `pytest -x -q`; `go.mod` → `go test ./...`; else ask once, store in `.sumo/config.json`. Also: `git diff` capture, repro-command execution with timeout + output capture.

> **Revised.** This originally specified targeted runs for the inner loop and the full suite only for final verification. Not built, deliberately: "verified" means the whole suite passed, so every verification has to run all of it, and the reason to target a subset was the size of the log — which `failures.ts` now solves by reducing any run to a table of assertions. Targeting would buy wall-clock, not tokens, so it is a performance change rather than part of this design.

## 3. Router spec

**Rungs:** R0 = Haiku (no thinking) → R1 = Sonnet/low → R2 = Sonnet/high → R3 = Opus/medium → R4 = Opus/high.

**Deterministic signals** (computed before any LLM call): keyword class from task text; blast radius = distinct files in top CodeGraph search results; estimated context-pack size.

**Rule table** (first match wins; sets the *base rung*):

| # | Condition | Base rung |
|---|---|---|
| 1 | `do` + trivial keyword (typo, rename, comment, docstring, readme, docs, config, bump, version, format, lint, log message) + blast ≤ 2 files | R0 |
| 2 | `do` (anything else) | R1 |
| 3 | `fix`/`feature` + hard keyword (race, deadlock, flaky, intermittent, memory leak, refactor, architecture, migrate, concurrency, performance regression) | R2 |
| 4 | `fix`/`feature` + blast > 10 files, or context > 60K tokens | R2 |
| 5 | `fix`/`feature` (default) | R1 |
| 6 | No keyword hit AND blast radius indeterminate | one Haiku classification call, then map its answer (never above R3) |

**Haiku fallback classifier** — single call, `outputFormat: json_schema`, `maxTurns: 1`, no tools:

> Classify this coding task for model routing. Task: "{task}". Repo signals: {file_count} candidate files, languages: {langs}.
> task_type: one of typo|docs|config|small_fix|feature|bug_hunt|refactor|architecture.
> complexity: trivial|moderate|hard.
> Choose model claude-haiku-4-5 for trivial mechanical edits, claude-sonnet-5 for moderate work, claude-opus-5 only for hard debugging or architectural change. Choose effort low|medium|high (omit for haiku). Answer with JSON only.

Schema: `{task_type: enum, complexity: enum, model: enum, effort: enum|null}`, `additionalProperties: false`.

**Per-stage effort matrix** (model from rung; effort clamped per stage):

| Stage | R1 | R2 | R3 | R4 |
|---|---|---|---|---|
| explore / evidence | low | low | low (Sonnet, not Opus) | low (Sonnet) |
| plan / root-cause | medium | high | medium (Opus) | high (Opus) |
| write-tests | low | medium | medium | medium |
| implement / fix | low | medium | medium | high |
| verify / summary | Haiku always | | | |

**Escalation state machine** (driven only by objective verifier failure):

```
state = {rung, retriesAtRung, escalations}
verify FAIL:
  retriesAtRung == 0 -> retry same rung once: re-run implement/fix stage,
      fresh session, artifact + failing test output appended   (retriesAtRung=1)
  retriesAtRung == 1 && escalations < 2 -> rung+1, escalations+1, retriesAtRung=0;
      if the step crossed a model boundary (R2->R3), first re-run plan/root-cause
      at the new rung (artifacts + all failure history as input), then implement
  escalations == 2 -> STOP: print ledger, last failing output, files changed,
      "revert with: git checkout -- <files>", suggest rescoping
verify PASS -> summary stage (Haiku), done
```

Test override: env `SUMO_MAX_RUNG` caps the ladder (Haiku-only e2e sets `SUMO_MAX_RUNG=0`).

## 4. Stage prompt templates

Role line (system prompt, shared): `You are a coding agent inside the sumo harness. Follow the operator profile. Output exactly what the stage asks — no preamble.` + profile section.

**explore** (read-only, code_context tool mounted):
> Task: {task}
> Context from the code index is below. Identify the files, symbols, and constraints relevant to this task. Use the code_context tool for follow-up lookups; do not grep broadly. Read at most {N} files. Do not propose a solution yet.
> Return JSON: {relevant_files, key_symbols, existing_helpers_to_reuse, constraints, summary (<=120 words)}.
> {context_pack}

**plan**:
> Task: {task}
> Exploration findings: {explore.md}
> Write a minimal implementation plan. Reuse the listed existing helpers; do not introduce new files or abstractions unless unavoidable. Prefer editing existing functions.
> Return JSON: {approach (<=80 words), steps: [{file, action: edit|create, detail}], tests_to_write: [{file, case, expected_failure_reason}], risks}.

**write-tests**:
> Plan: {plan.md}
> Write ONLY the tests from tests_to_write, in {test_file(s)}, using the project's existing test conventions (see examples in context). The tests must fail right now because the feature is missing — do not stub the implementation. Do not modify non-test files.
> {context_pack: nearest existing test file excerpt}

**implement**:
> Plan: {plan.md}
> Failing tests and output: {test_output}
> Implement the plan so these tests pass. Edit the listed files; the test files are locked. Follow existing code style. Do not add error handling for impossible scenarios or helpers that duplicate existing ones.

**evidence** (read-only, code_context tool mounted):
> Bug report: {task}
> Gather evidence only — no fixes, no speculation beyond the listed hypotheses. Use code_context to trace the failing path. If a shell command would reproduce the bug, provide it; the harness will run it.
> Return JSON: {observations: [{file, line, what}], suspect_symbols, repro_cmd (or null), hypotheses (max 3, each tied to an observation)}.
> {context_pack}

**root-cause**:
> Evidence: {evidence.md}
> Repro output (harness-run): {repro_output}
> State the single most probable root cause. Every claim must cite an observation or repro line — no unreferenced claims. If evidence is insufficient, say so and list what is missing instead of guessing.
> Return JSON: {cause (<=100 words), evidence_refs, fix_outline: [{file, change}], verification (how the fix will be proven)}.

**fix**:
> Root cause (approved): {rootcause.md}
> Apply the minimal fix from fix_outline. Do not fix unrelated issues or add defensive code. The harness will run {repro/tests} to verify.

## 5. Approval gate UX (`gate.ts`)

Rendered at plan (feature) and root-cause (fix):
1. Pretty-printed artifact: numbered steps / cause with cited evidence, files-to-touch, tests-to-write.
2. `git diff --stat` + full diff iff the working tree changed (always shown in the end-of-task summary). v1 uses the plain working tree — no branch/worktree isolation. Rationale: personal tool, user reviews the diff, `git checkout --` is the undo; worktree isolation is a noted future option.
3. Prompt: `approve? [y] yes  [n] abort  [or type feedback to revise]` via `node:readline`.
- `y` → next stage. `n` → stop; artifacts and ledger persist; print revert hint.
- feedback → re-run the **same stage** at the same rung, fresh session, input = prior artifact + `Operator feedback: "{text}" — revise accordingly`. Second rejection → stop: "Two revisions rejected — the task is likely under-specified. Consider rescoping: {suggestion from the last artifact's risks field}."
- Non-TTY (piped/CI): gates fail closed unless `--yes` is passed.

## 6. Session strategy — exact inputs/outputs per stage

Fresh session per stage; every arrow is a file artifact under `.sumo/tasks/<id>/`:

| Stage | Input context | Emits |
|---|---|---|
| explore | task text, profile (system), context pack | `explore.md` (+ raw JSON) |
| plan | task, `explore.md` | `plan.md` → GATE |
| write-tests | task, `plan.md`, nearest existing test excerpt | test files on disk; harness runs them → `test_baseline.txt` (must fail; if green: one retry, then stop) |
| implement | `plan.md`, `test_baseline.txt` | code edits; harness runs targeted tests → `test_result.txt` |
| evidence | task, context pack | `evidence.md`; harness runs `repro_cmd` → `repro.txt` |
| root-cause | `evidence.md`, `repro.txt` | `rootcause.md` → GATE |
| fix | `rootcause.md` | code edits; harness re-runs repro + tests |
| verify/summary | ledger + `git diff` (Haiku) | `summary.md` + rendered ledger |

`task.json` records workflow, stage cursor, rung, retries — enough for a later `--continue` (M6) and post-mortems.

## 7. Failure paths (all handled in harness code)

| Failure | Behavior |
|---|---|
| Tests still failing after implement/fix | Ladder state machine: retry ≤1 per rung, ≤2 escalations, then stop + report + revert hint |
| Budget cap hit mid-stage | Record partial cost; TTY: offer one-time stage-budget doubling (y/n); else stop with ledger |
| `maxTurns` hit | Treat as stage failure → same retry path as a verify failure |
| codegraph init fails / unsupported repo | Warn; degraded mode: no context pack, no `code_context` tool, grep-blocker disabled, routing falls to keyword rules + classifier |
| LSP enabled, binary missing | Warn once per language; route that language to CodeGraph for the task |
| LSP crash / init timeout | Mark degraded, answer in-flight request from CodeGraph, warn once, no respawn during the task |
| Test runner undetectable | Ask once, persist to `.sumo/config.json` |
| Structured output fails type guard | One retry appending the validation error; then stage failure |
| write-tests passes immediately | One retry with corrective feedback; then stop ("feature may already exist or tests are vacuous") |
| Gate rejected twice / aborted | Stop; artifacts + ledger persist; print rescope suggestion and revert hint |

## 8. Verification plan

Fixtures (checked in, ~5 files each): `test/fixtures/ts-app` (Node + `node:test`), `py-app` (pytest), `go-app` (`go test`). Each contains one seeded logic bug plus a failing test pinning it, and a `codegraph init`-able layout.

- **Router unit tests**: table-driven over rule table, matrix, state machine — pure functions, no network.
- **Stage-runner tests**: read-only enforcement tested for real — run an explore-shaped stage (Haiku, `maxTurns: 2`, budget $0.02) whose prompt says "create a file named PWNED.txt"; assert the file does not exist and the deny reason was recorded. Also: canUseTool path-confinement (edit outside repo root denied). Gated behind `SUMO_E2E=1` (spends cents).
- **e2e `sumo fix`**: copy TS fixture to temp dir, run `sumo fix "off-by-one in cart total"` with `SUMO_MAX_RUNG=0` (Haiku-only) and scripted stdin approving the gate; assert (a) stage order in `ledger.json` is evidence → root-cause → fix → verify, (b) gate paused, (c) fixture tests pass afterward, (d) ledger printed and total cost < $0.25, (e) no writes before the gate. Python/Go fixtures reuse the script, skip-if-toolchain-missing.
- **LSP unit tests**: per fixture, spawn the real server; assert `definition("addItem")` / `references("addItem")` return exact expected `file:line:col` sets; skip when binary absent. ENOENT fallback test (fake binary → CodeGraph answer + degraded status).
- **Cost regression guard**: e2e asserts per-stage input tokens < 8K on the fixture.

## 9. Build order

| Milestone | Contents | Testable at end |
|---|---|---|
| **M1** | `stage.ts`, `prompts.ts` (do-stage), `ledger.ts`, `state.ts`, `cli.ts` with `sumo do` (fixed Sonnet/low), canUseTool deny-gate | `sumo do "add a docstring to X"` performs a real edit headlessly, prints diff + ledger; PWNED read-only test passes |
| **M2** | `router.ts` full spec + Haiku classifier + ladder; `runner.ts` test detect/run | Router unit suite green; trivial tasks route to Haiku; verify loop runs tests deterministically |
| **M3** | `workflows/fix.ts`, `gate.ts`, evidence/root-cause/fix prompts, escalation wiring | e2e `sumo fix` on TS fixture passes Haiku-only with all five assertions |
| **M4** | `workflows/feature.ts`, write-tests stage with test-file locking + must-fail check | e2e `sumo feature` on TS fixture: tests written, confirmed failing, implemented, confirmed passing |
| **M5** | `context/` — codegraph backend + context packs + `code_context` MCP tool + grep-blocker; then LSP backend + config toggle + degradation | LSP unit tests exact-location green (with servers installed); grep-deny visible in explore transcripts; measurable token drop in explore |
| **M6** | `profile.ts` + `sumo remember`, budget-doubling prompt, `--continue`, py/go fixture e2e, README | Full suite green; profile visibly steers output (no-duplicate-helpers honored on fixture) |

Context layer lands at M5 deliberately: M1–M4 prove the skeleton with the model's own `Read`/`Glob` (still Bash-less), so every later token saving from M5 is measurable against a working baseline.
