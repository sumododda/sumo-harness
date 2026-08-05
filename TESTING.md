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
