# sumo — found by using it

Kept in the order they were found. Each entry says what happened, what it cost,
and how it was fixed, because "we hit this in a real session" is the only
evidence that separates a bug worth fixing from a hypothetical.

---

## Stage 0 — found while building sumo-news

### 1. A polite request was read as a question · FIXED

`"can you please chaneg the license file to apache-2.0 please"` matched the
question rule on its opening `can` and routed to `chat`, which is read-only. The
harness answered a request to change a file, changed nothing, and billed for it.
English wraps almost every instruction this way, so this was the common case.

**Fix:** politeness is stripped before the rules run, so `"can you change X"`
reduces to `change X` while `"can you explain X"` still reduces to `explain X`.
`src/intent.ts` · 2 tests.

### 2. A read-only stage did not know it was read-only · FIXED

The same turn then spent **$0.0449 over 9 turns and 3,443 output tokens** looking
for a Write tool it did not have — it re-globbed the same file four times, wrote
the intended file contents into its answer, and finished by asking to be handed
a write tool. The Read tool's own description mentions not re-reading a file you
just edited, so the model concluded the tools were missing rather than withheld.

**Fix:** read-only stages say so in the system prompt, and say what to do
instead. `src/prompts.ts`.

### 3. A branch per turn, forked off the previous branch · FIXED

Three branches in `sumo-news`, all pointing at the same commit, none with any
distinct work:

    sumo/add-how-configure-rss-sources-260804T1554   → 9ee7c80
    sumo/add-mit-licnese-file-260804T1443            → 9ee7c80
    sumo/add-ordered-list-support-markdowntohtml…    → 9ee7c80

Two causes. The name carried a per-turn timestamp, so the same task produced a
different branch on every attempt and iterating stranded each previous attempt.
And `createBranch` forked from wherever HEAD was, so a branch made while standing
on a harness branch inherited it — sumo's own output said
`(from sumo/add-mit-licnese-file-…)`.

**Fix:** the name describes the work and carries no timestamp, so the same work
resolves to the same branch; already standing on a `sumo/*` branch means join it
rather than fork again. `src/runner.ts`, `src/workflows/feature.ts` · 3 tests.

### 4. `feature` killed any task whose plan declared no tests · FIXED

The RSS-docs task reached `write-tests`, correctly reported *"documentation-only
task… there are no test files to write"*, and the workflow then stopped it for
being right — `no test files were written` — after **$0.2733 across 5 stages,
with nothing written to disk.**

**Fix:** the approved plan is the authority. When it declares no tests, the test
stages are skipped rather than failed, and the suite still has to come back
green. `src/workflows/feature.ts`.

### 5. `/plan` approval led to a second, identical gate · FIXED

Approving in `/plan` mode handed off to `feature`, which ran its own explore and
plan and asked for approval again 30 seconds later. Both stages replayed from
cache for `$0.00` and `0s`, so it wasted no money — but an approval gate that
repeats itself is one people learn to click through, and that gate is the only
thing between the harness and an unsupervised write.

**Fix:** approval now carries what it was given for — the plan, the findings it
was written against, and its test count — and the build skips its own explore,
plan, and gate when handed one. `src/workflows/plan.ts`,
`src/workflows/feature.ts`, `src/repl.ts` · 4 tests.

### 6. Nothing said a gate was waiting · FIXED

A gate blocks indefinitely and announced itself only in the scrollback. One sat
open for twenty-five minutes because there was no way to know it had opened.

**Fix:** gates ring the terminal bell, which raises the tab in any multiplexer
and does nothing where it is unwanted. Written only to a real terminal — a
transcript should not carry a control character. `src/gate.ts`.

### 7. Correcting a misroute meant retyping the request · FIXED

A misrouted turn could only be corrected by typing the whole request again under
an explicit mode: you paid for the wrong turn, then paid to restate the same
sentence. Only the mode was ever wrong.

**Fix:** `/again <mode>` re-runs the last request under another mode. It re-runs
verbatim, so the routing log pairs it with the original and records the
correction — which is the only ground truth the harness gets about a route it
got wrong. `src/repl.ts`.

### 8. Iterating on a dirty harness branch forked away from it · FIXED

Found while writing tests for #3, not in a session. The clean-tree check ran
before the reuse check, so a second attempt made while the previous one had left
the tree dirty fell through to "working on the current branch" — the common case
for iterating.

**Fix:** reuse is checked first. Already standing on the right branch means there
is nothing to refuse. `src/runner.ts` · 1 test.

---

## Stage 1 — found by deliberately attacking each feature

### 9. A pinned `/chat` could be widened into a writable mode · FIXED

**The worst one so far.** `/chat delete the parseNote function from src/note.ts
and replace it with a stub` was routed to `do` and **deleted 48 lines of working
code.** Verified against a live model, with the file diffed before and after.

`classify(input, sticky)` guarded the pinned branch with
`if (sticky && sticky !== 'chat')`. The intent was that chat needs no
question special-case, since chat *is* the question mode. The effect was that a
pinned chat skipped the branch entirely and fell through to automatic routing,
which was then free to pick a writable mode — and did.

Chat is the one mode that asks for **less** authority: it cannot write. A pin
that can be overruled into something with *more* authority than was requested is
worse than no pin at all, because it reads as a guarantee.

**Fix:** pinned chat is honoured unconditionally. Every other pin still steps
aside for a plain question — narrowing to chat is always safe, widening never
is. `src/intent.ts` · 2 tests.

### 10. A task you rejected could not be resumed · FIXED

Denying a plan at the gate recorded the task as `finished: true`, so `/resume`
showed it — mode, task, `you stopped it` — and then declined to pick it up. The
only way back to the request was to retype it, which is the same friction
`/again` exists to remove. Rejecting a plan is precisely the moment you want to
go again with different framing.

**Fix:** a task that stopped is recorded as unfinished and `/resume` offers it.
Declining to *build* in `plan` mode stays finished — there the plan was the
deliverable, and it was delivered. `src/repl.ts` · 1 test.

### 11. `explore` was blind in any Node project with dependencies · FIXED

**The most consequential bug so far.** `explore` concluded that a repository
holding five source files and two test files was *empty*, and planned to
scaffold what was already there:

> "There's no `src/` or `test/` directory yet… there is nothing to 'extend'"
> "Example: none found — test/ directory does not exist yet"

`Glob` answers from `node_modules` first and truncates. Asked directly, the
model reported it plainly: *"returns a truncated listing showing 100 of 222
matching files"* — all 100 of them dependencies. `explore`'s entire job is to
find what exists so the work extends rather than duplicates, and it was being
handed a view of the repository with the repository missing from it.

This would hit **any** Node project with `node_modules` installed. `sumo-news`
escaped it only by having a `.codegraph/` index supplying the code instead.

**Fix:** the explore prompt carries the repository's tracked files from
`git ls-files` — free, and immune by construction, since git never lists an
ignored directory. The prompt also says a file's absence from Glob is not
evidence. After the fix, the same task produced *"Do not duplicate `listNotes`;
implement search by filtering its results"* and pointed at `test/store.test.ts`
as the convention to follow. `src/runner.ts`, `src/prompts.ts`,
`src/workflows/{feature,plan}.ts` · 3 tests.

### 12. New work silently inherited the previous task's branch · FIXED

Reuse is right when iterating and wrong when starting something else, and only
the operator can tell which — but nothing said which was happening or how to get
a different branch.

**Fix:** when the branch does not match the task, the way out is named:
`continuing on sumo/store-notes… — /git checkout main first to start
sumo/add-search-command…`. `src/workflows/feature.ts`.

### 13. `/again` reported the wrong error with no history · FIXED

`/again nonsense` said "Nothing to re-run yet" rather than naming the invalid
mode, because the history check ran first — burying a mistake in what was just
typed behind an unrelated fact about the session. **Fix:** the mode is validated
first. `src/repl.ts`.

### 16. The escalation ladder's effort dimension was discarded · FIXED

Found by writing the test that was missing, not in a session — `feature` carried
a second copy of the retry ladder that had never been tested at all.

Both `fix` and `feature` built their writing stage as
`rung: { tier: current.tier, effort: … 'medium' }` — taking the ladder's tier
and **hardcoding the effort**. So climbing rung 1 (`mid/low`) to rung 2
(`mid/high`) produced an identical stage: same model, same thinking depth. That
escalation bought a whole extra attempt and changed nothing, while `types.ts`
states the opposite intent — *"Effort bumps come before tier jumps because
raising thinking depth costs far less than moving up a model class."*

It hid because the test that should have caught it asserted only on tiers:
`['mid','mid','mid','mid']` proved the model had not changed, and never checked
that effort had. The test was named "effort rises before the model does" and was
true of the ladder while false of what ran.

**Fix:** both stages take the ladder's rung verbatim. The ladder says how hard to
try; the stage does not overrule it. `src/workflows/{fix,feature}.ts` — and the
old test now asserts `['low','low','high','high']` so it cannot hide again.

### 17. `feature`'s retry ladder and test-locking were untested · FIXED

`fix` had ladder coverage from the day it was written; `feature` carried the same
loop with none, and nothing checked that the workflow actually handed the gate
the paths it claims to lock. A ladder that works in one of two workflows is worse
than none, because the other gives up silently on the first failure.

**Fix:** four tests against the gate the workflow really builds — the test
written this turn is refused, the implementation is allowed, a failure is retried
then climbed, and it gives up rather than climbing forever.
`test/feature-handoff.test.ts`.

### 20. Two screening lists disagreed about what destroys work · FIXED

Found by running `/fix` on slate's missing test coverage. The evidence stage
proposed a mutation-test repro, and the approval gate warned only that it
*chained commands*:

    git stash; sed -i '' -e "…/d" src/note.ts && npm test; git checkout -- src/note.ts
    ⚠ This command chains or substitutes commands.

Nothing said that `git stash` takes uncommitted work out of the tree with no
`pop`, or that `git checkout --` overwrites the working tree from the index.
The git tool's own screen in `src/git-tool.ts` had learned both of those that
morning; `ALARMING` in `src/runner.ts`, which screens model-proposed repro
commands, still knew only about `push`, `reset --hard` and `clean`.

Two screens in one codebase, disagreeing about the same question — and the one
that was behind is the one guarding a command a human is about to approve.

**Fix:** brought into step, with the reads left deliberately quiet: a warning
list that cries wolf is one people click through. `src/runner.ts` · 2 tests.

---

### 23. Every plan, survey and diagnosis was shown to the operator as a wire format · FIXED

`renderPlan` and its siblings encode their tables as TOON — a format adopted
because it pays for a field name once per table instead of once per row. The
same string was then handed to the approval gate, so an approval looked like:

    steps[2]{file,action,detail}:
      src/store.ts,edit,"Change addNote signature to addNote(dir: string, ti
    tle: string, tags: string[] = [], body: string = ''): Promise<Note>, usi

A schema header, comma-joined rows, and wrapping wherever the terminal edge
happened to fall. The one thing a gate exists for is being read before it is
answered.

The tempting fix — make the renderers pretty — is the wrong one, and quietly
expensive: that text is also fed into the next stage's prompt, so prose there
would raise the cost of every later stage and show up nowhere.

**Fix:** split the two audiences. `render*` stays TOON for prompts; `display*`
lays the same parsed answer out in boxes for the terminal. They are built
together by `shownPlan`/`shownExplore`/`shownEvidence`/`shownRootCause`, which
return `{ value, prompt, display }` — one place, fields named for their reader,
so sending the pretty one to a model is hard to do by accident. `src/ui.ts`,
three workflows · 10 tests, the sharpest of which asserts the *prompt* form is
still TOON.

Not touched: `failures.toPrompt`. Same encoding, but the name is literal — it
only ever reaches `IMPLEMENT_STAGE`, never the screen.

---

### 24. A gate asked for approval of nothing · FIXED

Found immediately after fixing #23, by watching the new rendering on a live
`/fix`. The root-cause stage retried its structured answer five times and ended
`stopped: error`, writing an empty `rootcause.md`. The workflow carried on
regardless:

    Approve this root cause and fix?


      y go ahead    n stop    …? ask about it    … say what to change

A blank space where the proposal should be, and a cursor waiting for yes.
Answering yes sends an empty root cause into `FIX_STAGE` — a writable stage,
given a blank instruction, on approval that was never informed.

The gate's whole design is that silence never becomes consent. This was the
mirror image and nobody had looked at it: *emptiness* becoming a proposal.
Predates #23 — the old renderer produced an empty string from an empty answer
too. The prettier layout is only what made it obvious.

**Fix:** two layers, deliberately.

`askApproval` refuses to ask at all when it is handed a body that is present but
blank — the invariant belongs at the chokepoint, because a gate exists to make
someone responsible for a *specific* proposal. An omitted body still asks, since
that legitimately means "already on screen".

Each workflow checks first as well, because only the workflow knows which stage
failed and why: a budget stop and a provider error want opposite responses from
the operator, so `producedNothing(stage, stopped)` carries both.
`src/gate.ts`, three workflows · 4 tests.

---

### 25. The input line vanished for exactly as long as a stage had something to say · FIXED

Reported as *"there is no way for me to type — the input thingy is gone"*, with
a screenshot of a running stage: tool lines, then nothing where the prompt
should be.

Every write to the terminal erases the live region, and the region was only
repainted once the terminal had been quiet for 200ms. A stage streaming output
never went quiet, so the prompt was absent whenever there was output — which is
precisely when someone wants to interrupt. Measured during a real stage: the
prompt was on screen in **6 of 40 samples (15%)**.

It came back the moment you typed a character, because holding — which buffers
output at line boundaries and keeps the cursor at a line start — was gated on
the buffer being non-empty. So the affordance appeared only after you had tried
the thing it existed to tell you was possible.

Two causes, both fixed:

- The quiet rule was applied to the whole block. It belongs to the activity
  line, which animates a spinner and a clock and is what actually strobes; the
  input line is static text, so repainting it after every write changes nothing
  on screen. `compose()` now gates the two separately.
- Holding started on the first keystroke rather than when the input line opened.
  A partial line leaves the cursor mid-sentence, which is the one position the
  block cannot be drawn in — so without holding, most of a streaming stage was
  undrawable regardless of the quiet rule. It now starts with the input line.

Re-measured the same way: **40 of 40 samples (100%)**. `src/statusbar.ts` ·
3 tests, one of which asserts the prompt survives 40 consecutive writes.

---

### 26. Boxes were drawn to 120 columns while their contents ran to the terminal edge · FIXED

Reported as *"there is cutoff on the boxes and looks ugly as fuck — can we
follow shell resizing, no matter what shell I use it just works"*, with a
screenshot of a wide terminal: neat frames ending well short of the right-hand
side, and test lines spilling past them to wrap raggedly underneath.

Two causes, and each alone would have looked like a different bug.

`rule()` capped its width at 120 columns, on the reasoning that a very wide
terminal needs a *visible* line rather than a long one. Defensible for a
horizontal rule; wrong for everything that measures itself against it, because
the boxed artifacts derive their frame width from there. On a 165-column
terminal the frame stopped at 120.

And several call sites pushed text into a box without wrapping it — a test's
`case`, a repro command, a conventions path, and `entry()` whenever a head and
its tag together exceeded the width. Those lines ran to the real terminal edge,
which is what made the frame look broken rather than merely narrow.

**Fix:** the cap is gone — `width()` reports whatever the shell says, read at
draw time so a resize is picked up by whatever renders next. Every remaining
call site wraps. `src/statusbar.ts`, `src/ui.ts`.

Measured at five widths, counting characters rather than bytes — every box
glyph is three-byte UTF-8, which made the first measurement claim 237-column
lines on an 80-column terminal:

    cols  60 → widest  60 · over-width 0
    cols  80 → widest  80 · over-width 0
    cols 100 → widest 100 · over-width 0
    cols 160 → widest 160 · over-width 0
    cols 220 → widest 220 · over-width 0

Pinned by a test that renders a deliberately hostile plan — a 200-character test
name, a long repro command, a deep path — and asserts nothing exceeds the frame.

---

### 27. The cache saved 2% of what it claimed, and a failed stage lost everything · FIXED

Reported after a plan stage exhausted its budget: *"the plan stage produced no
answer, and after that if I continue it just reset and started to explore the
project again."*

Both halves were real, and the second was the expensive one. From
`.sumo/metrics.jsonl`, 30 real tasks:

    total spent   $4.6042
    saved by cache  $0.0936     (2%)

The same task, run twice, cost near-full price both times — `$0.2526` then
`$0.2393`. The README's claim that *"nothing identical is paid for twice"* was
false in the case that matters most: retrying after a failure.

The cache key is the exact prompt, and `repl.ts` builds it as

    conversation.add('user', input);
    const context = conversation.contextBlock();

so the conversation grows every turn and the key never repeats. That cascades:
a different survey gives different findings, which gives the plan stage a
different prompt too, so nothing downstream hits either.

**Fix, in two layers.**

The survey stages — `explore` and `evidence` — no longer receive the
conversation. They are given the index pack, which is derived from the task and
the repository and therefore repeats when those do. The cost is that they can no
longer resolve "add that to the CLI too" from an earlier turn; they see the task
text and the file listing, which is the right trade for a stage whose job is to
describe what exists.

And when the cache misses anyway — cleared, evicted — a saved survey is reused
if the task text matches *and* the repository fingerprint is identical.
Fingerprint equality is what makes this safe: findings name files, so reusing
them across a change to those files would be confidently wrong rather than
merely stale. `src/state.ts`, `src/prompts.ts`, three workflows · 6 tests, four
of which assert it *refuses* to reuse.

Also removed: the $1 default spending cap on a stage. A stage answering in a
schema produces nothing until it produces all of it, so being cut off part-way
bought no answer *plus* everything already spent — and then the retry started
from nothing. What bounds a stage is its turn limit, which is a thing it can
finish inside. Callers that want a ceiling still pass one; the routing
classifier keeps its two cents.

### 28. TypeScript's own test runners were invisible to the failure parser · FIXED

`failures.parse` read node:test, pytest and go test, and fell back to the raw
log for anything it didn't recognise — the fallback that a real TS repo hit on
every run, since vitest and jest are what TypeScript projects actually use and
neither was among the three. Delta-retries degraded silently to shipping 6k
characters of scrollback exactly where the harness is used most, with nothing
to say that the compression it advertises wasn't happening.

**Fix:** `parseVitest` reads the `FAIL <file> > <describe> > <case>` lines
vitest prints once per failure, under `Failed Tests` rather than in the live
summary above it — same trick `parseNode` already used to avoid counting a
failure twice. `parseJest` pairs each `FAIL <file>` header with the
`● <describe> › <case>` blocks beneath it. Both were checked against output
captured from real `vitest run` and `jest` invocations, not guessed at — the
`›` jest uses to join a describe path, for one, is not the `>` it would have
been reasonable to assume. `src/failures.ts` · 6 tests.

Also added `testFiles()`, the distinct files a failure set names in
first-seen order — nothing in this brief calls it yet; a later one locks
those files while a fix is in progress.

---

### 28. New work continued on a branch named for an unrelated old task · FIXED

From a real session:

    continuing on sumo/add-how-configure-rss-sources-260804T1554
      — /git checkout main first to start sumo/i-would-like-make-ios

A documentation task landed on a branch cut hours earlier for an RSS feature.

The reuse rule was `isSumoBranch(from)`, which asks whether the current branch
belongs to *the harness* rather than to *this task*. Bug #3 taught it not to
fork a branch off another harness branch, and it learned the lesson too broadly:
anything started while standing on one joined it instead.

The code knew, and said so — that notice is the code recognising the exact
situation and choosing to continue anyway, on the reasoning that only the
operator can tell iteration from new work. In practice the notice scrolls past
in a stream of tool output and the commits land regardless, which is discovered
later, when a plan and a test suite have been built on top.

But the two cases *are* distinguishable: the branch name is derived from the
task, so a name that matches is iteration and a name that does not is new work.

**Fix:** reuse requires the name to match. A harness branch belonging to
different work is its own outcome, `conflict`, and it stops the workflow before
anything is written rather than reporting itself and carrying on. Nothing moves
the operator's branch — the way out is one command, and it is named.
`src/runner.ts`, `src/workflows/feature.ts` · 2 tests.

---

## Open — not yet fixed

### 34. A task's tool list changed stage to stage, which broke a provider's own prefix cache · MECHANISM IN PLACE, LIVE NUMBER STILL OPEN

Anthropic's prompt caching matches an exact prefix: system prompt, then tool
definitions, then messages. `engine/claude.ts` built the tool list fresh per
stage from `capabilities` — a read-only stage like `evidence` got `Read, Glob,
Grep`; a writable stage like `fix`, later in the same task, got those plus
`Edit, Write`. That tool-definitions block sits ahead of every message in the
prefix a provider caches by, so the moment it changed, nothing before it —
however identical — could be served from cache either.

**What's in now.** `features.ts`'s `stableToolList` (on by default). When it's
on, `engine/claude.ts`'s new `toolsFor(capabilities)` grants every stage
`Read, Glob, Grep, Edit, Write` regardless of what it actually asked for, so
the tool-definitions block stops varying within a task. `git` and `web` are
deliberately excluded from that stable set and stay capability-driven: both
are already scoped to one stage per task for reasons unrelated to caching
(`git` only reaches the repo through a screened MCP tool; `web` is the one
capability whose answer cannot be re-derived from the repository), and
granting them everywhere by default would be a materially bigger change than
this brief set out to make.

Listing `Edit`/`Write` for a read-only stage sounds like it weakens
enforcement, but `buildGate`'s `PreToolUse` hook never looks at the tool list
— it decides purely from `allowWrites` and the call itself — so it refuses the
write exactly as before. The trade is real (an unlisted tool cannot be called
at all; a listed-but-gated one depends on the hook firing), but it is scoped
to this flag alone and reverts the moment it's off.

Separately, `prompts.ts`'s `systemPrompt` used to put the read-only notice
between the working-directory line and the profile, so a read-only and a
writable stage's prompts diverged almost immediately — the profile behind that
point, often the largest part of the prompt, was foreign to the cache in both
directions. Moving the notice to the very end makes a writable stage's whole
prompt an exact prefix of a read-only stage's, which is the longest common run
two variants of this string can share.

`Ledger.render()`'s total line now names how many provider cache-read tokens a
task used (`N pcache`, distinct from `$N reused`, which is this project's own
separate exact-result cache — the two must never be read as the same saving),
since `cacheReadTokens` was already collected per stage but never summed
anywhere a human glances at.

**What's still open.** Same as #22: nothing above has a dollar figure attached
yet. Whether cache reads actually go up and cost actually goes down can only
be shown against a live provider, under `SUMO_E2E=1`, and this brief
deliberately did not spend money proving it. Until that run happens, treat
this as *should* help, not *measured* to.

`src/features.ts`, `src/engine/claude.ts`, `src/prompts.ts`, `src/ledger.ts`,
`src/bench.ts` · `test/stable-tool-list.test.ts`, `test/prompts.test.ts`,
`test/ledger.test.ts` — 7 tests, offline: the flag off leaves a read-only
stage's tool list byte-for-byte as before; on, it gets the same stable list a
writable stage gets, `git`/`web` still require asking for them, and
`buildGate` still refuses `Edit`/`Write` on a read-only stage with those tools
listed; and the read-only system prompt is now provably an exact-prefix
extension of the writable one rather than a divergence assumed to help.

### 21. Old progress files keep their stale `finished: true`

With the branch-reuse fix in place, starting genuinely new work while standing on
a `sumo/*` branch keeps that branch — so a search feature was built on
`sumo/store-notes-as-markdown-files`. Reuse is right for iteration and wrong
here, and nothing says which is happening or that `/git checkout main` is the way
out. The message should name the escape hatch when the branch does not match the
task.

### 12. `/again` reports the wrong error when there is nothing to re-run

`/again nonsense` says "Nothing to re-run yet" rather than naming the invalid
mode, because the empty-history check runs first. Cosmetic, but the suggestion
it prints is then unhelpful.

### 22. Explore is expensive on a repo with large files

On `sumo-news`: explore `$0.1392` / 31s, plan `$0.0951` / 18s, for what became a
one-file documentation edit. Both stages read `settings/page.tsx` in full. Worth
measuring whether the index is displacing reads or just adding to them.

---

## Watching

- **Routing accuracy.** `.sumo/routing.jsonl` records every turn with its
  provenance (`you` / `rules` / `classifier` / `default`) and marks corrections.
  Not enough rows yet to say whether the rules under-fire in a pattern or
  scatter. `/routing` shows it.
- **Whether the cache earns its place across a session**, now that read-only
  stages replay for free between `plan` and `feature`.
