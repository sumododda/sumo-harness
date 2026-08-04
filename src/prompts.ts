/**
 * Every prompt in the harness. Kept together so the whole token budget of a
 * session is visible in one file.
 *
 * The system prompt fully replaces the provider's default, so these lines are
 * essentially all the standing instruction a stage gets.
 */

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
 * Builds the system prompt for a stage: role, working directory, permissions,
 * profile.
 *
 * The directory line earns its keep. Replacing the provider's default prompt
 * also drops its environment section, and without it the model guesses absolute
 * paths from filesystem root — burning two failed reads before finding a file.
 */
export function systemPrompt(cwd: string, canWrite = false): string {
  return `${ROLE}

Working directory: ${cwd}
Paths you use must be relative to it, or absolute beneath it.
${canWrite ? '' : READ_ONLY}

${loadProfile()}`;
}

export const DO_STAGE = (task: string, context = '') =>
  `${context}Task: ${task}

Make this change now. Any code shown above was selected for this task by the
repository's index — start there rather than searching for it again.
Keep the change minimal and match the surrounding code's style. Reuse existing
helpers rather than adding near-duplicates.
When done, reply with one line per file changed: <path> — <what changed>.`;

export const CHAT_STAGE = (question: string, context = '') =>
  `${context}Question: ${question}

Answer from the code above if it is sufficient — it was selected for this
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
export const RESEARCH_STAGE = (question: string, context = '') =>
  `${context}Question: ${question}

Search the web and answer from what you find. Prefer primary sources — the
project's own documentation, repository, or release notes — over articles about
them, and prefer a page's date over your own sense of what is current.

Every factual claim carries the URL it came from. If the sources disagree, say
so and give both rather than picking one silently. If searching does not settle
it, say what you could not confirm instead of filling the gap from memory.
Be brief: what was asked, not everything found.`;

export const EVIDENCE_STAGE = (bug: string, context = '') =>
  `${context}Reported problem: ${bug}

Gather evidence. Do not fix anything and do not edit any file.
Any code shown above was selected by the repository's index — start from it and
open further files only when it is not enough. Report what you actually
observed along the failing path.
If a single command would demonstrate the problem, propose it — the harness
will run it, not you. At most three hypotheses, each tied to an observation.`;

export const ROOT_CAUSE_STAGE = (bug: string, evidence: string, repro: string) =>
  `Reported problem: ${bug}

Evidence gathered:
${evidence}
${repro ? `\nRepro output (run by the harness):\n${repro}\n` : ''}
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
export const EXPLORE_STAGE = (task: string, files: readonly string[] = [], context = '') =>
  `${context}${fileListing(files)}Task: ${task}

Investigate before proposing anything. Do not edit any file.
Any code shown above was selected by the repository's index — start from it.
Trust the file listing above over a Glob: Glob answers from dependency
directories first and truncates, so a file missing from it is not evidence that
the file does not exist.
Find what already exists that this should build on: the goal is to extend the
codebase, not to add a parallel implementation of something already here.
Name the existing functions to call rather than reimplement, and point at a
test file that shows how tests are written in this project.`;

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

export const DISCUSS_STAGE = (proposal: string, question: string) =>
  `A proposal is on the table:
${proposal}

The operator asks: ${question}

Answer their question about this proposal. Do not rewrite it and do not produce
a new version — they have not asked for a change yet. Be brief and concrete, and
say plainly if the proposal has a weakness they should know about.`;

export const PLAN_STAGE = (task: string, context = '') =>
  `${context}Task: ${task}

Investigate and propose a plan. Do not change any files.
Reuse existing helpers; do not invent new abstractions unless unavoidable.
Reply with:
  Approach — two sentences.
  Steps — numbered, each naming the file it touches.
  Reuse — existing functions this should call instead of reimplementing.
  Risks — what could go wrong.`;
