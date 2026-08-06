/**
 * Every prompt in the harness. Kept together so the whole token budget of a
 * session is visible in one file.
 *
 * The system prompt fully replaces the provider's default, so these lines are
 * essentially all the standing instruction a stage gets.
 */

import type { Part } from './context/budget.ts';
import * as features from './features.ts';
import { loadProfile } from './profile.ts';

const ROLE = `You are a coding agent in the sumo harness. Work only on the stated task.
You have no shell. The harness runs tests and commands for you.
When a git tool is offered you may use it to inspect history or change branch;
anything that pushes, fetches, deletes, or discards work is refused by design —
ask the operator to run those.
Output exactly what the stage asks for, with no preamble or summary.`;

/**
 * Told to a stage that cannot write.
 *
 * A read-only stage is given no Edit or Write tool, but the tools it *does*
 * have describe themselves in terms that imply the others exist — the Read tool
 * mentions not re-reading a file you just edited. So a model asked to change
 * something in a read-only stage concluded the tools were missing rather than
 * withheld, and spent the stage looking for them: it re-globbed the same file
 * four times, wrote the intended file contents into its answer, and finished by
 * asking to be given a write tool. Nothing was edited and the turn was billed
 * in full.
 *
 * Saying it plainly costs about twenty tokens and turns that into a useful
 * answer, because "say what should change" is a thing a read-only stage can
 * actually do.
 */
const READ_ONLY = `
This stage cannot edit files. You have no Edit or Write tool and none can be
granted — that is the harness's decision, not an oversight, and asking for one
wastes the turn. If the task needs a change, say precisely what should change
and in which file; the harness routes that to a stage that can make it.`;

/**
 * Builds the system prompt for a stage: role, working directory, profile, and
 * — last, only for a stage that cannot write — the read-only notice.
 *
 * The directory line earns its keep. Replacing the provider's default prompt
 * also drops its environment section, and without it the model guesses absolute
 * paths from filesystem root — burning two failed reads before finding a file.
 *
 * The read-only notice sits after the profile rather than right after the
 * directory line so a read-only and a writable stage's prompts share the
 * longest possible identical run of text. A provider that caches its own
 * request by longest-common-prefix gets nothing from a match at the *end* of
 * the string; with the one line that differs moved last, a writable stage's
 * entire prompt is now an exact prefix of a read-only stage's — role,
 * directory and profile can all be served from that cache regardless of which
 * kind of stage asks next, where before the prefix broke immediately after
 * "Working directory" and the profile behind it was foreign to it either way.
 */
export function systemPrompt(cwd: string, canWrite = false): string {
  return `${ROLE}

Working directory: ${cwd}
Paths you use must be relative to it, or absolute beneath it.

${loadProfile()}${canWrite ? '' : `\n${READ_ONLY}`}`;
}

/**
 * For stages that answer from their own prompt and nothing else.
 *
 * {@link ROLE} tells a model it is a coding agent working in a repository, and
 * a model told that behaves like one. Given it, the router — whose entire input
 * is one sentence — opened the repository to look for the identifiers named in
 * the request, then narrated what it was doing at length: about 1,400 output
 * tokens and three turns to produce a two-field JSON object, and occasionally
 * no JSON at all because it ran out of budget while exploring.
 *
 * Withholding the tools stopped the exploring. Withholding this stopped the
 * narration, which was most of what was left. Both are the same point: a stage
 * that classifies text is not a coding stage, and describing it as one costs
 * far more than the words it takes to say.
 */
export const CLASSIFIER_ROLE = `You label text. The input is the whole task — there is no repository to
consult, no files to open, and no tools.
Answer with the JSON object the schema describes and nothing else: no
reasoning, no preamble, no explanation, no restating of the question.`;

const DO_INSTRUCTIONS = `Make this change now. Any code shown above was selected for this task by the
repository's index — start there rather than searching for it again.
Keep the change minimal and match the surrounding code's style. Reuse existing
helpers rather than adding near-duplicates.
When done, reply with one line per file changed: <path> — <what changed>.`;

/** `sumo do` builds its prompt in advance; the REPL's `do` goes through {@link singleStageParts}. */
export const DO_STAGE = (task: string) => `Task: ${task}\n\n${DO_INSTRUCTIONS}`;

const CHAT_INSTRUCTIONS = `Answer from the code above if it is sufficient — it was selected for this
question by the repository's index. Open further files only when it genuinely
is not enough. Answer directly and briefly, and change nothing. If the answer
is not in the code, say so rather than guessing.`;

/**
 * The one stage allowed to leave the machine.
 *
 * Web access is granted per stage rather than globally because it changes what
 * an answer *is*: everywhere else, a stage's output can be re-derived from the
 * repository, and here it cannot. That is worth having — a question about a
 * library's current API has no answer in the repo — but it is worth marking,
 * which is what the citation requirement does. An uncited claim from this stage
 * is indistinguishable from one the model simply remembered.
 */
const RESEARCH_INSTRUCTIONS = `Search the web and answer from what you find. Prefer primary sources — the
project's own documentation, repository, or release notes — over articles about
them, and prefer a page's date over your own sense of what is current.

Every factual claim carries the URL it came from. If the sources disagree, say
so and give both rather than picking one silently. If searching does not settle
it, say what you could not confirm instead of filling the gap from memory.
Be brief: what was asked, not everything found.`;

/**
 * Told to a survey stage once the skeleton flag is on. Bug #22: `explore` and
 * `plan` both `Read` a large file in full on top of a pack that had already
 * selected it — the index was meant to replace that read, not sit beside it.
 * Naming the one thing that gets a body (the symbol) costs a sentence and
 * turns "read the whole file to check" into "the signature already said
 * enough" for the common case. Returns '' when the flag is off, so this reads
 * as it did before the flag existed.
 */
function skeletonHint(): string {
  if (!features.get().skeletonContext) return '';
  return " A skeleton above lists this task's files by signature, no bodies — a\nbody is available by naming its symbol, not by reading the whole file.";
}

const evidenceInstructions = () =>
  `Gather evidence. Do not fix anything and do not edit any file.
Any code shown above was selected by the repository's index — start from it and
open further files only when it is not enough.${skeletonHint()} Report what you
actually observed along the failing path.
If a single command would demonstrate the problem, propose it — the harness
will run it, not you.
If a new-or-existing test file would demonstrate the bug, propose its file
path and full content — the harness writes and runs it, never you. It must be
expected to fail right now, against the code as it stands. This is optional:
leave it null when nothing test-shaped fits, e.g. a UI or manual-only bug —
forcing one where none applies is worse than proposing none.
At most three hypotheses, each tied to an observation.`;

/** The evidence stage, split so the index's pack is something the budget can shed. */
export function evidenceParts(bug: string, pack = ''): readonly Part[] {
  return [
    ...(pack ? [{ region: 'pack' as const, text: pack }] : []),
    { region: 'task', text: `Reported problem: ${bug}\n\n` },
    { region: 'instructions', text: evidenceInstructions() },
  ];
}

/**
 * What became of the repro command the evidence stage proposed.
 *
 * Three states rather than a string, because the evidence block always carries
 * the proposed command — it is a field on the Evidence schema — so a stage
 * handed nothing cannot tell "there was no repro" from "there was one and it
 * was declined". It read the command sitting in the evidence, assumed it had
 * run, and cited it: one real root cause rested on "repro: node … reproduces
 * the raw stack trace" for a command the operator had refused.
 */
export type ReproOutcome =
  | { readonly kind: 'ran'; readonly output: string }
  | { readonly kind: 'not-run' }
  | { readonly kind: 'none' };

function reproBlock(repro: ReproOutcome): string {
  if (repro.kind === 'ran') return `\nRepro output (run by the harness):\n${repro.output}\n`;
  if (repro.kind === 'not-run') {
    return (
      '\nThe repro command shown in the evidence above was NOT run — nothing is\n' +
      'known about what it prints. It is a proposal, not an observation, and must\n' +
      'not be cited as evidence.\n'
    );
  }
  return '';
}

export const ROOT_CAUSE_STAGE = (bug: string, evidence: string, repro: ReproOutcome) =>
  `Reported problem: ${bug}

Evidence gathered:
${evidence}
${reproBlock(repro)}
State the single most likely root cause. Every claim must cite an observation
or a line of the repro output above — no unreferenced assertions. If the
evidence does not support a conclusion, say so in the cause and leave the fix
empty rather than guessing.`;

export const FIX_STAGE = (rootCause: string, notes: readonly string[] = []) =>
  `Approved root cause and fix:
${rootCause}
${feedbackBlock(notes)}
Make exactly this change. Do not fix unrelated issues, do not add defensive
code, and do not modify tests. The harness will verify by running the suite.
When done, reply with one line per file changed: <path> — <what changed>.`;

/**
 * The repository's own files, listed for a stage that has to survey it.
 *
 * `Glob` answers from dependency directories first and truncates, so a stage
 * asking what exists can be told that a project with source in it is empty.
 * This is the same question answered from git, which never sees an ignored
 * directory. Free, and the one thing explore cannot afford to get wrong.
 */
export function fileListing(files: readonly string[]): string {
  if (files.length === 0) return '';
  return `Files in this repository (from git, so nothing ignored is listed):
${files.map((f) => `  ${f}`).join('\n')}

`;
}

/**
 * The survey stage runs without the conversation, deliberately.
 *
 * Everything else in a turn may read the recent history, but this stage is the
 * one whose answer must be reusable: it is a survey of the repository against a
 * task string, and the repository does not change because something was said
 * three turns ago. Feeding it the history made its prompt different on every
 * attempt, so the cache key never repeated — retrying a task after it failed
 * re-ran the survey and paid full price for the same answer. Measured across 30
 * real tasks, the cache saved $0.09 of $4.60.
 *
 * The cost of leaving it out is that this stage cannot resolve "add that to the
 * CLI too" from an earlier turn; it sees the task text and the file listing.
 * That is the right trade for a stage whose job is to describe what exists.
 */
const exploreInstructions = () =>
  `Investigate before proposing anything. Do not edit any file.
Any code shown above was selected by the repository's index — start from it.${skeletonHint()}
Trust the file listing above over a Glob: Glob answers from dependency
directories first and truncates, so a file missing from it is not evidence that
the file does not exist.
Find what already exists that this should build on: the goal is to extend the
codebase, not to add a parallel implementation of something already here.
Name the existing functions to call rather than reimplement, and point at a
test file that shows how tests are written in this project.`;

/**
 * The explore stage, split the same way — but note where the file listing lands.
 *
 * It goes with the task, not with the droppable context, even though it is
 * retrieved material and the largest region here. Two reasons, and both are
 * about what its absence would do rather than what its presence costs: the
 * instructions below tell the model to trust it *over* a Glob, so dropping it
 * leaves that sentence pointing at nothing and hands the stage back to the one
 * tool this harness knows truncates misleadingly. It is already bounded at 400
 * entries by `runner.repoFiles`, so it cannot be the region that overruns.
 */
export function exploreParts(
  task: string,
  files: readonly string[] = [],
  pack = '',
): readonly Part[] {
  return [
    ...(pack ? [{ region: 'pack' as const, text: pack }] : []),
    { region: 'task', text: `${fileListing(files)}Task: ${task}\n\n` },
    { region: 'instructions', text: exploreInstructions() },
  ];
}

/**
 * Every correction so far, not just the most recent one.
 *
 * Revisions used to carry only the latest note, so a second correction silently
 * dropped the first: told "use my own server, not a VPS" and then "mention the
 * schedule", the next proposal was free to put the VPS back. Arguing with a
 * proposal only works if the argument accumulates — otherwise each round trades
 * one fix for another and the operator has no way to tell.
 */
export function feedbackBlock(notes: readonly string[]): string {
  if (notes.length === 0) return '';
  if (notes.length === 1) return `\nOperator feedback to apply: ${notes[0] ?? ''}\n`;
  const numbered = notes.map((note, i) => `${String(i + 1)}. ${note}`).join('\n');
  return `\nOperator feedback so far. All of it still applies — a later note refines
the earlier ones rather than replacing them, and a proposal that satisfies the
most recent while undoing an earlier one is wrong:\n${numbered}\n`;
}

export const FEATURE_PLAN_STAGE = (task: string, findings: string, notes: readonly string[] = []) =>
  `Task: ${task}

Exploration findings:
${findings}
${feedbackBlock(notes)}
Write a minimal plan. Call the existing helpers listed above rather than
writing new ones. Do not add new files or abstractions unless there is no
alternative. Every step names the file it changes, and every test says why it
fails today.

Some work has no tests: documentation, configuration, a comment. For that work
return an empty tests list. Do not describe the absence as a test — an entry
reading "N/A" or "no tests needed" is counted as a test that must then be
written, and the task is stopped when it is not. An empty list is the correct
and supported answer, and the harness skips the test stages when it sees one.`;

export const WRITE_TESTS_STAGE = (plan: string, conventions: string) =>
  `Approved plan:
${plan}

Write ONLY the tests named in that plan, following this project's existing test
conventions:
${conventions}

The tests must fail right now, because the behaviour does not exist yet. Do not
implement the behaviour, and do not stub it to make them pass. Touch no file
other than the test files.
When done, reply with one line per test file: <path> — <what it asserts>.`;

export const IMPLEMENT_STAGE = (
  plan: string,
  testOutput: string,
  preExisting: string | null = null,
) =>
  `Approved plan:
${plan}

These tests now exist and are failing:
${testOutput}
${
  preExisting
    ? `\nThese failures ALREADY existed before this task began. They are not\nyours to fix — leave that code alone unless the plan says otherwise:\n${preExisting}\n`
    : ''
}
Implement the behaviour so the tests from the plan pass. The test files are
locked — you cannot edit them, and weakening a test is not an option. Reuse the
existing helpers named in the plan. Do not add error handling for situations
that cannot occur.
When done, reply with one line per file changed: <path> — <what changed>.`;

/**
 * A cheap advisory read on a failed fix attempt, run right before the ladder
 * decides what to do next.
 *
 * No repository access and no context block: the question is entirely
 * answerable from the root cause and the failing output already in hand, and
 * giving it more would only make an intentionally near-free call slower.
 */
export const ESCALATION_JUDGE_STAGE = (rootCause: string, failingOutput: string) =>
  `Root cause and fix that was attempted:
${rootCause}

Verification failed. What the test run showed:
${failingOutput}

Judge this failure. Is it a near miss the same approach could likely fix with
another try at the same rung, or does it look like the current approach or
model capability is insufficient and a stronger model is needed? Answer with
the verdict only — no explanation.`;

/**
 * Rewrites a proposed repro command from the operator's correction.
 *
 * The repro gate offers the same grammar as every other gate — including "say
 * what to change" — and used to treat anything but `y` as a refusal. Telling it
 * to write somewhere else was silently read as "do not run it", which is the
 * failure the gate exists to prevent: being told what to change and having
 * nothing change.
 */
export const REPRO_REVISE_STAGE = (command: string, notes: readonly string[]) =>
  `This command was proposed to reproduce the bug:

${command}
${feedbackBlock(notes)}
Reply with the corrected command. It must be a single non-interactive shell
command, must not touch files the operator did not ask it to, and must not
push, reset, or delete anything.`;

export const DISCUSS_STAGE = (proposal: string, question: string) =>
  `A proposal is on the table:
${proposal}

The operator asks: ${question}

Answer their question about this proposal. Do not rewrite it and do not produce
a new version — they have not asked for a change yet. Be brief and concrete, and
say plainly if the proposal has a weakness they should know about.`;

const PLAN_INSTRUCTIONS = `Investigate and propose a plan. Do not change any files.
Reuse existing helpers; do not invent new abstractions unless unavoidable.
Reply with:
  Approach — two sentences.
  Steps — numbered, each naming the file it touches.
  Reuse — existing functions this should call instead of reimplementing.
  Risks — what could go wrong.`;

/** The REPL modes that run as one stage rather than as a gated workflow. */
export type SingleStage = 'do' | 'plan' | 'chat' | 'research';

/**
 * How each of them names the thing it was asked, and what it is told to do
 * about it. Kept as data so the two halves cannot be assembled in the wrong
 * order by a caller writing the fifth one.
 */
const SINGLE_STAGE: Record<SingleStage, { readonly asks: string; readonly instructions: string }> =
  {
    do: { asks: 'Task', instructions: DO_INSTRUCTIONS },
    plan: { asks: 'Task', instructions: PLAN_INSTRUCTIONS },
    chat: { asks: 'Question', instructions: CHAT_INSTRUCTIONS },
    research: { asks: 'Question', instructions: RESEARCH_INSTRUCTIONS },
  };

/**
 * A single-stage prompt as its two undroppable halves, for the harness to
 * assemble behind whatever context fits.
 *
 * Split rather than returned whole because the ordering is the point: the
 * instructions have to end up last, after context the harness may not have
 * decided on yet, and a caller that concatenated the prompt itself would have to
 * be trusted to put them there. Handing over the halves makes it structural —
 * see `context/budget.ts`, which places every region regardless of the order it
 * received them in.
 */
export function singleStageParts(stage: SingleStage, input: string): readonly Part[] {
  const { asks, instructions } = SINGLE_STAGE[stage];
  return [
    { region: 'task', text: `${asks}: ${input}\n\n` },
    { region: 'instructions', text: instructions },
  ];
}
