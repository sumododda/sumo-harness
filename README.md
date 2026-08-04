# sumo

[![check](https://github.com/sumododda/sumo-harness/actions/workflows/check.yml/badge.svg)](https://github.com/sumododda/sumo-harness/actions/workflows/check.yml)
[![npm](https://img.shields.io/npm/v/sumo-harness)](https://www.npmjs.com/package/sumo-harness)

A token-frugal coding harness. It drives a model provider directly, with a tiny
system prompt, harness-picked models, and workflow rules enforced in code rather
than requested in a prompt.

Status: **complete through M6, plus a measurement pass** — interactive shell,
automatic routing, permission gates, cost ledger, deterministic test running,
three staged workflows (`plan`, evidence-driven `fix`, test-first `feature`), the
code-context index with an optional LSP layer, and a test-driven escalation
ladder. On top of that: an exact result cache, schema-validated stage outputs,
normalised failure tables, gated retrieval, `/research` for questions the
repository cannot answer, and `sumo bench` to check that any of it actually
helps. TypeScript, Python, and Go are each covered by a fixture with the same
seeded bug.

The harness is developed by using it: `BUGS.md` records every defect found that
way, with what it cost in a real session, and `TESTING.md` tracks which claims
here have been exercised against a live model rather than only unit-tested.

## Why

Stock agent harnesses spend 20–33k tokens before your first word, then spend
more letting the model grep around a codebase an index could answer instantly.
sumo inverts that: anything deterministic (tests, git, index lookups) runs as
plain code, and the model is called only where judgement is actually needed.

## Install

Two requirements, and the second is the one people miss:

- **Node 24 or newer.** Development runs the TypeScript directly, with no build
  step, because Node strips the types itself. An *installed* copy ships compiled
  JavaScript instead — Node refuses to strip types for anything under
  `node_modules`, which is exactly where a global install lands. The build runs
  automatically on install; there is nothing to do about it.
- **A signed-in `claude` CLI**, or `ANTHROPIC_API_KEY` in the environment. sumo
  does not carry credentials of its own; it borrows whichever of those it finds.
  Running `claude` once and logging in is enough.

Then:

```sh
npm install -g sumo-harness
sumo            # in any repo
```

Or straight from the repository, which builds itself on install:

```sh
npm install -g github:sumododda/sumo-harness
```

Updating is the same command again. Append `#v0.1.0` to the git form to pin.

Working on sumo itself is a link rather than an install, so edits are live in
the `sumo` command with nothing to reinstall:

```sh
git clone https://github.com/sumododda/sumo-harness && cd sumo-harness
npm install && npm link
```

For a machine with no network access to the repo, `npm pack` produces a tarball
that installs the same way:

```sh
npm pack                                 # on this machine → sumo-harness-0.1.0.tgz
npm install -g ./sumo-harness-0.1.0.tgz  # on the other one
```

## Usage

Run `sumo` in any repo to open the shell. Type normally — it picks the mode and
the model for each message.

```
› what does applyTax do?
  chat · small · question

› the receiptLine function duplicates logic, clean it up
  do · mid/low · cleanup
  edit src/cart.js
  src/cart.js — receiptLine now reuses formatMoney
  $0.0259
```

Slash commands pin a mode when you want to override that choice:

| | |
|---|---|
| `/chat` | ask about the code, change nothing |
| `/do` | small mechanical edits, one stage |
| `/fix` | evidence → root cause → your approval → fix → verify |
| `/feature` | explore → plan → your approval → tests → implement |
| `/plan` | explore → plan → offer to build it |
| `/research` | search the web and answer with sources — the only mode that leaves this machine |
| `/auto` | back to automatic routing (default) |
| `/again <mode>` | re-run the last message as another mode, when the routing got it wrong |
| `/routing` | how turns have been routed, and which ones you corrected |
| `/index` | build the code index for this repo |
| `/lsp` | precise references via language servers (off by default) |
| `/git <args>` | run git here without leaving the session |
| `/tests [cmd]` | show or set how to run this repo's tests |
| `/resume` | show the last task in this repo, and pick it up |
| `/cache` | how much has been reused; `/cache clear` empties it |
| `/cost` `/rung` `/clear` `/profile` `/remember` | session control |

`/fix the cart total is wrong` pins the mode and runs it in one line.

One-shot use works too, for scripting: `sumo do "..." --rung 0 --budget 0.05`.

## Design

**The model never gets a shell.** Tests, git, and commands are run by the
harness. This is both the largest token saving and the simplest way to make a
stage genuinely read-only.

That cuts both ways, so shell work is recognised before any model sees it —
"check out the latest branch" gets an instant, free answer pointing at
`/git checkout …` rather than paying a model to explain it has no terminal.

**Gates are code.** A read-only stage doesn't have `Edit` and `Write` in its
tool set at all, and a `PreToolUse` hook refuses them anyway, with a reason the
model can act on. `test/enforcement.test.ts` proves it against the live
provider: a model explicitly ordered to create a file cannot.

**Bug work is gated.** Saying something is broken runs the `fix` workflow:
evidence gathering that *cannot* edit, then a repro command the harness runs
(after showing it to you, with a warning if it looks unusual), then a root cause
where every claim must cite evidence — and only then, once you approve, a stage
that is allowed to write. The ordering is enforced by which stage holds write
access, not by asking the model to behave.

```
› applyDiscount returns a negative number for a whole-number percentage
  fix · mid/low · describes something broken
  Run this to reproduce?  … approve? y
  Approve this root cause and fix?  … approve? y
  edit src/cart.js
  running npm test --silent
  tests pass
```

Every gate prints its own grammar, so there is nothing to memorise:

```
  y go ahead    n stop    …? ask about it    …  say what to change
›
```

**A question mark is the whole rule.** End your answer with `?` and it is
answered without touching the proposal and without spending a revision — asking
to understand something should never cost you the work. Anything else is a
change to make.

That is deliberately less clever than reading your phrasing. An earlier version
guessed from sentence shape and got about a third of real answers wrong, always
the same way: "do it in one file", "have a look at rank.ts first" and "can you
use a Map instead" were all answered as questions while the proposal stayed
exactly as it was. Being told what to change and having nothing change is the
worst thing a gate can do, so the rule is visible and yours to control rather
than inferred. `?` on its own explains the prompt.

Enter never destroys anything — it asks again. It used to reject, which meant a
stray keypress threw away the whole task.

**Feature work is test-first, on its own branch.** Asking for something new runs
`feature`: it cuts a `sumo/…` branch (refusing on a dirty tree rather than
stashing your work behind your back), explores read-only, plans, waits for you,
then writes tests and **proves they fail** — a green suite here is treated as an
error, since tests that pass before the code exists prove nothing. Only then
does it implement, with those test files locked by the permission gate so
"make the tests pass" cannot be satisfied by weakening a test.

```
› add a roundToNearestNickel function that rounds cents to the nearest 5
  feature · mid/low · new capability
  branch sumo/add-roundtonearestnickel-function-rounds (from main)
  note: the suite is already failing before this task starts
  Approve this plan?  … approve? y
  edit test/cart.test.js
  running npm test --silent — expecting failures
  failing as expected
  edit src/cart.js
  running npm test --silent
  your tests pass — the suite is still red from failures that pre-date this task
```

That last line matters: the harness records which tests were already broken
before the task began, tells the implement stage to leave them alone, and
distinguishes "you broke something" from "it was already broken".

Iterating on a feature stays on one branch. Already being on a `sumo/…` branch
means the next task continues there rather than cutting a second one off the
first — three turns of refinement used to leave three branches pointing at the
same commit, each forked from the last.

**Context comes from an index, not from reading around.** `/index` builds a
tree-sitter symbol and call graph in local SQLite. The harness then queries it
*in this process* and pastes the relevant source straight into the prompt — no
tool schema, no round trip, no tokens spent deciding what to read. Measured on a
33-file, 4k-line TypeScript repo, asking how the escalation ladder picks a model:

| | turns | tool calls | cost |
|---|---|---|---|
| reading its way there | 7 | 6 | $0.0339 |
| from the index | **1** | **0** | **$0.0134** |

60% cheaper, and the indexed answer was the more accurate of the two. The gain
grows with the repo: on a two-file sandbox it is only ~20%, because there was
never much to search.

The pack also carries a skeleton of each file it drew from: every function,
method, class and exported constant by signature, never a body. That closes a
gap where the pack *added* to the reading instead of displacing it — `explore`
would receive the relevant code and then `Read` the whole file it came from
anyway. Signatures are enough to see what exists, and the stage is told plainly
that naming a symbol is how to get its body.

With an index present the gate also throttles broad searching after a couple of
calls, pointing the model back at the context it was already given.

`/lsp` adds a precision layer on top — real language servers for exact
definitions and references. Search always stays with the index, which is the one
thing a language server cannot do.

Nothing is installed for you. Language servers are per-language toolchains, and
putting them on your machine uninvited is a bigger surprise than telling you what
to run — so `/lsp` reports what it found and how to get the rest:

```
› /lsp
  ✓ TypeScript / JavaScript
  · Python — not installed: npm i -g pyright
  · Go — not installed: go install golang.org/x/tools/gopls@latest
```

Install only the ones you want, whenever you want. A missing server degrades to
the index rather than failing anything, and the layer stays off until asked for
because spawning servers costs startup time on every task.

**Routing is free when it can be.** Rules classify most messages at zero cost —
"what does X do" is a question, "fix the typo" is a mechanical edit, "there's a
race condition" is a hard bug. Only genuinely ambiguous input pays for a
one-turn classification on the cheapest model. See `test/intent.test.ts` for
exactly what routes where.

**Some routing is free without being a rule.** Between the rules and the paid
classifier sits a local model: `model/embeddings.bin`, a 7.5 MB int8 lookup
table. Model2Vec has one row of floats per vocabulary token and a sentence is
the mean of its tokens' rows — no attention, no layers, nothing to run — so
classifying is an array index and an average, about a tenth of a millisecond,
with no network and no provider call. It is data rather than code, which is why
there is no runtime to install and nothing compiled per architecture.

It answers only when one mode is clearly ahead of the others, and says nothing
otherwise. That gate is the whole design: a free wrong answer is worth less than
a cheap right one, because a wrong route can hand an edit to a read-only stage
or send a question through five stages of a bug workflow. On the 64 held-out
phrasings in `test/route.test.ts` it answers 28% of what the rules decline and
is wrong on none of them; the rest still cost the classification they always did.

It also learns from this repository. Every `/again <mode>` records ground truth
in `.sumo/routing.jsonl` — the exact words, and the route they needed — and that
went unread. The shipped corpus is generic phrasing, identical for everyone, so
it is out of distribution for any one person's vocabulary by construction. Each
correction is now folded into the corrected label's centroid at a third of a
shipped example's weight. The margin is untouched: corrections change what the
router believes, never how sure it has to be before it answers.

Getting there took one instructive failure. The first version confidently routed
*"can you clarify what happens when the queue is empty"* to `fix` — a question
read as a bug report, because a static embedding carries topic and not speech
act, and "queue", "empty" and "times out" are failure-flavoured words whoever is
saying them. The fix was not a bigger model, which has the same blind spot; it
was adding questions *about* failure-flavoured behaviour to the corpus, so the
`chat` centroid covers them. `/routing` reports it as `by local`, kept distinct
from `by classifier` so the log can tell a free decision from a paid one.

**Tests decide the model, not a guess.** Predicting which model a task needs is
unreliable; a failing test is a fact. So work starts cheap, and when the harness
runs the suite and it fails, the ladder climbs: retry once at the same rung, then
raise the thinking effort, then — only once the cheaper moves are spent — step up
a model tier. After two escalations it stops and hands the problem back with the
failing output and a revert command, because at roughly a fivefold price spread,
three failed cheap attempts cost more than one clean expensive pass.

```
  running npm test --silent
  tests still failing
  retrying with the failing output in hand
  …
  thinking harder (low → high)
  …
  stepping up to large
```

Stages are requested at a tier (`small`/`mid`/`large`) plus an effort, never a
model name.

| Rung | Tier | Effort |
|---|---|---|
| 0 | small | — |
| 1 | mid | low |
| 2 | mid | high |
| 3 | large | medium |
| 4 | large | high |

**One mode is allowed off the machine.** Everything else answers from the
repository, which is what makes an answer checkable — you can go and read the
same code. `/research` cannot: it is granted the provider's own web search and
fetch, for the questions a repository genuinely does not contain, like what
changed in a library's last major version.

```
› /research what changed in zod 4 that breaks zod 3 code?
  research · small · pinned · by you
  websearch
  webfetch
  1. Defaults now apply inside optional fields — z.string().default("tuna")
     .optional() returned {} in Zod 3, returns { a: "tuna" } in Zod 4
  2. Error customisation overhauled — message / invalid_type_error /
     required_error / errorMap replaced by a unified `error`
  Sources: zod.dev/v4/changelog · zod.dev/v4
  $0.0589
```

It is never routed to automatically, only pinned, because a stage that reaches
the network produces an answer nobody can re-derive from the repository — worth
having, and worth marking. The prompt requires a URL on every claim for the same
reason: an uncited sentence from this stage is indistinguishable from one the
model simply remembered, which is the failure it exists to avoid. It keeps `read`
and `search` too, since a question about a library is usually also a question
about how this repository already uses it.

No key and no service of its own: search runs on the provider, under whatever
credentials sumo already found.

**What a stage answers is written twice.** Stage artifacts are encoded as TOON
when they feed the next stage — field names paid once per table rather than once
per row — and laid out as titled blocks when they are shown to you. Those are
opposite goals, so one rendering cannot serve both: a plan reached the screen as
`steps[2]{file,action,detail}:` and comma-joined rows for exactly as long as it
took to notice. Both forms are produced together, named for their reader, so the
compressed one cannot be shown by accident and — the expensive direction — the
readable one cannot be sent to a model.

**Providers are swappable.** Everything above `src/engine/` speaks the `Engine`
interface. Adding GitHub Copilot models means writing `src/engine/copilot.ts`
and one line in `src/engine/index.ts` — no change to workflows or prompts.
`src/engine/claude.ts` is the only file permitted to name a `claude-*` model.

**Nothing identical is paid for twice.** Read-only stages, index lookups and the
routing classifier are cached against a fingerprint of the repository's actual
content — `HEAD` plus a hash of every file `git status` reports as dirty. On a
hit the entire call disappears, input and output both. Writable stages are never
cached, because their real product is a change on disk rather than the text they
return, and neither are git-capable ones, since `checkout` and `stash` move the
tree. Without a fingerprint — outside git, or with a tree too dirty to hash
cheaply — nothing is reused at all. `/cache` shows the hit rate; `--no-cache`
turns it off.

**Stages answer in a schema.** `evidence`, `root-cause`, `explore` and `plan`
return validated JSON rather than prose with headings. That deleted the regex
that used to recover a shell command out of a markdown section — the repro
command is a field now — and it means a gate renders a structured artifact
instead of hoping you caught the prose as it streamed past.

**Failing tests arrive as a table.** A retry used to carry six thousand
characters of log; it now carries the assertions, parsed from node:test, pytest
and go test, with a column marking which failures are new since the last attempt.
Anything the parser does not recognise falls back to the raw output, because a
normaliser that quietly drops the one failure that mattered would be worse than
a verbose prompt.

**Structured payloads are TOON-encoded** — the failure tables above, the
observation and step tables inside stage artifacts, and the persisted ledger.
The saving is on repeated field names, so it tracks the shape of the data rather
than being a constant: about 50% fewer characters on the ledger's short numeric
rows, about 38% on failure rows carrying a sentence each, and nothing at all on
a single row, where the header costs what it saves. `test/encoding.test.ts`
checks it in *tokens* under the real tokenizer, not in characters — characters
are not a reliable proxy for what bills.

## Layout

```
src/
  cli.ts            commands; no arguments opens the shell
  repl.ts           the interactive shell and its slash commands
  intent.ts         free routing rules, then a paid classifier as fallback
  routing-log.ts    what each turn was routed to, and what you corrected
  conversation.ts   harness-owned memory, bounded so turns stay cheap
  input.ts          the one line reader — see its header for why sharing matters
  steer.ts          text typed while a stage runs, folded into the next one
  statusbar.ts      the live activity block, and holding output while you type
  progress.ts       which leg of a workflow is running
  gate.ts           approval pauses: y / n / type what to change
  gate-tools.ts     the veto: read-only, path confinement, locked files, edit format
  git-tool.ts       the screened git tool a stage may be handed
  runner.ts         tests, git, and repro commands, run by the harness
  stage.ts          one unit of model work: permissions, budget, accounting
  escalate.ts       the ladder: retry, raise effort, step up, give up
  ledger.ts         per-stage cost, TOON, and the per-task metrics line
  hash.ts           content addressing: what makes reuse safe
  cache.ts          the exact result cache
  features.ts       the optimisations, switchable so they can be measured
  retrieval.ts      whether to ask the index at all
  failures.ts       test output reduced to records
  schemas.ts        the shapes stages answer in, encoded for the next stage
  bench.ts          replays the fixtures with features on and off
  profile.ts        ~/.sumo/profile.md — standing preferences
  prompts.ts        every prompt, in one place
  state.ts          .sumo/ task artifacts, independent of provider sessions
  types.ts          provider-neutral vocabulary
  ui.ts             terminal rendering, and the same artifacts laid out for a person
  route/            local routing: tokenizer.ts, embed.ts, corpus.ts, local.ts
  context/          the code-context seam: codegraph.ts, lsp.ts, index.ts, types.ts
  engine/           the provider seam: claude.ts, index.ts, types.ts
  workflows/        do.ts, plan.ts, fix.ts, feature.ts
```

A long session costs no more per turn than a short one: the transcript lives in
this process, and only a bounded recent slice is ever sent.

## Measuring it

Every optimisation above is a claim, and claims about token savings do not
compose — they overlap, so multiplying their advertised ratios produces a number
nobody can reproduce. Each one is therefore a flag in `src/features.ts`, and
`sumo bench` replays 18 seeded bugs across the three fixtures (six per
language, mixed difficulty) with different sets of them switched on:

```sh
SUMO_E2E=1 npm run sumo -- bench --configs baseline,indexed,cached,full
```

```
config    verified     in    out  retries    total  $/verified
baseline       3/3  41200   2100        1  $0.1236     $0.0412
full           3/3   5400    410        0  $0.0213     $0.0071
```

`--repeat N` runs each pair N times and reports the spread as well as the mean,
because a decision taken from a single run of three fixtures is not a
measurement. Configurations whose ranges overlap are called *not
distinguishable* rather than left to be eyeballed. And `sumo bench
--from-metrics` aggregates `.sumo/metrics.jsonl` — what real sessions actually
cost — offline, with no provider calls at all.

The last column is the one that decides anything. A configuration that halves
the tokens and fails one task in three costs more than the baseline, not less,
and only the denominator shows it.

A single run of each task proves nothing about a stochastic model, so
`--repeat N` runs every (config, task) pair N times and reports the mean with
its min–max spread; two configurations whose $/verified ranges overlap are
called out as *not distinguishable* rather than left for the reader to
eyeball. Each task also appends a line to `.sumo/metrics.jsonl`, and
`sumo bench --from-metrics` aggregates it — no provider calls, offline — so
the same $/verified discipline applies to real sessions, not only fixtures.

## Releasing

`npm run check` runs on every push and pull request. Publishing is a tag:

```sh
npm version patch      # or minor / major — writes package.json and tags
git push --follow-tags
```

The `v*` tag triggers `publish.yml`, which re-runs the whole gate, refuses if
the tag and `package.json` disagree, installs the packed tarball and runs the
binary out of it, and only then publishes.

Authentication is npm [trusted publishing](https://docs.npmjs.com/trusted-publishers/)
over OIDC, so there is no `NPM_TOKEN` anywhere — GitHub mints a short-lived
credential scoped to this repository and this workflow file. Provenance
attestations are published automatically as a result.

## Working on sumo

```sh
npm run check         # lint, typecheck, dead code, tests — the gate
npm run build         # emit dist/, the form a published copy ships
```

`npm run build` is wired to `prepare`, so it also runs on `npm pack`, on
`npm publish`, and when someone installs straight from the repository. Editing
after `npm link` needs no build at all: the link resolves to the working tree,
where Node reads the TypeScript directly.

## Tests

```sh
npm test              # offline: gates, cache, fingerprints, parsers, schemas
SUMO_E2E=1 npm test   # adds live enforcement probes (a few cents)
npm run typecheck
```

The token-count check in `test/encoding.test.ts` skips without provider
credentials and runs when an API key is present.

## Next

Natural next steps, none of them load-bearing: a second provider behind the
`Engine` seam (GitHub Copilot models were the motivating case), worktree
isolation so `feature` never touches your working tree, and richer `/resume`
that restarts mid-workflow rather than from the top.

By design: `/index` must be run explicitly per repo, and the LSP layer stays off
until asked for — nothing indexes or spawns servers behind your back.
