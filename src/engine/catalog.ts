/**
 * What models exist, what they cost, and what they can do.
 *
 * Committed data rather than a hardcoded table, built from models.dev by
 * `scripts/build-catalog.ts`. The difference matters: a table of model IDs and
 * capabilities written by hand is wrong the week after it is written, and wrong
 * silently — a stale `supportsOutputSchema` routes a schema stage at a model
 * that cannot answer it, and the failure surfaces as a confusing empty result
 * rather than as a missing entry.
 *
 * Nothing here is a quality judgement. models.dev is explicitly a metadata
 * database and publishes no benchmark scores, and no free machine-readable
 * source of those exists — llm-stats has no public API and Artificial Analysis
 * gates theirs behind a key. So the one ordering this file offers is **price**,
 * on the reasoning that a lab's own pricing is its own capability estimate:
 * Haiku is cheaper than Opus because it is smaller, not by coincidence. That is
 * a prior and is stated as one. What corrects it is outcomes.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Effort, Tier } from '../types.ts';

export interface ModelSpec {
  readonly id: string;
  readonly name: string;
  /** Upstream's model family, e.g. `claude-opus` — the key aptitude is judged on. */
  readonly family: string;
  /** USD per million output tokens. The signal tiers are cut on. */
  readonly outputPerMtok: number;
  readonly inputPerMtok: number;
  readonly contextWindow: number;
  /** Null where upstream does not say — not the same as false. See {@link canSchema}. */
  readonly structuredOutput: boolean | null;
  readonly toolCall: boolean;
  readonly efforts: readonly string[];
  readonly releaseDate?: string;
}

interface Catalog {
  readonly source: string;
  readonly providers: Record<string, readonly ModelSpec[]>;
}

let cached: Catalog | null = null;

/** The committed snapshot. Read once; it never changes while the process runs. */
export function catalog(): Catalog {
  if (cached) return cached;
  const path = join(import.meta.dirname, '..', '..', 'model', 'catalog.json');
  cached = JSON.parse(readFileSync(path, 'utf8')) as Catalog;
  return cached;
}

/** Every model the catalogue knows for a provider, cheapest first. */
export function modelsFor(provider: string): readonly ModelSpec[] {
  return catalog().providers[provider] ?? [];
}

/** One model by provider and id, or null when the snapshot has never seen it. */
export function lookup(provider: string, id: string): ModelSpec | null {
  return modelsFor(provider).find((m) => m.id === id) ?? null;
}

/**
 * Whether a model may be given a schema-constrained stage.
 *
 * Unknown counts as no. A stage that answers in a schema produces nothing at
 * all when the constraint is not honoured, so guessing yes trades a routing
 * question for a wasted stage — and the harness has no way to tell that failure
 * apart from a model that simply had nothing to say.
 */
export function canSchema(model: ModelSpec): boolean {
  return model.structuredOutput === true;
}

/** Whether a model accepts an effort setting, and this one in particular. */
export function acceptsEffort(model: ModelSpec, effort: Effort): boolean {
  return model.efforts.includes(effort);
}

/**
 * Price boundaries between tiers, in USD per million output tokens.
 *
 * Placed in the gaps of the actual distribution rather than at round numbers,
 * because a cut sitting on a price is fragile: a one-dollar move upstream would
 * flip a model into a neighbouring tier with nothing else to signal it. Across
 * both providers the prices cluster — fast models run $1.20–$9, the middle sits
 * at $10–$15, and every Opus-class model is $25 or more — leaving clean gaps at
 * 9→10 and 15→25 to cut in.
 *
 * A new model therefore lands in the tier its price implies without anyone
 * editing this file, and `test/catalog.test.ts` asserts both that the cuts still
 * fall in gaps and that the three models `claude.ts` names by hand still land
 * where it assumes. Silent re-tiering is exactly the drift committed data is
 * meant to make visible.
 */
export const TIER_CUTS = { smallMax: 9.5, midMax: 20 } as const;

/** The tier a model's price puts it in. */
export function tierOf(model: ModelSpec): Tier {
  if (model.outputPerMtok <= TIER_CUTS.smallMax) return 'small';
  if (model.outputPerMtok <= TIER_CUTS.midMax) return 'mid';
  return 'large';
}

/**
 * A provider's models for one tier, cheapest first.
 *
 * The candidate set a router picks within: the tier is already decided by the
 * prompt, so this is the shortlist that decision leaves open.
 */
export function candidates(provider: string, tier: Tier): readonly ModelSpec[] {
  return modelsFor(provider).filter((m) => tierOf(m) === tier);
}

/**
 * The observable axes a model can be compared on before it has ever run.
 *
 * Deliberately short. Everything here is a fact the catalogue records, and
 * nothing here is a quality claim — there is no benchmark score in the data and
 * no free source of one, so a comparison that needed it would be invented.
 *
 * The context window is the one number the catalogue records that is *not* such
 * a fact, which is why it is not here. An advertised window says what a provider
 * will accept, not what the model can attend to, and the two come apart badly:
 * RULER finds only half of the models claiming 32K still hold up at 32K, and
 * NoLiMa finds eleven of thirteen models claiming 128K fall below half their own
 * short-context score by 32K. Nor is there a better constant to substitute —
 * HELMET finds the task categories correlate too poorly for one number to stand
 * in for the rest. So an axis reading `m.contextWindow` would rank models by a
 * marketing figure and call it an observation. The window survives as catalogue
 * data, and `context/budget.ts` reads it as a cap; it just does not order
 * anything.
 */
function axes(m: ModelSpec): readonly [number, number, number] {
  return [
    -m.outputPerMtok, // cheaper is better
    m.structuredOutput === true ? 1 : 0,
    m.efforts.length, // more control is better, or at least never worse
  ];
}

/**
 * Whether `a` makes `b` pointless.
 *
 * Standard Pareto dominance — at least as good everywhere, strictly better
 * somewhere — over the observable axes plus release date.
 *
 * Release date is doing real work here and is worth naming as an assumption:
 * at equal price and equal capabilities, the newer model is taken to be at
 * least as good. That is how labs actually ship — a successor is not worse at
 * the same price — and it is what collapses Copilot's five Opus versions into
 * one. Without it they would all survive as separate arms and the harness would
 * pay to relearn what the version number already said.
 *
 * The strictness matters: identical twins (a model and its dated alias) must
 * not dominate each other, or both would be eliminated and the tier would come
 * back empty. They survive together and are deduplicated by {@link undominated}.
 */
function dominates(a: ModelSpec, b: ModelSpec): boolean {
  const [x, y] = [axes(a), axes(b)];
  const dateA = a.releaseDate ?? '';
  const dateB = b.releaseDate ?? '';

  const everywhere = x.every((v, i) => v >= y[i]!) && dateA >= dateB;
  const somewhere = x.some((v, i) => v > y[i]!) || dateA > dateB;
  return everywhere && somewhere;
}

/**
 * The models worth considering, with the dominated ones removed.
 *
 * On the current catalogue this takes a tier from ten-or-so models down to one
 * or two, which is the point: most of a provider's roster is older versions and
 * dated aliases of the same handful of models, and none of that is a decision
 * anyone should be paying to make.
 *
 * Must be given an already-filtered pool — models this account can reach, that
 * can do what the stage needs. Pruning before filtering would drop a usable
 * fallback in favour of something unreachable.
 */
export function undominated(pool: readonly ModelSpec[]): readonly ModelSpec[] {
  const surviving = pool.filter((m) => !pool.some((other) => dominates(other, m)));

  // What is left may still contain exact twins — same price, same limits, same
  // capabilities, same release date, two ids. Neither dominates the other, so
  // one is chosen by the shortest id, which is upstream's canonical name rather
  // than its dated alias (`claude-haiku-4-5` over `claude-haiku-4-5-20251001`).
  const byProfile = new Map<string, ModelSpec>();
  for (const m of surviving) {
    const key = JSON.stringify([axes(m), m.releaseDate ?? '']);
    const held = byProfile.get(key);
    if (!held || m.id.length < held.id.length) byProfile.set(key, m);
  }

  return [...byProfile.values()].sort((a, b) => a.outputPerMtok - b.outputPerMtok);
}
