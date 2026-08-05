/**
 * What each model family is good at, by the kind of work a stage does.
 *
 * Everything else routing uses is a fact: price, context, capabilities,
 * entitlement. This is the one judgement, and it exists because the fact-based
 * signals run out. Once a tier's models are filtered to what this account can
 * reach and pruned of anything strictly dominated, one to two remain — and
 * price cannot separate them, because price is what put them in the same tier.
 *
 * There is no free machine-readable source for the missing signal. models.dev
 * publishes no benchmark scores and says so; llm-stats has no public API;
 * Artificial Analysis gates theirs behind a key. So this is hand-written, which
 * makes two things important:
 *
 *   - **It is keyed on family, not model id.** `claude-opus-5` and
 *     `claude-opus-4.6` are both `claude-opus`, so a model released tomorrow
 *     inherits its family's aptitude rather than falling through to nothing.
 *     Aptitude is a property of a lab's line, and lines move slowly; model ids
 *     move every few weeks. Keying on ids is what makes a table like this rot.
 *   - **It is a prior, not a verdict.** It breaks ties between models nothing
 *     else can separate. It cannot promote a model that something dominates,
 *     and it cannot reach past a tier the router already chose.
 *
 * Absent means neutral. A family nobody has judged is not thereby bad — it
 * simply carries no opinion, and price decides as it did before.
 */

import type { ModelSpec } from './catalog.ts';

/**
 * How well a family suits a kind of work.
 *
 * `avoid` is not a weak preference — it removes the model from consideration
 * for that work entirely, and outranks any saving. It is for the case where a
 * cheap model does not merely do worse but produces something unusable, which
 * costs a whole stage and a retry rather than a little quality.
 */
export type Rating = 'strong' | 'capable' | 'avoid';

/**
 * The kinds of work a stage does.
 *
 * Sumo's own stage names, collapsed to the distinctions that plausibly separate
 * models. Finer than this would be inventing detail nobody has evidence for.
 */
export type Work = 'survey' | 'reason' | 'edit' | 'research' | 'classify';

/**
 * Which kind of work each stage is.
 *
 * Stage names are the harness's real task axis — better defined than guessing a
 * task type from the prompt, because the workflow already knows what it asked
 * for. An unlisted stage is `reason`, the least assuming default.
 */
const WORK: Record<string, Work> = {
  explore: 'survey',
  evidence: 'survey',
  'root-cause': 'reason',
  plan: 'reason',
  judge: 'reason',
  discuss: 'reason',
  implement: 'edit',
  fix: 'edit',
  'write-tests': 'edit',
  do: 'edit',
  research: 'research',
  route: 'classify',
  chat: 'reason',
};

export function workOf(stage: string): Work {
  return WORK[stage] ?? 'reason';
}

/**
 * Aptitude by family. Families come from models.dev, so they match the
 * catalogue exactly and a typo here is a family that never matches anything —
 * which `test/aptitude.test.ts` checks for.
 *
 * The judgements are deliberately sparse. Only differences worth acting on are
 * recorded; where two families are much of a muchness, neither is listed and
 * price decides, which is the honest outcome rather than a coin weighted by
 * whoever wrote this file.
 */
const APTITUDE: Record<string, Partial<Record<Work, Rating>>> = {
  // Anthropic's line is the one this harness was built and measured against.
  'claude-opus': { reason: 'strong', edit: 'strong' },
  'claude-sonnet': { edit: 'strong', reason: 'capable' },
  'claude-haiku': { survey: 'strong', classify: 'strong' },

  // The codex line is tuned for code specifically, per OpenAI's own framing.
  'gpt-codex': { edit: 'strong', reason: 'capable' },
  'gpt-terra': { reason: 'strong', edit: 'capable' },
  'gpt-sol': { reason: 'strong', edit: 'capable' },
  // The small, fast end: fine for reading and sorting, not for writing code.
  'gpt-mini': { survey: 'strong', classify: 'strong', edit: 'avoid' },
  'gpt-nano': { classify: 'strong', edit: 'avoid', reason: 'avoid' },
  'gpt-luna': { survey: 'strong', classify: 'strong' },

  // Long context and cheap, which is what a survey stage actually needs.
  'gemini-flash': { survey: 'strong', classify: 'capable' },
  'gemini-pro': { reason: 'capable', survey: 'strong' },

  'kimi-k2': { edit: 'capable' },
};

/** How well a model suits this work. Unjudged families score neutral. */
export function ratingFor(model: ModelSpec, work: Work): Rating | null {
  return APTITUDE[model.family]?.[work] ?? null;
}

/** Whether this model must not be given this work at all. */
export function ruledOut(model: ModelSpec, work: Work): boolean {
  return ratingFor(model, work) === 'avoid';
}

/**
 * A model's preference weight for this work — higher is better, 0 is neutral.
 *
 * Kept small and ordinal on purpose. This is a tiebreak among models nothing
 * else separates, so the numbers only need to order them; a wider scale would
 * imply a precision the underlying judgement does not have.
 */
export function score(model: ModelSpec, work: Work): number {
  switch (ratingFor(model, work)) {
    case 'strong':
      return 2;
    case 'capable':
      return 1;
    default:
      return 0;
  }
}

/** Every family this file has an opinion about, for tests and `/routing`. */
export function judgedFamilies(): readonly string[] {
  return Object.keys(APTITUDE);
}
