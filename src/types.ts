/**
 * Shared vocabulary. Deliberately provider-neutral: nothing here names a
 * concrete model. Providers (see src/engine/) map tiers to their own model IDs,
 * so adding GitHub Copilot models later touches only an engine implementation.
 */

/** Capability tier, cheapest first. Providers resolve these to real models. */
export type Tier = 'small' | 'mid' | 'large';

/** How hard the model should think. Omitted where a model has no such control. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh';

/**
 * What one unit of a provider's cost figure actually means.
 *
 * Not every provider bills in money. Anthropic prices a request in dollars;
 * GitHub Copilot charges it against a premium-request allowance, so its
 * numbers are credits and printing them with a `$` in front would be a lie
 * rather than a rounding error. A cost is therefore never just a number here —
 * it travels with the unit that makes it mean something.
 */
export type CostUnit = 'usd' | 'credits';

/**
 * A cost total, and what it is a total of.
 *
 * Costs are summed per unit rather than into one number, because dollars and
 * credits do not add up. A task routed entirely to one provider produces a
 * single entry; one that spreads across providers produces several, and the
 * harness shows each rather than inventing an exchange rate it has no basis for.
 */
export interface CostTotal {
  readonly unit: CostUnit;
  readonly amount: number;
}

/** A rung on the escalation ladder: capability tier plus thinking depth. */
export interface Rung {
  readonly tier: Tier;
  readonly effort?: Effort;
}

/**
 * The escalation ladder, cheapest first. Effort bumps come before tier jumps
 * because raising thinking depth costs far less than moving up a model class.
 */
export const LADDER: readonly Rung[] = [
  { tier: 'small' },
  { tier: 'mid', effort: 'low' },
  { tier: 'mid', effort: 'high' },
  { tier: 'large', effort: 'medium' },
  { tier: 'large', effort: 'high' },
];

export function rungAt(n: number): Rung {
  const clamped = Math.max(0, Math.min(n, LADDER.length - 1));
  return LADDER[clamped]!;
}

export function describeRung(r: Rung): string {
  return r.effort ? `${r.tier}/${r.effort}` : r.tier;
}

/** What one stage cost and produced. Provider-neutral by design. */
export interface StageResult<T = string> {
  readonly stage: string;
  readonly output: T;
  readonly cost: number;
  /**
   * What `cost` and `saved` are denominated in.
   *
   * Carried per row rather than inferred from the session, because a harness
   * that routes each stage to whichever provider suits it will put dollars and
   * credits in the same ledger. A row that knows its own unit stays readable
   * whatever ran next to it.
   */
  readonly costUnit: CostUnit;
  readonly turns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly rung: Rung;
  /** The concrete model the provider actually used, for the ledger. */
  readonly model: string;
  /**
   * Which provider ran this stage.
   *
   * Recorded per row so a task spread across providers can be read back — and
   * so `sumo bench --provider x` has something to compare. One field is the
   * whole cost of being able to answer "is this tier better served elsewhere?"
   * from measurement rather than from argument.
   */
  readonly provider: string;
  /** Provider-issued conversation handle, if the provider has one. */
  readonly sessionId?: string;
  /** True when this was replayed from cache: no model ran, and cost is zero. */
  readonly cached?: boolean;
  /** What the original call cost, on a cached row. This is the saving. */
  readonly saved?: number;
  /** Which attempt this was within a workflow. 0 is the first try. */
  readonly attempt?: number;
  /** Estimated share of the input, so a growing prompt can be attributed. */
  readonly composition?: PromptComposition;
  /** Edits the gate allowed, by kind. Shows which edit format was actually used. */
  readonly writeTools?: { readonly edit: number; readonly write: number };
  /** Set when the stage ended for a reason other than finishing its work. */
  readonly stopped?: 'budget' | 'turns' | 'error';
  /** Tool calls the permission gate refused — read-only enforcement is proven here. */
  readonly denials: readonly string[];
}

/**
 * Where a stage's input tokens came from.
 *
 * Estimated rather than measured: an exact count costs a round trip, and these
 * exist to answer "is the index pack earning its place", which a rough share
 * answers just as well.
 */
export interface PromptComposition {
  readonly system: number;
  readonly prompt: number;
  /** The part of `prompt` that came from the code index, when one supplied it. */
  readonly pack: number;
}

/** Thrown for conditions the user can act on. Carries next steps, AXI-style. */
export class SumoError extends Error {
  readonly code: string;
  readonly suggestions: readonly string[];

  constructor(message: string, code: string, suggestions: readonly string[] = []) {
    super(message);
    this.name = 'SumoError';
    this.code = code;
    this.suggestions = suggestions;
  }
}
