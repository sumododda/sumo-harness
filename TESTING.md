# sumo — feature test campaign

Every feature exercised against a live model in a real repo, not a unit test.
`✓` passed, `✗` bug found and fixed, `·` not yet run.

## Gate grammar — `src/gate.ts`

| # | Input | Expected | Result |
|---|---|---|---|
| G1 | `y` | approve, build proceeds | ✓ |
| G2 | text ending `?` | answered, proposal untouched, no revision spent | ✓ |
| G3 | plain text | revision — plan rewritten with the feedback | ✓ ×2, one a real security finding |
| G4 | `n` | stop, plan saved, nothing written | ✓ |
| G5 | `?` alone | print help, ask again | ✓ |
| G6 | Enter ×3 | give up rather than treat silence as consent | ✓ |
| G7 | 4th revision | rescope hint, stop | · |
| G8 | typed mid-stage | becomes a steer, not a gate answer | ~ hard to time live; unit-tested |

## Modes and routing

| # | Case | Expected | Result |
|---|---|---|---|
| M1 | `/feature <task>` | staged workflow, branch, tests-first | ✓ |
| M2 | `/plan <task>` → `y` | hands off without a second gate | ✓ |
| M3 | `/do <task>` | one writable stage, no gate | ✓ |
| M4 | `/fix <bug>` | evidence → root cause → gate → fix → verify | ✓ ×2, on a real bug |
| M5 | `/chat <q>` | read-only, refuses to write | ✗→✓ |
| M6 | auto-route a question | `chat · by rules` | ✓ |
| M7 | auto-route an edit request | not `chat` | · |
| G9 | a stage answers nothing | gate refuses to ask | **✗ bug 24** →✓ |
| M8 | `/again <mode>` | re-runs last request, logs a correction | ✓ guards |
| M9 | `/auto` | back to automatic | · |

## Session commands

| # | Command | Result |
|---|---|---|
| S1 | `/help` | ✓ |
| S2 | `/routing` | ✓ |
| S3 | `/cost` | ✓ |
| S4 | `/cache`, `/cache clear` | ✓ |
| S5 | `/rung`, `/rung 2`, `/rung auto`, `/rung nonsense` | ✓ |
| S6 | `/git status`, `/git push` | ✓ — `/git` is the operator's own shell by design, unscreened |
| S7 | `/tests`, `/tests <cmd>` | ✓ |
| S8 | `/resume` | ✓ |
| S9 | `/clear` | ✓ |
| S10 | `/profile`, `/remember` | ✓ |
| S11 | `/index` | · |
| S12 | unknown command | ✓ |

## Repro-command gate — `fix` only

| # | Case | Result |
|---|---|---|
| R1 | model proposes a repro, operator approves/denies | ✓ denied cleanly |
| R2 | `screenProposedCommand` warns on a risky command | ✓ `⚠ This command chains or substitutes commands.` |

## Enforcement — the claims that matter

| # | Claim | How to break it | Result |
|---|---|---|---|
| E1 | a read-only stage cannot write | ask `/chat` to change a file | **✗ bug 9** →✓ |
| E2 | test files are locked during implement | ask the workflow's own gate | ✓ |
| E3 | the model has no shell | ask for a command to be run | ✓ |
| E4 | git tool refuses destructive commands | ask it to reset/push | ✓ |
| E5 | writes confined to the working directory | ask it to write outside | ✓ |
| E6 | one branch per piece of work | run the same task twice | ✓ |
| E7 | escalation on repeated test failure | scripted failing suite | **✗ bug 16** →✓ |
| E8 | cache replays an identical read-only stage | repeat a `/chat` | ✓ |
| E9 | nothing is ever approvable | make a stage fail, watch the gate | **✗ bug 24** →✓ |
| E10 | tests must fail before they are believed | ask `feature` for tests of behaviour that already works | ✓ refused, correctly |

## Providers and the fleet

Found by building a mid-size project with the harness rather than by unit test —
every one of these passed its own tests while being wrong in a live session.

| # | Claim | Result |
|---|---|---|
| P1 | the fleet holds every credentialed provider | **✗ every call site passed one engine** →✓ `claude + github-copilot` |
| P2 | Anthropic models compete in the pool | **✗ catalogue keys them `anthropic`, engine is named `claude`, so the lookup silently returned nothing** →✓ |
| P3 | a stage routes across providers | ✓ small chat routed at `gpt-5.6-luna`, `implement` best-of-3 |
| P4 | a schema stage prefers a provider that guarantees one | ✓ |
| P5 | a Copilot-only fleet runs `feature`/`fix`/`plan` | **✗ refused every schema stage** →✓ falls back to the submit tool |
| P6 | a Copilot edit reaches the gate as an `Edit` | **✗ all writes arrived as `Write`** →✓ |
| P7 | the secret screen fires on a Copilot write | **✗ no content was passed, so it never could** →✓ `test/copilot-gate.test.ts` |
| P8 | a writable stage that changed nothing says so | **✗ a `/do` claimed an edit it never made, 8 credits** →✓ `no files changed` |
| P9 | `/cost` says which model actually ran | **✗ only the tier** →✓ `on` column |
| P10 | a schema stage routes at the default rung on a mixed fleet | **✗ `No usable model for a small stage` — the guarantee was preferred per fleet, so `evidence` asking small+low effort had every Copilot model removed before Anthropic's effort-less small model turned out to offer nothing** →✓ judged per stage; `bench --fixtures ts-app-memo` now runs 1/1 at rung 0 where it previously failed to route at all |
| P12 | one task bills both providers | ✓ `17.00 cr + $0.1046` on a single fixture — Copilot credits and Anthropic dollars kept apart in the ledger rather than summed |
| P13 | `sumo bench` exits when its last task finishes | **✗ the Copilot headless process outlives the run and holds the pipe open** — results are complete and correct, the process just does not return |
| P11 | path confinement holds under a symlinked working directory | **✗ every write refused: `/var/folders/…` vs the resolved `/private/var/folders/…`** →✓ both ends resolved |

## Gates, continued

| # | Case | Expected | Result |
|---|---|---|---|
| G10 | root cause with an empty fix | not offered for approval | **✗ bug** →✓ stops, saying the evidence did not support one |
| G11 | root cause that is a placeholder | not offered for approval | **✗ `cause: "Test"` was gated on** →✓ |
| G12 | root cause cites a declined repro | must not cite it as evidence | **✗ cited it** →✓ prompt states it was not run |
| G13 | feedback at the repro gate | revise the command | **✗ silently skipped** →✓ revises, bounded by `MAX_REVISIONS` |
| G14 | a question at the repro gate | answered, command intact | **✗ silently skipped** →✓ |
| M10 | `/feature <task>` then a plain message | the second is routed freshly | **✗ pinned for the session** →✓ `question · by rules` |
| M11 | bare `/feature` | pins until `/auto` | ✓ |

## Context budget

The budget assembles a prompt after routing, so what a stage is given depends on
which model it landed on. The claim worth checking live is that converting a call
path to ingredients did not change what the stage is actually asked.

| # | Claim | Result |
|---|---|---|
| C1 | a converted single-stage turn still answers from the pack | ✓ `/chat` routed at `gpt-5.6-luna`, answered from `src/context/budget.ts` without opening it |
| C2 | an assembled prompt is byte-identical to the concatenation it replaced | ✓ checked against the previous `prompts.ts` across every combination of stage, pack, file listing and skeleton flag |
| C3 | ordinary work sits under the ceilings | ✓ a REPL turn at its bounded worst case ~1,600 tokens, `explore` on this repo ~2,100, against 4,000–12,000 |
| C4 | a converted workflow stage still fixes a real bug | ✓ `bench --fixtures ts-app-memo` 1/1 at rung 0: evidence → root cause → fix → 3 retries → escalate to mid → tests pass |

## Rendering

Everything a stage answers reaches two audiences with opposite needs. The
screen-facing form is checked by eye; the prompt-facing form is checked by test,
because making *it* pretty costs money and shows up nowhere.

| # | Claim | Result |
|---|---|---|
| D1 | a plan on screen carries no TOON header | **✗ bug 23** →✓ |
| D2 | the same plan in a prompt is still TOON | ✓ pinned |
| D3 | nothing drawn exceeds the terminal width | ✓ |
| D4 | an unparseable answer degrades to its own text | ✓ |
| D5 | a section tag the model never opened is not drawn | **✗ `</verification>` reached the gate** →✓ stripped at parse, so the prompt form is clean too |
| D6 | a tag the model did open survives | ✓ an HTML repro fixture is written intact |
