/**
 * The provider seam.
 *
 * Workflows and the router speak only this interface, so a second provider
 * (GitHub Copilot models, a local runner, anything else) is a new file in this
 * directory rather than a change to the harness. Nothing above this layer may
 * import a provider SDK or name a concrete model.
 */

import type { Rung, StageResult, Tier } from '../types.ts';

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
   */
  readonly maxBudgetUsd?: number;
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
  /** The concrete model this provider uses for a tier — for display and cost attribution. */
  modelFor(tier: Tier): string;
  /** Whether this provider honours an explicit effort setting at the given tier. */
  supportsEffort(tier: Tier): boolean;
  /** Runs one stage to completion. Must never prompt interactively. */
  runStage(req: StageRequest): Promise<StageResult>;
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
