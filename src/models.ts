/**
 * `sumo models` — what exists, what this account may call, and what you have
 * turned off.
 *
 * Routing makes a chain of decisions per stage and prints one line about the
 * winner, which is the right amount of noise during a task and no help at all
 * when the question is "why is it never using Opus". This answers that question
 * directly, by showing every model with the reason it is or is not a candidate.
 *
 * The reasons come from where they are actually decided rather than being
 * re-derived here: `availability.whyUnusable` for the account's answer,
 * `preferences` for yours, and `catalog.undominated` for the one that surprises
 * people — a model can be perfectly available and still never chosen, because
 * something else in the pool is better on every axis at the same tier.
 */

import pc from 'picocolors';
import { lastProbe, whyUnusable } from './engine/availability.ts';
import { candidates, undominated } from './engine/catalog.ts';
import type { ModelSpec } from './engine/catalog.ts';
import { Fleet, policyFromEnv } from './engine/fleet.ts';
import { getFleetEngines } from './engine/index.ts';
import { disabledModels, disabledPath, turnOff, turnOn } from './engine/preferences.ts';
import type { Engine } from './engine/types.ts';
import { SumoError, type Tier } from './types.ts';

const TIERS: readonly Tier[] = ['small', 'mid', 'large'];

/** What routing would do with one model, and why. */
interface Row {
  readonly model: ModelSpec;
  readonly tier: Tier;
  /** Set when something stops it being routed at; null when it is a candidate. */
  readonly blocked: string | null;
  /** True when it is available but something else at this tier beats it outright. */
  readonly dominated: boolean;
  readonly disabled: boolean;
}

function rowsFor(engine: Engine, root: string): Map<Tier, Row[]> {
  const catalogued = engine.catalogName ?? engine.name;
  const probe = lastProbe(root, engine.name);
  const off = disabledModels();
  const byTier = new Map<Tier, Row[]>();

  for (const tier of TIERS) {
    const pool = candidates(catalogued, tier);

    // Dominance is computed over what is actually reachable, exactly as routing
    // computes it. Doing it over the whole catalogue would report a model as
    // "beaten" by one this account cannot call, which is the opposite of useful.
    const live = pool.filter(
      (m) => whyUnusable(engine.name, m.id, probe) === null && !off.has(`${engine.name}:${m.id}`),
    );
    const kept = new Set(undominated(live).map((m) => m.id));

    byTier.set(
      tier,
      pool.map((model) => {
        const disabled = off.has(`${engine.name}:${model.id}`);
        return {
          model,
          tier,
          blocked: disabled ? 'turned off by you' : whyUnusable(engine.name, model.id, probe),
          dominated: !disabled && !kept.has(model.id) && kept.size > 0,
          disabled,
        };
      }),
    );
  }

  return byTier;
}

function mark(row: Row): string {
  if (row.disabled) return pc.yellow('⊘');
  if (row.blocked) return pc.red('✗');
  if (row.dominated) return pc.dim('○');
  return pc.green('●');
}

function traits(m: ModelSpec): string {
  const parts: string[] = [];
  if (m.structuredOutput === true) parts.push('schema');
  if (m.efforts.length > 0) parts.push(`effort:${m.efforts.join('/')}`);
  return parts.join(' ');
}

/** Renders the listing. Separated from printing so a test can read it. */
export function renderModels(
  engines: readonly Engine[],
  root: string,
  routed: ReadonlyMap<string, string>,
): string {
  const out: string[] = [];
  const off = disabledModels();

  for (const engine of engines) {
    const byTier = rowsFor(engine, root);
    const probe = lastProbe(root, engine.name);
    const source =
      probe === null
        ? 'never probed — the catalogue is trusted'
        : `${String(probe.length)} models offered to this account`;

    out.push(`${pc.bold(engine.name)}  ${pc.dim(source)}`);

    for (const tier of TIERS) {
      const rows = byTier.get(tier) ?? [];
      if (rows.length === 0) continue;

      const chosen = routed.get(`${engine.name}:${tier}`);
      out.push(pc.dim(`  ${tier}`));

      // Widths from the rows actually printed, so a long id in one tier does
      // not pad every other tier out to meet it.
      const width = Math.max(...rows.map((r) => r.model.id.length));

      for (const row of rows) {
        // Padded before colouring: an ANSI escape has length and no width, so
        // padding a coloured string lines the columns up against the wrong count.
        const padded = row.model.id.padEnd(width);
        const id = row.disabled || row.blocked ? pc.dim(padded) : padded;
        const price = `$${String(row.model.outputPerMtok)}/M`;
        const note = row.blocked
          ? pc.dim(` · ${row.blocked}`)
          : row.model.id === chosen
            ? pc.green(' · routed here')
            : row.dominated
              ? pc.dim(' · beaten at this tier')
              : '';
        out.push(
          `    ${mark(row)} ${id}  ${pc.dim(price.padStart(8))}  ${pc.dim(traits(row.model))}${note}`,
        );
      }
    }
    out.push('');
  }

  out.push(
    pc.dim(
      `${pc.green('●')} routable   ${pc.dim('○')} beaten by a better model   ` +
        `${pc.red('✗')} unavailable   ${pc.yellow('⊘')} turned off by you`,
    ),
  );
  out.push(pc.dim('sumo models off <id> · sumo models on <id>'));
  if (off.size > 0) out.push(pc.dim(`${String(off.size)} turned off — ${disabledPath()}`));

  return out.join('\n');
}

/**
 * What routing would actually pick per provider and tier, right now.
 *
 * Asked of the real `Fleet` rather than recomputed, because a listing that
 * disagreed with what the next stage does would be worse than no listing. The
 * need is deliberately unconstrained — no schema, no effort — so this reports
 * the tier's default winner rather than the answer to one particular stage.
 */
async function routedPerTier(fleet: Fleet): Promise<Map<string, string>> {
  const picked = new Map<string, string>();
  for (const tier of TIERS) {
    try {
      const r = await fleet.for({ tier, needsSchema: false, capabilities: [] });
      if (r.model) picked.set(`${r.engine.name}:${tier}`, r.model.id);
    } catch {
      // A tier nothing can serve is already visible as a column of ✗ and ⊘.
      // Failing the whole listing over it would hide the reason why.
    }
  }
  return picked;
}

/** Resolves what the operator typed to concrete `(provider, id)` pairs. */
function resolve(engines: readonly Engine[], target: string): { provider: string; id: string }[] {
  // `provider/id` names one exactly; a bare id means every provider carrying it,
  // because the same model is often reachable through more than one account and
  // turning it off on one while it quietly keeps running on the other is the
  // least useful thing this command could do.
  const [maybeProvider, ...restParts] = target.split('/');
  const explicit = restParts.length > 0;
  const id = explicit ? restParts.join('/') : target;

  const found: { provider: string; id: string }[] = [];
  for (const engine of engines) {
    if (explicit && engine.name !== maybeProvider) continue;
    const catalogued = engine.catalogName ?? engine.name;
    const known = TIERS.flatMap((t) => candidates(catalogued, t)).some((m) => m.id === id);
    if (known) found.push({ provider: engine.name, id });
  }
  return found;
}

/**
 * The listing, against a fleet that already exists.
 *
 * Takes the fleet rather than building one so the REPL reports the session's
 * own routing. A second fleet would answer for a different set of providers the
 * moment `--provider` or a credential differed, and a listing that disagrees
 * with what the next stage does is worse than no listing.
 */
export async function listModels(
  fleet: Fleet,
  engines: readonly Engine[],
  root: string,
): Promise<string> {
  return renderModels(engines, root, await routedPerTier(fleet));
}

/** Turns a model off or on, and says what happened to each match. */
export function switchModel(
  engines: readonly Engine[],
  action: 'on' | 'off',
  target: string,
): string {
  const targets = resolve(engines, target);
  if (targets.length === 0) {
    throw new SumoError(`No catalogued model called "${target}".`, 'unknown_model', [
      'Run `sumo models` to see what there is.',
      'Name one provider with `provider/id` when the same model is on both.',
    ]);
  }

  const lines = targets.map(({ provider, id }) => {
    const changed = action === 'off' ? turnOff(provider, id) : turnOn(provider, id);
    return changed
      ? `  ${provider}/${id} — ${pc.bold(action)}`
      : pc.dim(`  ${provider}/${id} — already ${action}`);
  });

  return [...lines, pc.dim(`  ${disabledPath()}`)].join('\n');
}

export interface ModelsOptions {
  /** `on` or `off`, with the model to switch. Absent means list. */
  readonly action?: 'on' | 'off';
  readonly target?: string;
  readonly provider?: string;
  readonly cwd?: string;
}

export async function runModels(opts: ModelsOptions = {}): Promise<number> {
  const root = opts.cwd ?? process.cwd();
  const engines = getFleetEngines(opts.provider);

  if (opts.action) {
    if (!opts.target) {
      throw new SumoError(`\`sumo models ${opts.action}\` needs a model.`, 'no_model_named', [
        'Run `sumo models` to see what there is.',
      ]);
    }
    process.stdout.write(`${switchModel(engines, opts.action, opts.target)}\n`);
    return 0;
  }

  const fleet = new Fleet(engines, policyFromEnv(), root);
  process.stdout.write(`${await listModels(fleet, engines, root)}\n`);
  return 0;
}
