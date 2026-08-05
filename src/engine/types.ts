/**
 * The provider seam.
 *
 * Workflows and the router speak only this interface, so a second provider
 * (GitHub Copilot models, a local runner, anything else) is a new file in this
 * directory rather than a change to the harness. Nothing above this layer may
 * import a provider SDK or name a concrete model.
 */

import type { AvailableModel } from './availability.ts';
import type { CostUnit, Rung, StageResult, Tier } from '../types.ts';

/** Built-in capabilities a stage may be granted. Providers map these to their own tools. */
export type Capability = 'read' | 'search' | 'edit' | 'git' | 'web';

/** A tool call the harness may veto. Returning a string denies it with that reason. */
export type ToolGate = (toolName: string, input: Record<string, unknown>) => string | null;

/**
 * Live activity, so the user can watch a stage work. These carry no extra token
 * cost — they are already flowing through the provider stream.
 */
export type StageEvent =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tool'; readonly tool: string; readonly detail: string }
  | { readonly kind: 'denied'; readonly tool: string; readonly reason: string }
  | { readonly kind: 'thinking' };

export type EventSink = (event: StageEvent) => void;

export interface StageRequest {
  /** Short identifier used in the ledger and logs, e.g. "evidence". */
  readonly stage: string;
  /** The fully rendered instruction for this stage. */
  readonly prompt: string;
  /** Prepended verbatim as the system prompt. Kept tiny on purpose. */
  readonly systemPrompt: string;
  readonly rung: Rung;
  /**
   * The concrete model the harness picked, when it had grounds to pick one.
   *
   * Absent where the catalogue does not describe this provider, in which case
   * the engine falls back to its own {@link Engine.modelFor}. Present, it is
   * authoritative: routing has already established that this model is reachable
   * on this account, can do what the stage needs, and is not made pointless by
   * something cheaper — none of which the engine is in a position to know.
   */
  readonly model?: string;
  readonly capabilities: readonly Capability[];
  /** Where the work happens. */
  readonly cwd: string;
  readonly maxTurns: number;
  /**
   * A spending ceiling, when the caller wants one.
   *
   * Optional because the useful bound on a stage is `maxTurns` — how much it
   * may do — rather than how much it may spend. A schema-answering stage cut
   * off part-way returns nothing at all, so a money cap does not buy a cheaper
   * answer, it buys no answer plus everything already spent.
   *
   * Denominated in the engine's own {@link Engine.costUnit}, so a caller that
   * hardcodes a number is expressing it in whatever the routed provider bills
   * in. Callers that mean dollars should say so where the provider is chosen.
   */
  readonly maxBudget?: number;
  /** Vetoes a tool call before it runs. Enforces read-only stages and path confinement. */
  readonly gate?: ToolGate;
  /** When set, the provider must return a final answer validating against this JSON Schema. */
  readonly outputSchema?: Record<string, unknown>;
  /** Receives live activity as the stage runs. */
  readonly onEvent?: EventSink;
}

export interface Engine {
  /** Identifier for logs and the ledger, e.g. "claude". */
  readonly name: string;
  /**
   * What this provider's cost figures mean.
   *
   * Declared by the provider rather than assumed by the harness, because the
   * assumption is not portable: Anthropic returns dollars, and Copilot charges
   * against a premium-request allowance. Everything above this layer formats a
   * cost through the unit rather than hardcoding a currency.
   */
  readonly costUnit: CostUnit;
  /**
   * Whether this provider can constrain a final answer to a JSON Schema.
   *
   * A capability rather than a quality: a stage that answers in a schema either
   * gets a validated object back or gets nothing useful, so this decides
   * whether a provider can run that stage at all. Providers without it can
   * often be made to comply by other means — a tool the model must call to
   * submit its answer — but that is the provider's business to arrange, and
   * one that has not arranged it says so here.
   */
  readonly supportsOutputSchema: boolean;
  /** The concrete model this provider uses for a tier — for display and cost attribution. */
  modelFor(tier: Tier): string;
  /** Whether this provider honours an explicit effort setting at the given tier. */
  supportsEffort(tier: Tier): boolean;
  /** Runs one stage to completion. Must never prompt interactively. */
  runStage(req: StageRequest): Promise<StageResult>;
  /**
   * Which of this provider's models the current account may actually use.
   *
   * Optional because not every provider can be asked. Copilot returns a policy
   * state per model, so an organisation's disabled list is knowable before a
   * call is made. Anthropic publishes no such endpoint, so its engine omits
   * this and the catalogue is taken at face value — a key that works reaches
   * every model it lists, and a key that does not fails on the first call
   * either way.
   */
  availableModels?(): Promise<readonly AvailableModel[]>;
  /**
   * Exact token count for a piece of text, under this provider's own tokenizer.
   *
   * Optional because it is a measurement tool rather than part of running a
   * task: it exists so an encoding can be compared in tokens instead of in
   * characters, which is not a reliable proxy for them. Providers without a
   * counting endpoint simply omit it.
   */
  countTokens?(text: string): Promise<number>;
}
