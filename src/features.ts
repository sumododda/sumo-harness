/**
 * The optimisations that can be switched off.
 *
 * Each of these claims to save tokens without costing correctness. A claim like
 * that is worth nothing unless it can be turned off and measured, so every one
 * of them is a flag here and `sumo bench` runs the same tasks with different
 * combinations. They default to on; switching them all off is the baseline the
 * savings are quoted against.
 */

export interface Features {
  /** Reuse the answer to an identical read-only stage. */
  readonly cache: boolean;
  /** Consult the code index at all. */
  readonly index: boolean;
  /** Skip the index lookup when it cannot pay for itself. */
  readonly gatedRetrieval: boolean;
  /** Send failing tests as a table of assertions rather than as a raw log. */
  readonly deltaRetries: boolean;
  /** Prefer a targeted edit over rewriting a whole file. */
  readonly targetedEdits: boolean;
  /** Give survey stages symbol skeletons of their candidate files, ahead of full bodies. */
  readonly skeletonContext: boolean;
  /** Revert a retry's own changes before the next attempt, so it starts from a clean tree. */
  readonly cleanRetries: boolean;
  /** Grant every stage the same tool list, so a provider's prefix cache survives stage to stage. */
  readonly stableToolList: boolean;
  /** When `fix` has a confirmed repro test, sample a second independent candidate before retrying. */
  readonly candidateSampling: boolean;
  /** Ask a cheap judge whether a failed rung-attempt is a near miss or a capability failure, before escalating. */
  readonly escalationJudge: boolean;
  /**
   * Refuse text searches past a per-stage allowance once the index has spoken.
   *
   * A flag because it is an optimisation and every optimisation here is a claim
   * that has to survive `sumo bench`. This one was the exception for a while,
   * which is how it stayed unmeasured while being the only one that refuses the
   * model something it asked for — the rest merely change what it is given.
   */
  readonly searchThrottle: boolean;
}

const ALL_ON: Features = {
  cache: true,
  index: true,
  gatedRetrieval: true,
  deltaRetries: true,
  targetedEdits: true,
  skeletonContext: true,
  cleanRetries: true,
  stableToolList: true,
  candidateSampling: true,
  escalationJudge: true, searchThrottle: true,
};

export const ALL_OFF: Features = {
  cache: false,
  index: false,
  gatedRetrieval: false,
  deltaRetries: false,
  targetedEdits: false,
  skeletonContext: false,
  cleanRetries: false,
  stableToolList: false,
  candidateSampling: false,
  escalationJudge: false, searchThrottle: false,
};

let current: Features = ALL_ON;

export function get(): Features {
  return current;
}

export function set(partial: Partial<Features>): void {
  current = { ...current, ...partial };
}

