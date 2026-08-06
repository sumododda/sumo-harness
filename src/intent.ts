/**
 * Turn what the user typed into a mode and a ladder rung.
 *
 * A turn gets its mode one of three ways, and only the last is a guess: the
 * operator names it, the request turns out to be shell work this harness has no
 * hands for, or a model reads it. Nothing here matches on keywords.
 *
 * It used to. Ten regexes ran ahead of everything else and answered most turns
 * for free — `\b(bug|broken|fails?)\b` meant `fix`, a leading "what" meant
 * `chat`, and so on. They were free and they were fast, and they were wrong in
 * a way no amount of patching fixed: a regex reads topic, not speech act, so
 * "what happens when the queue is empty" was a bug report and a request to
 * "drop the @throws tags" was a five-stage debugging workflow. Each miss added
 * another pattern, and the operator had to know the patterns to be routed well.
 *
 * What replaced them is the classification call in `route.ts`, which was
 * already there as the fallback. It costs about half a cent — measured, on the
 * 84 cases in `test/routing-cases.ts` — against a turn that then spends
 * dollars, and it understands the request instead of matching it. Paying that
 * on every turn is cheaper than one misroute, which sends an edit to a
 * read-only stage or a question through five stages of a bug workflow.
 *
 * `scripts/routing-eval.ts` is what says so, and is the only thing that can:
 * routing is a model call now, so `npm test` cannot check a single route.
 */

import type { DecidedBy } from './routing-log.ts';
import { type Rung, rungAt } from './types.ts';

/** What the harness will do with a turn. */
export type Mode = 'chat' | 'do' | 'fix' | 'feature' | 'plan' | 'research';

export interface Intent {
  readonly mode: Mode;
  readonly rung: Rung;
  /** How the decision was reached — shown when the user asks why. */
  readonly why: string;
  /**
   * Who reached it.
   *
   * `why` is prose for a human; this is provenance for the log. They are
   * deliberately separate: a later classifier trained on the log must weigh a
   * mode the operator named differently from one that was guessed at, and
   * cannot if it has to infer the difference from a sentence.
   */
  readonly by: DecidedBy;
}

/**
 * Mechanical edits with a small blast radius.
 *
 * The last regex standing, and it no longer routes anything. `retrieval.ts`
 * asks the same question this does — whether a task is mechanical enough that a
 * semantic slice of the repo would only be noise — and that is a question about
 * whether to spend on retrieval, not about what the operator meant. Being
 * occasionally wrong costs a pack nobody reads.
 *
 * The classifier's own `complexity: 'trivial'` answers the same question better
 * and is already on every routed turn; folding this into it would remove the
 * last pattern match from the harness. It is left alone for now because
 * retrieval gating runs on pinned turns too, which never reach the classifier.
 */
export const TRIVIAL =
  /\b(typo|spelling|rename|comment|docstring|jsdoc|readme|doc|docs|format|lint|indent|whitespace|import|log message|version bump|bump)\b/i;

/**
 * Asks that are shell work rather than coding work.
 *
 * This is not an intent guess and never was — it is a fact about the harness's
 * own tool surface. The model has no shell by design, so routing these to a
 * stage buys nothing but a paid refusal. Recognising them costs nothing and
 * lets the harness answer immediately.
 */
const SHELL_WORK =
  /\b(check ?out|checkout|git (pull|push|fetch|merge|rebase|stash|log|status|diff|branch|commit|clone|reset|revert|cherry-?pick|tag)|npm (install|i|ci|publish)|yarn install|pnpm install|docker|deploy|restart the server|start the server|kill the (process|server))\b/i;

export interface ShellRequest {
  /** A git subcommand when one is obvious, so the reply can be specific. */
  readonly git: boolean;
}

/** Detects a shell request. Returns null for ordinary coding work. */
export function shellRequest(input: string): ShellRequest | null {
  const text = input.trim();
  if (!SHELL_WORK.test(text)) return null;

  // "fix the git history parsing bug" is coding work that merely mentions git.
  if (/\b(bug|broken|fails?|failing|error|crash|test|refactor|implement|add)\b/i.test(text)) {
    return null;
  }

  return { git: /\bgit\b|check ?out|checkout|commit|branch|stash|rebase/i.test(text) };
}

/**
 * The mode the operator named, when they named one. Null means ask a model.
 *
 * A pin is a label, not a guess, so it is honoured as typed and costs nothing.
 * The one thing it does not carry is difficulty: the rung is the mode's base,
 * and a task that turns out to be harder than that escalates by failing its
 * tests, which is a measurement rather than another guess.
 */
export function pinned(input: string, sticky?: Mode): Intent | null {
  if (input.trim().length === 0) {
    return { mode: 'chat', rung: rungAt(0), why: 'empty', by: 'default' };
  }
  if (!sticky) return null;
  return { mode: sticky, rung: rungFor(sticky), why: 'pinned', by: 'you' };
}

/**
 * Modes whose work is reading rather than reasoning.
 *
 * `research` belongs here despite sounding like the hardest of them: reading
 * what a search returned is retrieval, and what it costs is the pages fetched,
 * not the tier that reads them.
 */
const CHEAP: readonly Mode[] = ['chat', 'do', 'research'];

/** Base rung per mode: cheap for edits, a step up for reasoning-heavy work. */
function rungFor(mode: Mode): Rung {
  return CHEAP.includes(mode) ? rungAt(0) : rungAt(1);
}

/** The modes the classifier may choose between. `plan` stays pin-only. */
export type Label = 'chat' | 'do' | 'fix' | 'feature' | 'research';

const LABELS: readonly string[] = ['chat', 'do', 'fix', 'feature', 'research'];

export function isLabel(mode: string): mode is Label {
  return LABELS.includes(mode);
}

/**
 * The one-shot prompt. Deliberately tiny — it is sent on most turns.
 *
 * The modes are described by what they *do to the repository*, not by the words
 * that tend to accompany them, which is the whole difference between this and
 * the rules it replaced. `research` is in the list because it has to be: it is
 * the only mode that can leave the machine, so a request to search the web has
 * nowhere else to land, and the regex that used to catch it read "check the
 * online flag" as an instruction to go online.
 */
export const CLASSIFY_PROMPT = (input: string) =>
  `Classify this developer request.
"${input}"
mode:
  chat — a question about the code; answer from the repository, change nothing
  do — a small, well-understood edit; the shape of the change is already known
  fix — something behaves wrongly and the cause is not yet known
  feature — a capability that does not exist yet
  research — needs information from outside this repository, such as the web
complexity: trivial, moderate, or hard.
JSON only.`;

export const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    mode: { type: 'string', enum: LABELS },
    complexity: { type: 'string', enum: ['trivial', 'moderate', 'hard'] },
  },
  required: ['mode', 'complexity'],
  additionalProperties: false,
} as const;

/** Maps a classifier answer onto the ladder. Never above rung 3 from a guess. */
export function intentFromClassifier(mode: Label, complexity: string): Intent {
  const rung =
    // Research is retrieval however hard the question is: what it costs is the
    // pages it fetches, not the tier that reads them.
    mode === 'research'
      ? rungAt(0)
      : complexity === 'hard'
        ? rungAt(mode === 'do' ? 1 : 3)
        : complexity === 'moderate'
          ? rungAt(1)
          : rungAt(0);
  return { mode, rung, why: complexity, by: 'classifier' };
}
