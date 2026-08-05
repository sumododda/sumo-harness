#!/usr/bin/env node
/**
 * Turns models.dev's database into the catalogue the router ships.
 *
 * Run by hand when the model line-up changes, not on install — the output is
 * committed, so a clone has everything and an offline run never depends on a
 * third party being up. Same discipline as `build-router-model.ts`, and for the
 * same reason: what the harness needs at runtime should be data in the repo.
 *
 * The upstream database is ~3.5 MB across 180 providers. Filtered to the ones
 * this harness can actually route to, it is a few kilobytes — small enough to
 * read and review in a diff, which matters, because a wrong `structured_output`
 * flag here would silently route a schema stage at a model that cannot answer.
 *
 *   node scripts/build-catalog.ts
 *
 * @see https://models.dev — MIT, and the same database opencode uses.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = process.env['MODELS_DEV_URL'] ?? 'https://models.dev/api.json';
const OUT = join(import.meta.dirname, '..', 'model', 'catalog.json');

/**
 * The providers this harness has an engine for.
 *
 * Named rather than taken wholesale because the catalogue is a list of things
 * the router may pick, and a model the harness cannot reach is not one of them.
 */
const PROVIDERS = ['anthropic', 'github-copilot'] as const;

/** Only the fields routing actually uses. Everything else is noise in a diff. */
interface Entry {
  readonly id: string;
  readonly name: string;
  readonly family: string;
  /** USD per million output tokens — the price signal routing sorts on. */
  readonly outputPerMtok: number;
  readonly inputPerMtok: number;
  readonly contextWindow: number;
  /**
   * Whether the model can constrain a final answer to a schema.
   *
   * Absent upstream for some models, which is not the same as false — so it is
   * recorded as-is and the router treats unknown conservatively rather than
   * assuming a capability it has no evidence for.
   */
  readonly structuredOutput: boolean | null;
  readonly toolCall: boolean;
  /** Effort levels this model accepts, upstream's own list. Empty when none. */
  readonly efforts: readonly string[];
  readonly releaseDate?: string;
}

interface UpstreamModel {
  id?: string;
  name?: string;
  family?: string;
  cost?: { input?: number; output?: number };
  limit?: { context?: number };
  structured_output?: boolean;
  tool_call?: boolean;
  reasoning_options?: { type?: string; values?: string[] }[];
  release_date?: string;
}

function toEntry(id: string, m: UpstreamModel): Entry | null {
  // A model with no price cannot be ranked and no context window cannot be
  // budgeted. Either way it is not routable, so it is dropped rather than
  // carried with a zero that would sort it first.
  const output = m.cost?.output;
  const context = m.limit?.context;
  if (typeof output !== 'number' || typeof context !== 'number') return null;

  const effort = m.reasoning_options?.find((o) => o.type === 'effort');

  return {
    id,
    name: m.name ?? id,
    family: m.family ?? id,
    outputPerMtok: output,
    inputPerMtok: m.cost?.input ?? 0,
    contextWindow: context,
    structuredOutput: m.structured_output ?? null,
    toolCall: m.tool_call === true,
    efforts: effort?.values ?? [],
    ...(m.release_date ? { releaseDate: m.release_date } : {}),
  };
}

const response = await fetch(SOURCE);
if (!response.ok) {
  throw new Error(`models.dev returned HTTP ${String(response.status)}`);
}
const db = (await response.json()) as Record<string, { models?: Record<string, UpstreamModel> }>;

const providers: Record<string, Entry[]> = {};
for (const provider of PROVIDERS) {
  const models = db[provider]?.models;
  if (!models) {
    throw new Error(`models.dev has no provider "${provider}" — has it been renamed?`);
  }
  providers[provider] = Object.entries(models)
    .map(([id, m]) => toEntry(id, m))
    .filter((e): e is Entry => e !== null)
    // Sorted by price so the file reads as a ladder and a diff shows movement.
    .sort((a, b) => a.outputPerMtok - b.outputPerMtok);
}

writeFileSync(
  OUT,
  `${JSON.stringify({ source: SOURCE, providers }, null, 2)}\n`,
  'utf8',
);

for (const [provider, entries] of Object.entries(providers)) {
  process.stdout.write(`${provider}: ${String(entries.length)} models\n`);
}
process.stdout.write(`wrote ${OUT}\n`);
