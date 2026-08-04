/**
 * Turn what the user typed into a mode and a ladder rung.
 *
 * Rules first, because they are free and cover most turns. Only genuinely
 * ambiguous input costs a classification call, and that call is the cheapest
 * model available.
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
   * rule that matched differently from a guess that was paid for, and cannot if
   * it has to infer the difference from a sentence.
   */
  readonly by: DecidedBy;
}

/** Questions: answer from context, change nothing. */
const ASKING =
  /^(what|why|how|where|when|which|who|is|are|does|do|did|can|could|should|would|explain|tell me|show me)\b/i;

/**
 * The polite wrapper English puts around an instruction.
 *
 * "can you change the licence to Apache" is a request, not a question, and
 * reading it as one is the worst mistake this module can make: the harness
 * answers instead of acting, spends a stage doing it, and changes nothing. It
 * is also the common case rather than an edge one — people ask for work
 * politely by default, and every polite form in English opens with an auxiliary
 * verb that {@link ASKING} matches.
 *
 * Stripping the wrapper first leaves the actual verb, which the rules below
 * already read correctly: "can you explain X" still reduces to "explain X" and
 * is still a question, while "can you change X" reduces to an instruction.
 */
const POLITE =
  /^(?:please\s+|(?:can|could|would|will)\s+(?:you|we|u)\s+|i(?:'d| would) like (?:you )?to\s+|i (?:want|need) (?:you )?to\s+|let'?s\s+|pls\s+)+/i;

/** The request with its politeness removed. Never empty unless the input was. */
function requestOf(text: string): string {
  const stripped = text.replace(POLITE, '').trim();
  return stripped.length > 0 ? stripped : text;
}

/**
 * Mechanical edits with a small blast radius.
 *
 * Exported because retrieval gating asks the same question this does — whether
 * a task is mechanical enough that a semantic slice of the repo would only be
 * noise. Two regexes drifting apart would be two different definitions of
 * "trivial".
 */
export const TRIVIAL =
  /\b(typo|spelling|rename|comment|docstring|jsdoc|readme|doc|docs|format|lint|indent|whitespace|import|log message|version bump|bump)\b/i;

/**
 * Tidying existing code. Not a bug and not a new capability — the third common
 * kind of request, and one that otherwise falls through to a paid classifier.
 */
const CLEANUP =
  /\b(clean ?(it|this|that)? ?up|cleanup|tidy|simplify|deduplicat\w*|dedupe|duplicat\w*|extract|inline|consolidat\w*|reuse|dry it up|tighten)\b/i;

/** Something is broken. */
/**
 * Prose that reports something broken.
 *
 * The leading `(?<!@)` is load-bearing. These words are also documentation tag
 * names, and `\b` sits quite happily between the `@` and the `t` of `@throws` —
 * so "drop the @param and @throws tags from this jsdoc" was read as a bug
 * report and routed into the five-stage fix workflow at high effort, to rewrite
 * a comment. A tag is an annotation, not a description of a failure.
 */
const BROKEN =
  /(?<!@)\b(bug|broken|fails?|failing|error|crash|crashes|exception|regression|wrong|incorrect|not working|doesn'?t work|throws?|nan|undefined|null pointer)\b/i;

/**
 * New capability. Split by strength: "add" and "create" pair just as naturally
 * with a comment as with an endpoint, so they must not outvote a mechanical
 * noun — only the unambiguous verbs do.
 */
const BUILDING_STRONG =
  /\b(implement|introduce|feature|endpoint|api|command|module|class|integration)\b/i;
const BUILDING = /\b(add|implement|build|create|support|introduce|feature|endpoint|new)\b/i;

/**
 * Hard-to-diagnose failures. These are bugs even when no failure word appears —
 * nobody mentions a deadlock to praise it.
 */
const HARD_BUG =
  /\b(race condition|races?|deadlock\w*|livelock|concurren\w*|flaky|intermittent|leaks?|leaking|heisenbug|thread(ing)? (bug|issue|problem)|dead ?lock)\b/i;

/** Large restructuring work: not a failure, but still worth a stronger model. */
const HARD_WORK =
  /\b(refactor\w*|architect\w*|redesign|migrat\w*|optimi[sz]\w*|performance|security|rewrite)\b/i;

/**
 * Asks that are shell work rather than coding work.
 *
 * The model has no shell by design, so routing these to a stage buys nothing
 * but a paid refusal. Recognising them costs nothing and lets the harness
 * answer immediately.
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
 * Classifies a turn without calling a model. Returns null when the rules cannot
 * decide, in which case the caller may pay for one cheap classification.
 */
export function classify(input: string, sticky?: Mode): Intent | null {
  const text = input.trim();
  if (text.length === 0) return { mode: 'chat', rung: rungAt(0), why: 'empty', by: 'rules' };

  // Every rule below reads the request itself rather than the manners around
  // it, so "can you rename this" is judged on "rename".
  const request = requestOf(text);

  const hardBug = HARD_BUG.test(request);
  const hard = hardBug || HARD_WORK.test(request);
  const asking = ASKING.test(request) && !BROKEN.test(request) && !hardBug;

  // Pinned `chat` is honoured unconditionally, because it is the one mode that
  // is a request for *less* authority: chat cannot write, and someone who asks
  // for a read-only turn has to get one.
  //
  // This used to be excluded from the pinned branch below — the reasoning being
  // that chat needs no question special-case, since chat is the question mode.
  // The effect was that pinning it fell through to automatic routing, which was
  // then free to pick a writable mode: `/chat delete the parseNote function`
  // routed to `do` and deleted it. A mode pin that can be overruled into
  // something with more authority than was asked for is worse than no pin.
  if (sticky === 'chat') {
    return { mode: 'chat', rung: rungAt(hard ? 1 : 0), why: 'pinned', by: 'you' };
  }

  // `research` is honoured unconditionally for the opposite reason to `chat`.
  // It is a question-answering mode by definition, so the "step aside for a
  // plain question" rule below would fire on essentially every use of it and
  // hand the turn to `chat` — which has no web access. A pin that silently
  // drops the one capability it was typed to grant is worse than no pin.
  if (sticky === 'research') {
    return { mode: 'research', rung: rungAt(hard ? 1 : 0), why: 'pinned', by: 'you' };
  }

  // Any other explicit mode wins too — except for a plain question. Pinning
  // /plan and then asking "what model did you use?" should not run explore and
  // plan stages to answer it. Narrowing to chat is always safe; widening is not.
  if (sticky) {
    if (asking) return { mode: 'chat', rung: rungAt(hard ? 1 : 0), why: 'question', by: 'rules' };
    // The operator named the mode; that is a label, not a guess.
    return { mode: sticky, rung: rungFor(sticky, hard), why: 'pinned', by: 'you' };
  }

  if (asking) {
    return { mode: 'chat', rung: rungAt(hard ? 1 : 0), why: 'question', by: 'rules' };
  }

  if (BROKEN.test(request) || hardBug) {
    return {
      mode: 'fix',
      rung: rungFor('fix', hard),
      why: hardBug && !BROKEN.test(request) ? 'hard failure mode' : 'describes something broken',
      by: 'rules',
    };
  }

  // A mechanical noun beats a weak verb: "add a docstring" is an edit, while
  // "implement a docs endpoint" is genuinely new work.
  if (TRIVIAL.test(request) && !BUILDING_STRONG.test(request)) {
    return { mode: 'do', rung: rungAt(0), why: 'mechanical edit', by: 'rules' };
  }

  if (BUILDING.test(request)) {
    return { mode: 'feature', rung: rungFor('feature', hard), why: 'new capability', by: 'rules' };
  }

  // Tidying is an edit, not an investigation — but a big one earns a plan first.
  if (CLEANUP.test(request)) {
    return hard
      ? { mode: 'feature', rung: rungFor('feature', true), why: 'large cleanup', by: 'rules' }
      : { mode: 'do', rung: rungAt(1), why: 'cleanup', by: 'rules' };
  }

  // Restructuring work with no other signal still deserves a plan, not a guess.
  if (hard) {
    return { mode: 'feature', rung: rungFor('feature', true), why: 'large change', by: 'rules' };
  }

  return null;
}

/** Base rung per mode: cheap for edits, a step up for reasoning-heavy work. */
function rungFor(mode: Mode, hard: boolean): Rung {
  if (hard) return rungAt(2);
  switch (mode) {
    case 'do':
      return rungAt(0);
    case 'chat':
      return rungAt(0);
    // Reading what a search returned is retrieval, not reasoning; the cost
    // that matters here is the fetched pages, not the tier.
    case 'research':
      return rungAt(0);
    default:
      return rungAt(1);
  }
}

/** The one-shot prompt used when rules cannot decide. Deliberately tiny. */
export const CLASSIFY_PROMPT = (input: string) =>
  `Classify this developer request.
"${input}"
mode: chat (a question, no code change), do (small mechanical edit), fix (something is broken), feature (new capability).
complexity: trivial, moderate, or hard.
JSON only.`;

export const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    mode: { type: 'string', enum: ['chat', 'do', 'fix', 'feature'] },
    complexity: { type: 'string', enum: ['trivial', 'moderate', 'hard'] },
  },
  required: ['mode', 'complexity'],
  additionalProperties: false,
} as const;

/** Maps a classifier answer onto the ladder. Never above rung 3 from a guess. */
export function intentFromClassifier(
  mode: Mode,
  complexity: string,
  by: 'classifier' | 'local' = 'classifier',
): Intent {
  const rung =
    complexity === 'hard'
      ? rungAt(mode === 'do' ? 1 : 3)
      : complexity === 'moderate'
        ? rungAt(1)
        : rungAt(0);
  // `local` and `classifier` reach the same conclusion by very different means
  // — one is free and offline, the other is a model call — and a routing log
  // that could not tell them apart would hide which one to improve.
  return { mode, rung, why: complexity, by };
}

