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
}

const ALL_ON: Features = {
  cache: true,
  index: true,
  gatedRetrieval: true,
  deltaRetries: true,
  targetedEdits: true,
  skeletonContext: true,
  cleanRetries: true,
};

export const ALL_OFF: Features = {
  cache: false,
  index: false,
  gatedRetrieval: false,
  deltaRetries: false,
  targetedEdits: false,
  skeletonContext: false,
  cleanRetries: false,
};

let current: Features = ALL_ON;

export function get(): Features {
  return current;
}

export function set(partial: Partial<Features>): void {
  current = { ...current, ...partial };
}

