/**
 * What to do when the harness has run the tests and they did not pass.
 *
 * Escalation is driven by an objective verifier rather than a guess about
 * difficulty. That ordering matters: predicting which model a task needs is
 * unreliable, but a failing test is a fact.
 *
 * The retry budget is deliberately small. With roughly a fivefold price spread
 * between the cheapest and dearest tiers, three failed cheap attempts cost more
 * than one clean expensive pass — so the ladder retries once per rung and climbs
 * at most twice before handing the problem back.
 */

import { describeRung, LADDER, type Rung, rungAt } from './types.ts';

export const MAX_ESCALATIONS = 2;
const RETRIES_PER_RUNG = 1;

export interface LadderState {
  /** Index into LADDER. */
  readonly rung: number;
  /** Attempts already made at this rung after the first. */
  readonly retries: number;
  /** How many times the ladder has climbed. */
  readonly escalations: number;
}

export function startAt(rung: Rung): LadderState {
  const index = LADDER.findIndex((r) => r.tier === rung.tier && r.effort === rung.effort);
  return { rung: index >= 0 ? index : 1, retries: 0, escalations: 0 };
}

export type NextStep =
  | {
      readonly kind: 'retry';
      readonly state: LadderState;
      readonly rung: Rung;
      /** True when the rung changed, which means re-planning is worthwhile. */
      readonly climbed: boolean;
      readonly why: string;
    }
  | { readonly kind: 'giveUp'; readonly why: string };

/**
 * Decides what happens after a failed verification.
 *
 * A same-rung retry is worth one attempt because failures are often a detail
 * the model can see once the failing output is in front of it. Beyond that,
 * repeating the same attempt is just paying twice for the same answer, so the
 * ladder climbs — and a climb that crosses into a new tier is worth re-planning,
 * not merely re-implementing.
 *
 * `verdict` is an optional, cheap second opinion from src/workflows/fix.ts's
 * judge stage on whether this specific failure looks fixable with another try
 * or looks like the current approach/model can't do this. Omitted (or
 * `nearMiss`) reproduces today's behaviour exactly — a caller that never
 * passes it cannot tell this parameter exists.
 */
export function afterFailure(state: LadderState, verdict?: 'nearMiss' | 'capabilityFailure'): NextStep {
  const confidentFailure = verdict === 'capabilityFailure';

  // A same-rung retry is skipped outright on a confident capability failure:
  // that kind of failure is not the detail-in-front-of-it fix a retry is for,
  // so paying for one when the judge already expects it not to help is the
  // exact cost asking the judge exists to avoid.
  if (state.retries < RETRIES_PER_RUNG && !confidentFailure) {
    return {
      kind: 'retry',
      state: { ...state, retries: state.retries + 1 },
      rung: rungAt(state.rung),
      climbed: false,
      why: 'retrying with the failing output in hand',
    };
  }

  if (state.escalations >= MAX_ESCALATIONS) {
    return {
      kind: 'giveUp',
      why: `still failing after ${MAX_ESCALATIONS} escalations`,
    };
  }

  const from = rungAt(state.rung);
  // The ladder's very next rung is sometimes just more effort at the same
  // tier (mid/low → mid/high, large/medium → large/high) — a move a confident
  // capability failure has no reason to expect will help either. Skip past it
  // to the rung beyond, which is guaranteed to be a genuine tier change,
  // rather than spending the ladder's one remaining move landing somewhere
  // the judge already doubts.
  const skip = confidentFailure && rungAt(state.rung + 1).tier === from.tier;
  const next = state.rung + (skip ? 2 : 1);
  if (next >= LADDER.length) {
    return { kind: 'giveUp', why: 'already at the strongest setting' };
  }

  const to = rungAt(next);

  return {
    kind: 'retry',
    // One escalation, whether the climb moved one rung or two.
    state: { rung: next, retries: 0, escalations: state.escalations + 1 },
    rung: to,
    // A tier change means a different model, whose take on the plan may differ.
    climbed: to.tier !== from.tier,
    why:
      to.tier === from.tier
        ? `thinking harder (${from.effort ?? 'none'} → ${to.effort ?? 'none'})`
        : skip
          ? `stepping up to ${to.tier}, skipping the ${describeRung(rungAt(state.rung + 1))} rung`
          : `stepping up to ${to.tier}`,
  };
}
