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
   * Default off, and the only optimisation here that is.
   *
   * Every other flag changes what a stage is *given*, so getting one wrong
   * costs tokens. This one changes what a stage is *allowed to find out*, so
   * getting it wrong costs an answer — and the two are not the same size. A few
   * extra searches are worth fractions of a cent; a plan written without
   * understanding the code is a whole workflow, plus the operator's time
   * catching it. Optimising the cheap failure at the risk of the expensive one
   * is the wrong trade for a harness that otherwise refuses to guess.
   *
   * There is also no way for a stage to say it needs more. It is refused and
   * carries on with less, quietly, which is exactly the shape of mistake the
   * gates elsewhere exist to prevent.
   *
   * Kept rather than deleted because it is a real hypothesis and now a testable
   * one: `sumo bench --configs gated,throttled` prices it. Turn it on when that
   * comparison says it pays.
   */
  readonly searchThrottle: boolean;
  /**
   * Choose the pack's files by split-identifier BM25 rather than exact match.
   *
   * The one flag here that shipped with its measurement already taken:
   * recall@10 for the files a commit actually changed went 50.0% → 56.5% on
   * VS Code and 55.6% → 65.4% on excalidraw. See `src/context/lexical.ts` for
   * the method and `scripts/retrieval-eval.ts` to reproduce it.
   */
  readonly lexicalRanker: boolean;
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
  escalationJudge: true,
  lexicalRanker: true,
  // Off, even here. See the flag's own note: it is the one optimisation whose
  // failure mode is a worse answer rather than a larger bill.
  searchThrottle: false,
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
  escalationJudge: false,
  lexicalRanker: false,
  searchThrottle: false,
};

let current: Features = ALL_ON;

export function get(): Features {
  return current;
}

export function set(partial: Partial<Features>): void {
  current = { ...current, ...partial };
}

