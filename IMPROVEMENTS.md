# sumo — improvement plan

Ten changes, ordered by dependency and grouped into waves that can be handed to
separate agents. Each brief is self-contained: what is wrong, the evidence for
fixing it, the files it owns, and how it is proven done.

Written against `a5b3f7a` (2026-08-04). Read **Standing constraints** before
starting any brief — several of them encode decisions made in the last two
commits, and a brief that violates one will be reverted rather than merged.

---

## Standing constraints

These are settled. Do not relitigate them inside a brief.

1. **No default per-stage dollar cap.** `a5b3f7a` deleted it deliberately: a
   schema-answering stage produces nothing until it produces all of it, so a
   money cap bought no answer *plus* everything already spent. `maxTurns` is
   what bounds a stage. A caller that genuinely wants a ceiling still passes
   `maxBudgetUsd` (`sumo do --budget`, the routing classifier's two cents). Do
   not reintroduce a default.

2. **Nothing that grows per turn may enter a cacheable stage's prompt.** The
   cache key *is* the prompt. `a5b3f7a` removed the conversation from survey
   prompts because it grew every turn, so an identical retry never matched and
   the cache returned $0.09 of $4.60 across 30 tasks. Any context you add to a
   read-only stage must be a function of (task, repo content) alone.

3. **Reuse the findings-reuse mechanism, do not reinvent it.**
   `TaskState.findFindings(repo, task, fingerprint)` + a `fingerprint.txt`
   written next to the artifact is the established pattern. It is safe only
   because fingerprints match exactly; keep that property.

4. **Two audiences, two renderings.** `render*` produces TOON for prompts;
   `display*` produces boxes for the terminal; `shown*` builds both and returns
   `{ value, prompt, display }`. Any new artifact follows this. Never send a
   `display` form to a model — that is bug 23, and it costs money invisibly.

5. **Terminal output wraps to `width()`, read at draw time** (bug 26). Count
   characters, not bytes — box glyphs are three-byte UTF-8. Anything you push
   into a box goes through the wrapping helpers in `ui.ts`.

6. **Anything claiming a saving is a flag in `src/features.ts`** so `sumo bench`
   can switch it off and measure it. A claim that cannot be turned off is not a
   measurement.

7. **The model never gets a shell**, and gates are code rather than prompt text.
   If a brief's rule can be enforced by withholding a tool or by a gate check,
   enforce it there — a sentence in a prompt is not enforcement.

8. **Per-project convention:** every fix lands with a `BUGS.md` entry (what
   happened, what it cost, how it was fixed) and, where a claim was checked
   against a live model, a `TESTING.md` row. Run `npm run check` before calling
   anything done.

---

## What changed since the review (context for every brief)

Two commits landed while this plan was being written. They matter to several
briefs:

- **`bc952f8`** — boxes were framed to 120 columns while their contents wrapped
  to the real terminal edge. `width()` now reports the shell's actual width at
  draw time. Affects any brief that prints an artifact.
- **`a5b3f7a`** — three things at once: survey stages no longer receive the
  conversation; a saved survey is reused across tasks when the task text and
  repo fingerprint both match (`TaskState.findFindings`); and the $1 per-stage
  budget cap is gone. Affects B1 directly (the reuse it added went to `plan` and
  `feature` but **not** to `fix`), and constrains everything else via the
  standing constraints above.

---

# Wave A — independent, run in parallel

Four briefs, no shared files. Each owns its files outright.

## A1 — Parse vitest and jest failures · **owns `src/failures.ts`** · S

**Problem.** `failures.parse` handles node:test, pytest and go test. TypeScript
is this project's primary language and vitest/jest are its dominant runners, so
in most real TS repos the delta-retry feature silently degrades to shipping the
raw log — 6k characters where a table was promised. The parser's fallback is
correct but the saving is absent exactly where sumo would be used most.

**Do.**
- Add `parseVitest` and `parseJest` alongside the existing three, following the
  shape of `parseNode`. Both report `FAIL <file> > <suite> > <case>` lines plus
  an `● <name>` / `AssertionError` block; capture file, case name, and the
  assertion message.
- Register them in `parse()`'s dedupe list.
- Add `export function testFiles(failures: readonly Failure[]): string[]` —
  the distinct file paths named by a failure set, resolved relative to the repo
  root. **B1 depends on this**, so land it in this brief even though nothing
  here consumes it yet.

**Verify.** Unit tests in `test/failures.test.ts` against real captured output
from both runners (check the fixtures in as strings, as the existing tests do).
Assert the dedupe path: a vitest run piped through npm must not yield doubled
rows. Assert `testFiles` returns paths, not suite names.

**Done when** `npm run check` is green and a captured vitest log produces a
table rather than falling back to raw output.

---

## A2 — Let the router learn from its own corrections · **owns `src/route/`, `src/routing-log.ts`, `src/intent.ts`** · M

**Problem.** `routing-log.ts` says it plainly: *"This is a log, not a learner.
Nothing here changes how a turn is routed."* Every `/again <mode>` records
ground truth — the exact input, the route it got, the route it needed — and
nothing consumes it. Meanwhile the shipped Model2Vec corpus is generic phrasing
that has never seen this operator's vocabulary.

**Evidence.** Learned routers of this class are measurably brittle out of
distribution: a RouteLLM-style embedding router trained on MMLU-Pro fell from
0.662 AUROC to 0.546 (chance) on TriviaQA
([arXiv:2605.02241](https://arxiv.org/abs/2605.02241)). The shipped corpus is
out of distribution for every user by construction; corrections are the only
in-distribution data that exists. Precedent for the mechanism itself is
RouteLLM ([arXiv:2406.18665](https://arxiv.org/abs/2406.18665)), where augmented
training data moved the router from 26% to 14% strong-model calls at the same
quality.

**Do.**
- Read corrections out of `.sumo/routing.jsonl` at startup (they are already
  recorded; `record()` marks them).
- Build a per-repo overlay on the centroids in `src/route/local.ts`: embed each
  corrected input and fold it into the *corrected* label's centroid, weighted so
  a handful of corrections shift the boundary without swamping the shipped
  corpus.
- Keep `MIN_MARGIN` as-is. The confidence gate is the safety property and this
  brief must not widen what the local router is willing to answer — only make
  what it does answer more accurate for this operator.
- Report it in `/routing`: how many corrections are in play, and how many turns
  the overlay decided.

**Verify.** Offline test: synthesise a `routing.jsonl` with N corrections of
`chat`→`do`, assert the overlay flips exactly those phrasings and leaves the 64
held-out phrasings in `test/route.test.ts` unchanged. **The held-out suite must
not regress — that is the acceptance bar.** Add a test that a corrupt or absent
log degrades to the shipped centroids rather than throwing.

**Do not** train anything, ship a model file, or make a network call. This is
vector arithmetic over data already on disk.

---

## A3 — Make the measurement instrument trustworthy · **owns `src/bench.ts`, `test/fixtures/`** · M

**Problem.** Every claim in the README rests on three fixtures with one seeded
bug each, run once. Models are stochastic: at n=3, "3/3 verified" versus "2/3"
is inside noise, and `$/verified` — the column the README says is the only one
that decides anything — is the ratio of two noisy numbers. This repo's own
`.sumo/metrics.jsonl` has a single row.

**Do.**
- Add 4–6 more seeded tasks per fixture at mixed difficulty (a one-line
  off-by-one, a two-file change, one genuinely requiring a tier step). Keep the
  seeded-bug shape so verification stays deterministic.
- Add `--repeat N` so each (config, task) pair runs N times; report mean and
  spread, not a single number. A config whose spread overlaps the baseline's
  must be reported as *not distinguishable*, in those words.
- Add `sumo bench --from-metrics`: aggregate `.sumo/metrics.jsonl` across real
  sessions into the same table. Fixtures answer "does it help on a toy"; the
  metrics file answers "did it help this week". The infrastructure already
  writes a row per task; nothing reads it.

**Verify.** `sumo bench --from-metrics` on a synthesised metrics file produces
the expected table offline (no provider calls). The fixture additions only need
to run under `SUMO_E2E=1`; guard them the way the existing e2e paths are.

**Done when** the README's numbers can be regenerated with a spread attached,
and a bench run reports variance rather than a bare ratio.

---

## A4 — Skeleton context and windowed reads · **owns `src/context/codegraph.ts`, `src/prompts.ts`** · M

**Problem.** Open bug 22: on `sumo-news`, explore cost $0.1392 / 31s and plan
$0.0951 / 18s for what became a one-file documentation edit, because both stages
`Read` large files in full. The index is meant to displace reading, and on a
repo with large files it is currently additive.

**Evidence.** Agentless's hierarchical localization used a compressed
"skeleton" — signatures and structure, no bodies — and scored **58.33%
localization accuracy at $0.02 against 53.67% at $0.15 for full files**
([arXiv:2407.01489](https://arxiv.org/abs/2407.01489)): cheaper *and* more
accurate, because a body is noise when the question is "where does this live".
SWE-agent's ablation found a 100-line file window beat full-file display 18.0%
vs 12.7% ([arXiv:2405.15793](https://arxiv.org/abs/2405.15793)).

**Do.**
- Add `skeleton(paths)` to the CodeGraph backend: file → symbol signatures with
  line numbers, no bodies. CodeGraph already holds this; it is a query, not new
  extraction.
- Survey stages (`explore`, `evidence`) get skeletons of the task's candidate
  files ahead of full bodies, and their prompts say plainly that a body can be
  had by naming the symbol. Keep the existing pack; this sits above it.
- Gate it behind a `features.ts` flag (`skeletonContext`) per constraint 6.

**Verify.** Offline: assert the skeleton of a known fixture file contains every
exported signature and no function body, and that it is materially smaller than
the file. Under `SUMO_E2E=1`: run explore on a large-file fixture with the flag
on and off, and record both costs in the brief's BUGS.md entry — bug 22 is
closed by a number, not by an assertion that it should be faster.

**Constraint reminder.** The skeleton is derived from (task, repo) only, so it
is cache-safe. Do not let it carry anything conversational.

---

# Wave B — sequential, all touch `src/workflows/fix.ts`

Hand these to one agent in order, or to separate agents strictly one after
another. They conflict on the same file and B3 depends on B2's clean-tree
helper.

## B1 — Give `fix` the guarantees `feature` already has · **depends on A1** · M

**Problem.** Three mechanisms exist in `feature` and are simply absent in
`fix` — the same failure shape as bugs 16 and 17, where a mechanism present in
one workflow was silently missing from its sibling:

1. **Test files are not locked.** `fixUntilVerified` runs a writable stage with
   `capabilities: ['read','search','edit']` and no `lockedPaths`. The only thing
   stopping the fix stage from making a red test green by editing the test is
   the sentence "do not modify tests" in `FIX_STAGE`. `feature` locks its test
   files at the gate (`feature.ts:264`). The README claims gates are code; here
   it is a prompt. **This is the most serious item in the plan** — it is the one
   place where a stated safety property is not actually enforced.
2. **No pre-existing-failure baseline.** `feature` captures `preExistingFailures`
   before it starts and tells the implement stage to leave them alone; `fix`
   does not. In any repo with one unrelated red test, a *correct* fix can never
   verify: the ladder burns its retry and both escalations on failures the task
   did not cause, then gives up and prints a revert command for work that was
   right.
3. **No findings reuse.** `a5b3f7a` gave `plan` and `feature` survey reuse via
   `TaskState.findFindings` + `fingerprint.txt`. `fix` writes `evidence.md` but
   no `fingerprint.txt`, so a fix retried after a late failure re-pays for
   evidence gathering — the exact case that commit set out to fix.

**Do.**
- Lift `preExistingFailures` out of `feature.ts` into a shared home (`runner.ts`
  is the natural one — it already owns `newFailures` and test running) and call
  it from `fix` before the fix stage runs. Pass the baseline into `FIX_STAGE`
  the way `IMPLEMENT_STAGE` takes it, and treat "only pre-existing failures
  remain" as verified, as `feature.ts:293` does.
- Pass `lockedPaths` to the fix stage: the test files named by the current
  failures, via `failures.testFiles()` from A1. A fix that genuinely must change
  a test is a different task and should be refused here — the gate's message
  already says the right thing.
- Write `fingerprint.txt` beside `evidence.md`, and extend `findFindings` (or
  add a sibling) to read `evidence.md` for `fix` tasks. Keep fingerprint
  equality as the safety condition.

**Verify.** Offline tests against the gate the workflow really builds, mirroring
`test/feature-handoff.test.ts`: a write to a locked test file is refused, a write
to source is allowed, a suite whose only failures are pre-existing verifies, and
a genuinely new failure still escalates. Add a `TESTING.md` row for the locking
claim — it belongs in the Enforcement table beside E2.

---

## B2 — Clean the tree between ladder attempts · M

**Problem.** Retries are already clean-*context* — a fresh stage carrying only
the failure table, which is right. But the *disk* is not clean: attempt 2 runs
against attempt 1's failed edits while its prompt says "make exactly this
change" against a root cause written for the original tree. The model is handed
a contradiction it has no way to see.

**Evidence.** Clean restarts dominate contaminated retries by a wide margin:
keeping a failed attempt in context multiplied error rates ~7.1× on SWE-bench
data ([arXiv:2605.08563](https://arxiv.org/abs/2605.08563)). sumo already applies
this to context; the same argument applies to state the model can read back off
the filesystem.

**Do.** Add a `runner` helper that reverts the files a failed attempt touched
(`git checkout --` limited to files the attempt itself changed — never files
that were already dirty when the task began; `feature` already computes
`alreadyChanged` for exactly this distinction, so reuse that idea). Call it in
both `fix`'s and `feature`'s retry loops before the next attempt.

Behind a `features.ts` flag (`cleanRetries`), because it is a claim about
correctness-per-dollar like any other.

**Safety bar.** This brief touches the working tree, which makes it the most
dangerous one here. It must never revert a file the task did not write. Test
that property first and hardest: a dirty file present before the task starts
survives a retry untouched.

---

## B3 — Reproduction test, and pick the winner by running it · **depends on B2** · L

**Problem.** `fix` verifies a patch but never *selects* between patches. The
evidence stage proposes a repro *command*; nothing durable comes out of it.

**Evidence.** This is the largest measured single lever in the literature. In
Agentless's ablation, majority voting alone scored 25.67%, adding regression-test
filtering took it to 27.0%, and adding **generated reproduction tests took it to
32.0%** — the biggest component gain in the paper
([arXiv:2407.01489](https://arxiv.org/abs/2407.01489)). CodeMonkeys built 57.4%
on SWE-bench Verified out of parallel (test, edit) candidates selected by
execution ([arXiv:2501.14723](https://arxiv.org/abs/2501.14723)). For a cascade
specifically, using self-generated tests as the escalation gate cut cost 26% on
average and up to 70% ([arXiv:2405.15842](https://arxiv.org/abs/2405.15842)).

**Do.**
- Extend the `Evidence` schema with a reproduction *test* (file + case) beside
  the existing repro command, and have the evidence stage write it. The harness
  runs it and confirms it fails — a repro test that passes before the fix proves
  nothing, exactly as `feature` already argues for its test-first stage.
- Sample K=2 candidate fixes at the cheap rung instead of one (K behind a flag,
  default 2). Between candidates, revert with B2's helper and capture each
  diff. Keep the first candidate that turns the repro test green with no new
  failures; discard the rest.
- Two cheap candidates cost less than one attempt a tier up at the ~5× spread,
  so this is a *cheaper* path to the same verified outcome, not a luxury. Say so
  in the ledger: report candidates tried alongside cost.

**Constraint reminder.** Writable stages are never cached (constraint in
`cacheKeyFor`) — do not attempt to cache candidates. The saving here comes from
avoiding escalation, not from reuse.

**Verify.** Under `SUMO_E2E=1` on the seeded fixtures: assert the repro test is
written, confirmed failing, and that a candidate which passes it is the one kept.
Offline: assert the selection logic itself given synthetic candidate results.
Then run `sumo bench` with the flag on and off and put both `$/verified` numbers
in the BUGS.md entry — this brief is only justified if that column improves.

---

## B4 — Make escalation cheaper than "climb one rung" · **owns `src/escalate.ts`** · L

**Problem.** The ladder's only move on failure is to retry, then raise effort,
then step up a tier. It cannot tell a near-miss from a capability failure, and
it always pays the mid tier on the way to the large one.

**Evidence.** Three separate results, each pointing at a different missing move:

- A cheap, calibrated judge is trustworthy enough to gate escalation: cascaded
  selective evaluation held >80% human agreement at ~80% coverage with 7B-class
  judges, on data where the strong model alone could not reach 80%
  ([Trust or Escalate, ICLR 2025](https://openreview.net/forum?id=UHPnqSTBPO)).
- Having the strong model supply only a short *hint* and letting the cheap model
  execute cut cost 42–94% versus escalating the whole task, up to 2.8× cheaper
  than routing and cascading baselines
  ([arXiv:2601.22132](https://arxiv.org/abs/2601.22132)). This is what Claude
  Code's `opusplan` ships as practice.
- Fixed multi-stage chains are not the optimum: a pairwise cascade beat
  multi-stage chains on 4 of 5 benchmarks, because a chain pays every rung's
  cost on the way up ([arXiv:2605.06350](https://arxiv.org/abs/2605.06350)).

**Do.** Three moves, each independently flagged so bench can attribute the
saving:
1. **Judge before climbing.** On failure, a `small`-tier stage reads the failure
   table and the diff and answers a two-field schema: is this a near-miss the
   same rung can fix, or a capability failure? Feed its answer to `afterFailure`.
   It must be *advisory* — the ladder keeps its hard caps, and a judge that
   errors or produces nothing falls through to today's behaviour.
2. **Add a hint rung** between "raise effort" and "step up a tier": the larger
   model writes a short plan only (no edits, read-only), and the current tier
   implements it. This is a new `Rung`-adjacent concept, so give it a name in
   `types.ts` and keep the tier/effort vocabulary provider-neutral.
3. **Allow tier-skipping** when the judge says capability failure: `small` →
   `large` directly rather than through `mid`.

**Verify.** `test/escalate.test.ts` is table-driven and offline; extend it. The
existing assertion that effort rises before the model does (bug 16's regression
guard) must still hold for the no-judge path. Add a test that a judge failure
degrades to today's ladder exactly.

---

# Wave C — after A3 has numbers

## C1 — Prompt-cache-aware prompt layout · S–M

**Problem.** Provider prompt caching reads at 0.1× input price, keyed on an
exact prefix (tools → system → messages). sumo varies the prefix per stage: the
tool list changes with capabilities, and the `READ_ONLY` block sits inside the
system prompt. `a5b3f7a` measured the exact-result cache returning $0.09 of
$4.60 — so prompt volatility is already known to be expensive here, and the
provider-side cache is being left on the table for the same reason.

**Do.** Two candidate changes, both as flags, both measured before either is
kept: (a) hold the tool list constant across a task's stages, accepting that an
unused tool costs a few tokens in exchange for a warm prefix; (b) move the
read-only note out of the shared prefix so the system prompt is byte-identical
across stages. Note the tension with the existing "unlisted tools cost no tokens
and cannot be called" rule — (a) trades one saving for another and is *only*
justified if bench says so. If the numbers do not support it, record that and
close the item.

**Verify.** `cacheReadTokens` is already collected per stage in the ledger. That
is the metric: report it before and after. This brief is allowed to conclude
"no change" — that is a result, and it belongs in BUGS.md like any other.

## C2 — Mid-workflow `/resume`, then worktree isolation for `feature` · M then L

**Problem.** Both are on the README's own Next list. Resume comes first: a crash
or a gate rejection after root-cause discards paid stages, and bug 10 established
that rejection is precisely when someone wants to go again. `task.json` already
records the stage cursor, and `findFindings` now covers the survey — so most of
the plumbing exists and this is mostly wiring.

Worktree isolation follows, and retires a whole bug family: 3, 8, 12 and open 21
all came from `feature` sharing the operator's working tree. It is the larger
change and should not start until B2 has settled how the tree is managed during
retries — they touch the same question.

---

# Sequencing summary

| Wave | Briefs | Parallel? | Blocked by |
|---|---|---|---|
| A | A1 failures · A2 router · A3 bench · A4 skeleton | yes, no shared files | — |
| B | B1 fix parity → B2 clean tree → B3 repro+candidates → B4 escalation | strictly sequential | B1 needs A1 |
| C | C1 prompt cache · C2 resume/worktree | yes | C1 needs A3; C2 needs B2 |

**If only one brief is run, run B1** — it is the only item where a safety
property the README states as enforced is in fact only requested in a prompt.

**If only one more, run B3** — it carries the largest measured effect in the
literature and it makes the escalation ladder cheaper rather than adding to it.
