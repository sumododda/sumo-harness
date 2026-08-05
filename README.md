# sumo

[![check](https://github.com/sumododda/sumo-harness/actions/workflows/check.yml/badge.svg)](https://github.com/sumododda/sumo-harness/actions/workflows/check.yml)
[![npm](https://img.shields.io/npm/v/sumo-harness)](https://www.npmjs.com/package/sumo-harness)

A token-frugal coding harness. It drives a model provider directly, with a tiny
system prompt, harness-picked models, and workflow rules enforced in code rather
than requested in a prompt.

Stock agent harnesses spend 20–33k tokens before your first word, then spend
more letting the model grep around a codebase an index could answer instantly.
sumo inverts that: anything deterministic — tests, git, index lookups, deciding
which files matter — runs as plain code, and the model is called only where
judgement is actually needed.

The harness is developed by using it, and `TESTING.md` tracks which claims below
have been exercised against a live model rather than only unit-tested. Every
number here was measured, and the way to reproduce it is named.

---

## Install

Two requirements, and the second is the one people miss:

- **Node 24 or newer.** Development runs the TypeScript directly; an installed
  copy ships compiled JavaScript, because Node refuses to strip types under
  `node_modules`. The build is automatic — there is nothing to do about it.
- **A signed-in `claude` CLI**, or `ANTHROPIC_API_KEY` in the environment. sumo
  carries no credentials of its own; it borrows whichever it finds. Running
  `claude` once and logging in is enough.

```sh
npm install -g sumo-harness
```

Or straight from the repository, which builds itself on install:

```sh
npm install -g github:sumododda/sumo-harness
```

## First run in a project

```sh
cd your-project
sumo setup
```

```
sumo setup /Users/you/your-project

found
  languages   ts, py
  tests       npm test --silent
  ✓ TypeScript / JavaScript already installed
  · Python needs: npm i -g pyright

will do
  install 1 language server(s)
  build the code index (writes .codegraph/)
  build the lexical ranker index (writes .sumo/)
  enable the precision layer for the languages found
```

It works out what the project is written in, offers to install the language
servers for those languages, builds both indexes, finds the test command, and
turns the precision layer on for whatever is now available. `--dry-run` says
what it would do; `--yes` skips the question when provisioning a machine.

Installing is the one step that reaches outside the repository, so it is the one
step that asks — typing `setup` is consent for everything local, not for putting
binaries on your machine. On a non-interactive run it declines rather than
assuming. Languages come from `git ls-files`, so a vendored dependency full of
Python cannot convince a TypeScript project that it needs pyright.

Skipping setup entirely is fine. It costs a slower first task, never a broken
one.

## Using it

Run `sumo` in any repo to open the shell. Type normally — it picks the mode and
the model for each message.

```
› what does applyTax do?
  chat · small · question · by rules

› the receiptLine function duplicates logic, clean it up
  do · small · cleanup · by rules
  edit src/cart.js
  src/cart.js — receiptLine now reuses formatMoney
  $0.0259
```

Slash commands name the mode when you want to override that choice:

| | |
|---|---|
| `/chat` | ask about the code, change nothing |
| `/do` | small mechanical edits, one stage |
| `/fix` | evidence → root cause → your approval → fix → verify |
| `/feature` | explore → plan → your approval → tests → implement |
| `/plan` | explore → plan → offer to build it |
| `/research` | search the web and answer with sources — the only mode that leaves this machine |
| `/auto` | unpin, back to automatic routing (default) |
| `/again` *mode* | re-run the last message as another mode, when the routing got it wrong |

And the session commands:

| | |
|---|---|
| `/routing` | how turns have been routed, and which you corrected |
| `/models` [off\|on *id*] | every model, what your account can use, what you have turned off |
| `/index` `/lsp` | build the code index; turn the precision layer on |
| `/cost` `/cache` `/rung` | spend so far; reuse; the model tier |
| `/git` *args* | run git here without leaving the session |
| `/tests` [cmd] | show or set how to run this repo's tests |
| `/resume` | show the last task in this repo, and pick it up |
| `/profile` `/remember` | standing preferences |
| `/clear` `/help` `/exit` | |

**A command carrying a task applies to that task only.** `/fix the cart total is
wrong` runs one fix and leaves the routing where it was; a bare `/fix` pins the
mode until `/auto`. The distinction is worth having because the two read
identically and mean opposite things: pinning used to be unconditional, so a
`/feature` typed once quietly routed everything after it — including a plain bug
report three turns later, which got a plan, a branch and a test-first workflow it
never asked for. The mode line said `pinned · by you`, which was true, and read
as a description of that message rather than of a decision made much earlier.

One-shot use works from the shell too, for scripting:
`sumo do "..." --rung 0 --budget 0.05`.

### The gate

Staged workflows stop and wait before anything is written. Every gate prints its
own grammar, so there is nothing to memorise:

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
than inferred.

Corrections accumulate: a second note refines the first rather than replacing
it, or each round of argument trades one fix for another and nothing on screen
says so. Enter never destroys anything; it asks again.

The input line stays open while a stage runs, so a thought that arrives
mid-task is collected rather than lost, and folded into the next stage.

---

## What it decides for you

### Which mode a message needs

Three layers, cheapest first, each responsible only for what it claims.

**Rules answer most messages at zero cost** — "what does X do" is a question,
"fix the typo" is a mechanical edit, "there's a race condition" is a hard bug.
`test/intent.test.ts` records exactly what routes where.

**Then a local model, still free.** `model/embeddings.bin` is a 7.5 MB int8
lookup table: Model2Vec has one row of floats per vocabulary token and a sentence
is the mean of its tokens' rows — no attention, no layers, nothing to run — so
classifying is an array index and an average, about a tenth of a millisecond,
with no network and no provider call. It is data rather than code, which is why
there is no runtime to install and nothing compiled per architecture.

It answers only when one mode is clearly ahead of the rest, and says nothing
otherwise. That margin is the whole design: a free wrong answer is worth less
than a cheap right one, because a wrong route can hand an edit to a read-only
stage or send a question through five stages of a bug workflow. On the 64
held-out phrasings in `test/route.test.ts` it answers 28% of what the rules
decline and is wrong on none of them.

It also learns from your repository. Every `/again <mode>` records ground truth
in `.sumo/routing.jsonl` — the exact words, and the route they needed. The
shipped corpus is generic phrasing, identical for everyone, so it is out of
distribution for any one person's vocabulary by construction; each correction is
folded into the corrected label's centroid at a third of a shipped example's
weight. The margin is untouched: corrections change what the router believes,
never how sure it has to be before it answers.

Getting there took one instructive failure. The first version confidently routed
*"can you clarify what happens when the queue is empty"* to `fix` — a question
read as a bug report, because a static embedding carries topic and not speech
act, and "queue", "empty" and "times out" are failure-flavoured words whoever is
saying them. The fix was not a bigger model, which has the same blind spot; it
was adding questions *about* failure-flavoured behaviour to the corpus.

**Only genuinely ambiguous input pays** for a one-turn classification on the
cheapest model. `/routing` reports which layer decided, keeping `by local`
distinct from `by classifier` so a free decision can be told from a paid one.

### Which files it should read

**Which files a task is about is decided lexically, and locally.** BM25 over
identifiers split into their parts, plus each file's own path — no model, no
network, milliseconds per query. Splitting is what makes it work: `addNoteTag`
indexed only as itself can be found by someone who already knows to type it,
while indexed also as `add`, `note`, `tag` it is found by someone describing
what they want.

Measured against real commits, each message as the query and the files it
changed as the answer:

| | recall@10 | MRR |
|---|---|---|
| exact match, on 12,762 files | 50.0% | 0.528 |
| **+ split identifiers and paths** | **56.5%** | **0.578** |
| exact match, on 635 files | 55.1% | 0.445 |
| **+ split identifiers and paths** | **64.9%** | **0.543** |

The gain holds on the hard subset — commits whose message never names a file
that changed — so it is not messages quoting filenames back. A reference-graph
PageRank and a one-hop neighbour boost were both measured and both lost, the
latter collapsing to 0.5% at scale as hub files swamped everything. Structural
relevance is real, but it belongs where the index already applies it: around a
file that has already been chosen, not in the choosing.
`scripts/retrieval-eval.ts` reproduces all of it against any clone.

**Then the index answers what is in those files.** `sumo setup` (or `/index`)
builds a tree-sitter symbol and call graph in local SQLite. The harness queries
it *in this process* and pastes the relevant source straight into the prompt — no
tool schema, no round trip, no tokens spent deciding what to read. Measured on a
33-file TypeScript repo, asking how the escalation ladder picks a model:

| | turns | tool calls | cost |
|---|---|---|---|
| reading its way there | 7 | 6 | $0.0339 |
| from the index | **1** | **0** | **$0.0134** |

**The pack is three rings**, narrowing: bodies and call paths for the few files
a task is most likely to be about, signatures for the ring around them — every
function, class and exported constant, never a body — and bare paths beyond
that. Reading deeper is always available and never rationed; the rings decide
what arrives unasked for, not what may be had.

**`/lsp` adds a precision layer** — real language servers for exact definitions
and references. Search stays with the index, which is the one thing a language
server cannot do. A missing server degrades to the index rather than failing
anything, and the layer stays off until asked for, because spawning servers
costs startup time on every task.

### Which model to spend

**Tests decide, not a guess.** Predicting which model a task needs is
unreliable; a failing test is a fact. Work starts cheap, and when the harness
runs the suite and it fails, the ladder climbs: retry once at the same rung, then
raise the thinking effort, then — only once the cheaper moves are spent — step up
a model tier. After two escalations it stops and hands the problem back with the
failing output and a revert command, because at roughly a fivefold price spread,
three failed cheap attempts cost more than one clean expensive pass.

Stages are requested at a tier plus an effort, never a model name.

| Rung | Tier | Effort |
|---|---|---|
| 0 | small | — |
| 1 | mid | low |
| 2 | mid | high |
| 3 | large | medium |
| 4 | large | high |

**A tier is filled from every account you have, not from one.** Run `sumo` with
no `--provider` and the fleet is every provider this machine holds a credential
for. Models from all of them go into one pool per stage: what the account can
actually reach is checked first, then what can do this particular stage, then
dominance — a model beaten on both price and recency by something on the *other*
provider is dropped just as readily as by one on its own — and only what
survives is ranked, by your tier policy, then aptitude, then price.

Naming a provider still means exactly that provider. Routing around one that was
asked for by name would turn a clear failure into a silent substitution, which is
the harder of the two to debug.

**The advertised context window is not one of those axes**, deliberately. It is
the one number in the catalogue that looks like a capability and is not: a window
says what a provider will *accept*, not what a model can attend to, and the two
come apart badly — RULER finds only half of the models claiming 32K still hold up
at 32K, and NoLiMa finds eleven of thirteen claiming 128K fall below half their
own short-context score by then. Nor is there a better constant to put in its
place. So it stays in the catalogue as data, read as a cap by the budget below,
and orders nothing.

**`sumo models` shows the whole picture, and lets you veto part of it.**

```
github-copilot  17 models offered to this account
  small
    ● gpt-5.6-luna         $1.2/M  schema effort:… · routed here
    ✗ gpt-5.4-nano        $1.25/M  schema · not offered to this account
    ○ gpt-5-mini              $2/M  schema effort:… · beaten at this tier
    ⊘ claude-haiku-4.5        $5/M  · turned off by you
```

Four states, because four different things decide whether a model runs and they
are worth telling apart. `✗` is the account's answer — an organisation policy or
a plan that does not carry it. `○` is routing's: available, and still never
chosen, because something else at the same tier beats it on every axis. That is
the one people ask about, and it used to be unanswerable without reading the
code. `⊘` is yours.

**`sumo models` opens an editor**; `/models` opens the same one mid-session.
Arrow keys move, space toggles, enter saves, esc abandons. Nothing reaches disk
until you save, which is the point rather than a detail: toggling something to
see what it does costs nothing, where a command that takes effect immediately
makes every keystroke a commitment. The `beaten at this tier` markers move as
you go, so turning off whatever is winning a tier shows you what takes over
before you commit to it — and the save says what each tier routes at now.

`sumo models --list` prints the table instead, and a pipe gets the table
automatically, since arrow keys need a terminal to come from.

For one model there is still a one-liner: `sumo models off gpt-4.1`,
`sumo models on gpt-4.1`, or the same after `/models`. A bare id switches the model on every provider
carrying it — the same weights are often reachable through two accounts, and
turning it off on one while it quietly keeps running on the other is the least
useful thing the command could do; `provider/id` names one exactly. The choices
live in `~/.sumo/models-disabled.json`, outside any repository, because not
wanting to spend Opus tokens is a fact about a wallet rather than a checkout.
They survive a probe refresh: an organisation re-enabling a model must not
silently undo your decision to stop paying for it.

The one thing not pooled is a schema. A stage that must answer in a schema goes
to a provider that can *guarantee* one; a provider that can only arrange it by
convention — Copilot, which hands the model a tool carrying the schema and tells
it to call it — is used for those stages only when nothing better is available.
That is worth having: it is the difference between a Copilot-only fleet running
`feature`, `fix` and `plan`, and refusing all three.

The preference is judged per stage, not per fleet. A provider that guarantees a
schema but has no model matching the tier and effort a stage asked for offers
nothing to *that* stage, and the fallback applies — otherwise a stage with no
route would be refused while a provider that could have answered sat unconsidered.

---

## What it refuses to do

**The model never gets a shell.** Tests, git, and commands are run by the
harness. This is both the largest token saving and the simplest way to make a
stage genuinely read-only. It cuts both ways, so shell work is recognised before
any model sees it — "check out the latest branch" gets an instant, free answer
pointing at `/git checkout …` rather than paying a model to explain it has no
terminal.

**Gates are code, not requests.** A read-only stage doesn't have `Edit` and
`Write` in its tool set at all, and a `PreToolUse` hook refuses them anyway, with
a reason the model can act on. `test/enforcement.test.ts` proves it against the
live provider: a model explicitly ordered to create a file cannot.

**Path confinement follows symlinks**, judging where a file really is rather than
how it is spelled. A link inside the repository pointing out of it is refused,
and a working directory reached through a link still contains its own files.
Comparing the strings gets both of those wrong, in opposite directions.

**Bug work gathers evidence before it may write.** `fix` runs evidence gathering
that *cannot* edit, then a repro command the harness runs — after showing it to
you, with a warning if it looks destructive — then a root cause where every claim
must cite evidence, and only then, once you approve, a stage allowed to write.
The ordering is enforced by which stage holds write access.

**Feature work is test-first, on its own branch.**

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

It cuts a `sumo/…` branch, refusing on a dirty tree rather than stashing your
work behind your back. It explores read-only, plans, waits for you, then writes
tests and **proves they fail** — a green suite here is treated as an error, since
tests that pass before the code exists prove nothing. Only then does it
implement, with those test files locked by the permission gate, so "make the
tests pass" cannot be satisfied by weakening a test.

That last line matters: the harness records which tests were already broken
before the task began, tells the implement stage to leave them alone, and
distinguishes "you broke something" from "it was already broken".

Iterating stays on one branch. A branch named for this task is joined; a branch
belonging to *different* work stops the task rather than landing new commits
beside unrelated ones — the name is derived from the task, so the two cases are
distinguishable.

**One mode is allowed off the machine.** Everything else answers from the
repository, which is what makes an answer checkable — you can go and read the
same code. `/research` cannot, so it is never routed to automatically, only
pinned, and its prompt requires a URL on every claim: an uncited sentence from
that stage is indistinguishable from one the model simply remembered, which is
the failure it exists to avoid. No key and no service of its own — search runs
on the provider, under whatever credentials sumo already found.

---

## Where the tokens go

**Nothing identical is paid for twice.** Read-only stages, index lookups and the
routing classifier are cached against a fingerprint of the repository's actual
content — `HEAD` plus a hash of every file `git status` reports as dirty. On a
hit the entire call disappears, input and output both. Writable stages are never
cached, because their real product is a change on disk rather than the text they
return, and neither are git-capable ones, since `checkout` and `stash` move the
tree. `/cache` shows the hit rate; `--no-cache` turns it off.

The survey stages are given the index pack but not the conversation, precisely
so this can work: conversation grows every turn, and a prompt that changes every
turn can never match a cache key. A retry of the same task in an unchanged
repository reuses the survey rather than paying for it twice.

**Stages answer in a schema.** `evidence`, `root-cause`, `explore` and `plan`
return validated JSON rather than prose with headings. That deleted the regex
that used to recover a shell command out of a markdown section — the repro
command is a field now — and it means a gate renders a structured artifact
instead of hoping you caught the prose as it streamed past.

**What a stage answers is written twice.** Artifacts are TOON-encoded when they
feed the next stage — field names paid once per table rather than once per row —
and laid out as titled blocks when shown to you. Those are opposite goals, so one
rendering cannot serve both. Both forms are produced together, named for their
reader, so the compressed one cannot be shown by accident and — the expensive
direction — the readable one cannot be sent to a model.

The saving tracks the shape of the data rather than being a constant: about 50%
fewer characters on the ledger's short numeric rows, about 38% on failure rows
carrying a sentence each, and nothing at all on a single row, where the header
costs what it saves. `test/encoding.test.ts` checks it in *tokens* under the real
tokenizer — characters are not a reliable proxy for what bills.

**Failing tests arrive as a table.** A retry used to carry six thousand
characters of log; it now carries the assertions, parsed from node:test, pytest
and go test, with a column marking which failures are new since the last attempt.
Anything the parser does not recognise falls back to the raw output, because a
normaliser that quietly drops the one failure that mattered would be worse than
a verbose prompt.

**A long session costs no more per turn than a short one.** The transcript lives
in this process, and only a bounded recent slice is ever sent: the last handful
of turns, each abridged from the *middle* rather than the end, and the most
recent progress notes. Keeping both ends of a turn matters more than it sounds —
a stage is told to answer with no preamble and to close with one line per file
changed, so head-only truncation threw away the part that says what was done, and
threw it away from the position a model reads best.

**A stage's prompt has a ceiling, and the ceiling is a number of tokens rather
than a share of the window.** That is the counter-intuitive half and the half
carrying the evidence: FLenQA holds a task fixed and pads its input, and mean
accuracy falls 0.92 → 0.68 by three thousand tokens, with the decline already
visible around five hundred. That is a fact about attention, not about what a
provider will accept — so a budget written as a fraction of an advertised window
would hand a million-token model two hundred thousand tokens of prompt and call
it headroom.

The ceiling is set by the kind of work a stage does — the same axis model
selection already reasons about, so which model runs a stage and how much it may
be told cannot drift apart. Assembly happens *after* routing, because that is the
first moment the budget is knowable: a stage that lands on a small model would
otherwise get a prompt sized for a large one, which is where the surplus hurts
most.

Going over drops whole units, never part of one — a half-rendered table is worse
than an absent one, because the model reads it as complete. The session's facts
go first, then the recent turns, then the tail of the index pack, which is
already ranked so its tail is what it ranked lowest. The task and its
instructions are never dropped: if they alone exceed the budget the stage runs
over rather than being asked half a question. Every drop is printed, because a
prompt quietly shortened is indistinguishable from one that was never that long.

The ceilings are starting points, generous enough that ordinary work sits well
under them. They are a guard rail against a session or an index pack growing
without bound, not a saving, and `sumo bench` is what will tune them.

---

## Measuring it

Every optimisation above is a claim, and claims about token savings do not
compose — they overlap, so multiplying their advertised ratios produces a number
nobody can reproduce. Each one is a flag in `src/features.ts`, and `sumo bench`
replays 18 seeded bugs across three language fixtures with different sets of
them switched on:

```sh
SUMO_E2E=1 npm run sumo -- bench --configs baseline,indexed,cached,full --repeat 3
```

```
config    verified     in    out  retries    total  $/verified
baseline       3/3  41200   2100        1  $0.1236     $0.0412
full           3/3   5400    410        0  $0.0213     $0.0071
```

The last column is the one that decides anything. A configuration that halves
the tokens and fails one task in three costs more than the baseline, not less,
and only the denominator shows it.

A single run proves nothing about a stochastic model, so `--repeat N` runs every
(config, task) pair N times and reports the mean with its min–max spread; two
configurations whose ranges overlap are called *not distinguishable* rather than
left for the reader to eyeball. Each task also appends to `.sumo/metrics.jsonl`,
and `sumo bench --from-metrics` aggregates that offline, with no provider calls —
so the same discipline applies to real sessions, not only fixtures.

Retrieval has its own harness, because its ground truth is free:
`scripts/retrieval-eval.ts` uses a commit message as the query and the files that
commit changed as the answer, against any clone.

One flag ships off, and it is the exception that explains the rule. The gate can
throttle text searching once an index is present, on the theory that broad
searching is waste when the relevant code has already been selected. Every other
flag changes what a stage is *given*, so a wrong call costs tokens; that one
changes what a stage may *find out*, so a wrong call costs an answer — and a
stage denied a search does not say it is stuck, it proceeds with less.
`sumo bench --configs gated,throttled` prices it, and it stays off until that
says it pays.

---

## Layout

```
src/
  cli.ts            commands; no arguments opens the shell
  setup.ts          `sumo setup`: install, index, configure, once per project
  repl.ts           the interactive shell and its slash commands
  intent.ts         free routing rules, then a paid classifier as fallback
  routing-log.ts    what each turn was routed to, and what you corrected
  conversation.ts   harness-owned memory, bounded so turns stay cheap
  input.ts          the one line reader — see its header for why sharing matters
  steer.ts          text typed while a stage runs, folded into the next one
  statusbar.ts      the live activity block, and holding output while you type
  progress.ts       which leg of a workflow is running
  gate.ts           approval pauses: y / n / type what to change
  gate-tools.ts     the veto: read-only, path confinement, locked files
  git-tool.ts       the screened git tool a stage may be handed
  runner.ts         tests, git, and repro commands, run by the harness
  stage.ts          one unit of model work: permissions, budget, accounting
  escalate.ts       the ladder: retry, raise effort, step up, give up
  ledger.ts         per-stage cost, and the per-task metrics line
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
  ui.ts             terminal rendering, and artifacts laid out for a person
  route/            local routing: tokenizer.ts, embed.ts, corpus.ts, local.ts
  context/          the code-context seam: lexical.ts, codegraph.ts, lsp.ts
                    budget.ts — how much prompt a stage may be built from
  engine/           the provider seam: claude.ts, copilot.ts, index.ts, types.ts
                    fleet.ts — which provider and model runs a stage
                    catalog.ts, availability.ts — what exists, what you can reach
                    aptitude.ts — the one hand-written judgement, kept in one file
  workflows/        do.ts, plan.ts, fix.ts, feature.ts
```

**Providers are swappable.** Everything above `src/engine/` speaks the `Engine`
interface. Adding another means writing `src/engine/yours.ts` and one line in
`src/engine/index.ts` — no change to workflows or prompts. `src/engine/claude.ts`
is the only file permitted to name a `claude-*` model.

---

## Working on sumo

```sh
git clone https://github.com/sumododda/sumo-harness && cd sumo-harness
npm install && npm link
```

```sh
npm run check         # lint, typecheck, dead code, tests — the gate
npm test              # offline: gates, cache, fingerprints, parsers, schemas
SUMO_E2E=1 npm test   # adds live enforcement probes (a few cents)
npm run build         # emit dist/, the form a published copy ships
```

Editing after `npm link` needs no build: `bin/sumo.js` runs `src/` when it is
there and `dist/` when it is not, and `src/` is absent from the published
package — so the check is the question rather than a setting to keep in sync.
`npm run build` is wired to `prepare`, so it also runs on `npm pack`, on
`npm publish`, and when someone installs straight from the repository.

The token-count check in `test/encoding.test.ts` skips without provider
credentials and runs when an API key is present.

### Releasing

```sh
npm version minor      # or patch / major — writes package.json and tags
git push --follow-tags
```

The `v*` tag triggers `publish.yml`, which re-runs the whole gate, refuses if
the tag and `package.json` disagree, **installs the packed tarball and runs the
binary out of it**, and only then publishes. That last step is not ceremony:
shipping raw TypeScript once passed every test and was still broken on install,
because Node refuses to strip types under `node_modules`. Testing the repository
is not testing the artifact.

Authentication is npm [trusted publishing](https://docs.npmjs.com/trusted-publishers/)
over OIDC, so there is no `NPM_TOKEN` anywhere — GitHub mints a short-lived
credential scoped to this repository and this workflow file, and provenance
attestations follow automatically.

---

## Next

None of these are load-bearing: worktree isolation so `feature` never touches
your working tree, and tuning the context ceilings against the fixtures rather
than leaving them at the starting points they are today.

By design: nothing indexes, installs, or spawns a server behind your back.
`sumo setup` is the one command that does any of it, and it asks first.
