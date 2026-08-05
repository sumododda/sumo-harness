/**
 * Which provider runs a stage.
 *
 * The harness already decides *how hard* to think — that is the router's job,
 * and it answers from the prompt (see `route/local.ts`). This decides *whose
 * model* thinks, and deliberately answers from something else entirely.
 *
 * Provider choice is not a prompt-difficulty question, and treating it as one
 * would be fitting noise. Two providers frequently serve the same weights — at
 * the small tier both Anthropic and Copilot carry Haiku 4.5 — so asking a
 * classifier which produces the better answer is asking which of two routes to
 * one model is better. What actually separates them is none of it in the text:
 *
 *   - capability — one provider can constrain a final answer to a JSON Schema
 *     and the other cannot, which decides correctness rather than quality;
 *   - billing — a prepaid allowance and a metered per-token bill do not convert
 *     into each other, which is why the ledger keeps them apart;
 *   - availability — whether a credential exists at all.
 *
 * So this is a deterministic policy over facts the harness already holds, not a
 * model. Whether a *tier* is better served by one provider than the other is a
 * real question, but it is answered by measurement — `sumo bench --provider x`
 * over the fixtures — and not by prediction.
 */

import {
  acceptsEffort,
  candidates,
  canSchema,
  modelsFor,
  type ModelSpec,
  undominated,
} from './catalog.ts';
import { usable } from './availability.ts';
import { ruledOut, score, workOf } from './aptitude.ts';
import type { Capability, Engine } from './types.ts';
import { type Effort, SumoError, type Tier } from '../types.ts';

/** What a stage needs, as far as choosing a provider is concerned. */
export interface StageNeed {
  readonly tier: Tier;
  /**
   * The stage's name, which says what kind of work it is.
   *
   * Used only to rule out models judged unfit for that work, and to break ties
   * between models nothing else separates — see `aptitude.ts`. Optional, so a
   * caller with no stage in hand still routes.
   */
  readonly stage?: string;
  /** The rung's effort, when it asked for one. Models that cannot take it are skipped. */
  readonly effort?: Effort;
  /** True when the stage must return an answer validating against a schema. */
  readonly needsSchema: boolean;
  readonly capabilities: readonly Capability[];
}

/** One model, and the engine that can reach it. */
interface Offer {
  readonly engine: Engine;
  readonly model: ModelSpec;
}

/** A provider and model choice, and what decided it. */
export interface Routed {
  readonly engine: Engine;
  /**
   * The chosen model, or null when the catalogue has nothing to say about this
   * provider and the engine's own `modelFor` should decide.
   *
   * Null rather than a guess: a provider absent from the catalogue is one whose
   * models are unknown, and inventing an id would fail at the provider rather
   * than here, where the reason is still legible.
   */
  readonly model: ModelSpec | null;
  /** Why this provider and model, for the routing log — never left to be inferred. */
  readonly why: string;
}

/**
 * A preferred provider per tier.
 *
 * Expressed per tier rather than per stage because tier is already the axis the
 * harness reasons about spend on, and because a provider's allowance is spent
 * by volume: the small tier is most of the calls, so moving it is most of the
 * saving.
 */
export type TierPolicy = Partial<Record<Tier, string>>;

/**
 * Reads the tier policy from the environment.
 *
 * Environment rather than a config file because it is a deployment fact — which
 * accounts this machine has — rather than a property of the repository, and
 * because it has to be overridable for one `sumo bench` run without editing
 * anything that a later run would inherit.
 */
export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): TierPolicy {
  const policy: TierPolicy = {};
  for (const tier of ['small', 'mid', 'large'] as const) {
    const name = env[`SUMO_ROUTE_${tier.toUpperCase()}`];
    if (name) policy[tier] = name;
  }
  return policy;
}

/**
 * The providers this harness may route to, and the policy over them.
 *
 * Holds engines rather than provider names so that constructing one — which is
 * where a missing credential or an unusable SDK surfaces — happens once at
 * startup rather than in the middle of a task.
 */
export class Fleet {
  private readonly engines: readonly Engine[];
  private readonly policy: TierPolicy;
  /** Where the availability probe is cached. */
  private readonly root: string;

  constructor(engines: readonly Engine[], policy: TierPolicy = {}, root: string = process.cwd()) {
    if (engines.length === 0) {
      throw new SumoError('A fleet needs at least one provider.', 'empty_fleet', [
        'This is a harness bug — getEngine() should have thrown first.',
      ]);
    }
    this.engines = engines;
    this.policy = policy;
    this.root = root;
  }

  /** A fleet of exactly one provider: the harness's behaviour before routing. */
  static of(engine: Engine): Fleet {
    return new Fleet([engine]);
  }

  /** Every provider in the fleet, for `/routing` to report. */
  get providers(): readonly string[] {
    return this.engines.map((e) => e.name);
  }

  /**
   * The provider and model for a stage.
   *
   * The gates run in a fixed order, and the order is load-bearing:
   *
   *   1. reachable — what this account may actually call;
   *   2. capable   — what can answer *this* stage, schema and effort included;
   *   3. undominated — what is not made pointless by something else here;
   *   4. preference — which of the survivors, when more than one is left.
   *
   * Availability comes before dominance rather than after, which is the part
   * that is easy to get backwards. `claude-opus-5` dominates `claude-opus-4.6`
   * on price and recency — but if opus-5 is disabled by an organisation policy,
   * opus-4.6 was a perfectly good answer, and pruning first would have thrown it
   * away in favour of something that cannot be called.
   */
  async for(need: StageNeed): Promise<Routed> {
    // A guarantee wherever one exists, an attempt only when none does. Falling
    // back rather than throwing is what makes a Copilot-only fleet able to run
    // a staged workflow at all; putting the fallback *below* the guarantee is
    // what stops a mixed fleet from ever choosing the weaker promise.
    const guaranteed = this.engines.filter((e) => e.supportsOutputSchema);
    const attempting = this.engines.filter((e) => e.attemptsOutputSchema === true);

    const capableEngines = !need.needsSchema
      ? this.engines
      : guaranteed.length > 0
        ? guaranteed
        : attempting;

    // Schema support is a property of the model as well as the provider, and
    // only a provider that guarantees one has a model-level guarantee to check.
    // Holding an attempting engine to it would filter away every model it has
    // and land back at the failure this fallback exists to prevent.
    const requireSchemaModels = need.needsSchema && guaranteed.length > 0;

    if (capableEngines.length === 0) {
      throw new SumoError(
        `No provider can answer a schema-constrained stage.`,
        'no_capable_provider',
        [`Providers in this fleet: ${this.providers.join(', ')}`],
      );
    }

    // One pool, not one provider at a time. A model is a model; which account
    // happens to serve it is an implementation detail of reaching it, and
    // picking a provider first would settle the important question — which
    // model — as a side effect of the unimportant one.
    const pool: Offer[] = [];
    /** Engines offering something the catalogue cannot describe. See {@link offersFrom}. */
    const blind: Engine[] = [];

    for (const engine of capableEngines) {
      const offers = await this.offersFrom(engine, need, requireSchemaModels);
      if (offers === null) blind.push(engine);
      else pool.push(...offers);
    }

    const preferred = this.policy[need.tier];

    if (pool.length > 0) {
      // Dominance runs across the whole pool, so a model beaten by something on
      // another provider is dropped just as readily as by one on its own.
      const survivors = undominated(pool.map((o) => o.model));
      const kept = pool.filter((o) => survivors.some((m) => m.id === o.model.id));

      // Among models nothing else beats, the tie is settled by preference and
      // then by price — never left to array order, which would make routing
      // depend on the order engines were constructed in.
      // The last key is the provider name, and it is not decoration. The same
      // model id is often reachable through more than one account —
      // `claude-sonnet-5` is on both at the same price — so price and id alone
      // leave a genuine tie, and without a deterministic final key the winner
      // would be whichever engine happened to be constructed first.
      // Aptitude sits below the operator's own preference and above price. It
      // orders only models that already survived dominance, so a judgement can
      // break a tie but never overrule a fact.
      const work = workOf(need.stage ?? '');
      const best = [...kept].sort(
        (a, b) =>
          Number(b.engine.name === preferred) - Number(a.engine.name === preferred) ||
          score(b.model, work) - score(a.model, work) ||
          a.model.outputPerMtok - b.model.outputPerMtok ||
          a.model.id.localeCompare(b.model.id) ||
          a.engine.name.localeCompare(b.engine.name),
      )[0]!;

      // A preference that did not happen is the one routing decision most worth
      // saying out loud: it is the difference between the harness disagreeing
      // and the account simply not offering anything. Silence there reads as
      // the policy having been honoured.
      const unmet =
        preferred !== undefined && best.engine.name !== preferred
          ? ` · ${preferred} offered nothing for this stage`
          : '';
      const why =
        `${best.engine.name}/${best.model.id}` +
        (best.engine.name === preferred ? ' by policy' : '') +
        (kept.length > 1 ? ` (best of ${String(kept.length)})` : '') +
        unmet;
      return { engine: best.engine, model: best.model, why };
    }

    if (blind.length > 0) {
      const engine = blind.find((e) => e.name === preferred) ?? blind[0]!;
      return { engine, model: null, why: `${engine.name} chooses its own model` };
    }

    throw new SumoError(
      `No usable model for a ${need.tier} stage.`,
      'no_usable_model',
      [
        'Every catalogued model was unreachable, disabled, or unable to do what',
        'this stage needs. Check `/routing` for what each provider reported.',
      ],
    );
  }

  /**
   * What one engine brings to the pool: every model of its that could run this
   * stage, or `null` when it offers something the catalogue cannot describe.
   *
   * Null is not "nothing". An account may offer entries no model database
   * lists — a Copilot plan without premium requests offers exactly one, `auto`,
   * which is GitHub's own router rather than a model. Nothing here can reason
   * about it, so it is set aside and used only if the pool comes back empty.
   *
   * An empty array *is* "nothing", and means something different: the account
   * offers models the catalogue knows perfectly well, none of which suit this
   * stage. That is a trustworthy no, and the engine simply contributes nothing.
   */
  private async offersFrom(
    engine: Engine,
    need: StageNeed,
    requireSchemaModels: boolean,
  ): Promise<Offer[] | null> {
    // The catalogue's own spelling for this provider, which is not always the
    // harness's — see `Engine.catalogName`. Looking it up by the wrong one
    // returns nothing and is indistinguishable from a provider the catalogue
    // genuinely does not describe.
    const catalogued = engine.catalogName ?? engine.name;

    const known = modelsFor(catalogued);
    if (known.length === 0) return null;

    const reachable = await usable(engine, this.root);

    // Reachable, but nothing reachable is catalogued — the `auto` case. There
    // is a usable provider here and no way to reason about what it will run.
    if (reachable !== null && reachable.size > 0 && !known.some((m) => reachable.has(m.id))) {
      return null;
    }

    return candidates(catalogued, need.tier)
      .filter((m) => reachable === null || reachable.has(m.id))
      .filter((m) => !requireSchemaModels || canSchema(m))
      // An effort the model does not accept is not a smaller request, it is an
      // invalid one — so a rung asking for effort routes only at models offering
      // it. A rung with no effort at all is satisfied by anything.
      .filter((m) => need.effort === undefined || acceptsEffort(m, need.effort))
      // A family judged unfit for this kind of work is removed rather than
      // ranked last: `avoid` means the output would be unusable, which costs a
      // whole stage and a retry rather than a little quality.
      .filter((m) => !ruledOut(m, workOf(need.stage ?? '')))
      .map((model) => ({ engine, model }));
  }
}
