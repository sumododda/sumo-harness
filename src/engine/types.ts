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
  /**
   * True when the harness already ran the web search and put the results in the
   * prompt, so the provider's own search tool is redundant for this stage.
   *
   * The harness's search is the one that runs: it is the same on every provider,
   * its results are in the prompt before the first turn rather than after a
   * round trip, and it hands over the URLs, which is what makes the citation
   * requirement checkable rather than merely requested. A hosted search is the
   * fallback for when it could not run at all — no `ddgr`, no network — and this
   * flag is how an engine tells those two cases apart.
   *
   * Fetch is unaffected either way. Whichever search found the URLs, something
   * still has to go and read the pages.
   */
  readonly searched?: boolean;
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
   * What the model catalogue calls this provider, when that differs from
   * {@link name}.
   *
   * models.dev keys Anthropic's models under `anthropic`; this harness has
   * always called that provider `claude`, in the banner, the ledger and
   * `--provider`. Those are both good names and neither is wrong — but the
   * catalogue is looked up by string, so the mismatch meant `modelsFor('claude')`
   * returned nothing, every time, silently.
   *
   * The effect was invisible while every fleet held one provider: an engine the
   * catalogue cannot describe falls back to choosing its own model, which is
   * what it did, correctly. It stops being invisible the moment a second
   * provider joins. A provider with no catalogue entries contributes nothing to
   * the pool, and the pool is what routing ranks — so Anthropic could not win a
   * stage it was better at, or lose one it was worse at. It was not in the
   * comparison at all, and Copilot would have taken every stage the fleet did
   * not reserve for a schema.
   */
  readonly catalogName?: string;
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
  /**
   * Whether this provider has arranged a schema answer by other means, when it
   * cannot guarantee one.
   *
   * The distinction is the whole point. {@link supportsOutputSchema} means the
   * provider will not return anything that fails the schema; this means it will
   * *try* — typically by handing the model a tool carrying the schema and
   * telling it to call it, which the runtime validates but the model may
   * decline to use.
   *
   * Routing prefers a guarantee wherever one is available and never downgrades
   * to an attempt while a guarantee is in the fleet. But an attempt is worth far
   * more than the alternative when it is all there is: before this existed, a
   * Copilot-only fleet refused every staged workflow outright — `feature`,
   * `fix` and `plan` all died at the first stage — while the tool that would
   * have answered them sat implemented and unreachable in `copilot.ts`.
   *
   * A stage that asks and gets nothing back already has a path: the engine
   * reports `stopped: 'error'` and the workflow stops without gating on an
   * answer it did not get.
   */
  readonly attemptsOutputSchema?: boolean;
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
