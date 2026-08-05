/**
 * Which catalogued models this account can actually use.
 *
 * The catalogue says what exists in the world. It cannot say what exists *for
 * you*: an organisation disables models by policy, a plan gates them by
 * entitlement, and a provider withdraws them without warning. Routing at a
 * model the catalogue lists and the account cannot reach fails in the least
 * useful way possible — mid-stage, after the prompt has been paid for.
 *
 * So availability is a second source, and the two are combined rather than
 * confused: catalogue ∩ reachable. Providers that can enumerate their own
 * models say so; the ones that cannot are trusted, because being wrong there
 * costs the same failed call it would have cost anyway.
 *
 * Three states rather than a boolean, because "the organisation has not decided
 * about this model" is genuinely different from "the organisation said no", and
 * only one of them is worth telling the operator about.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Engine } from './types.ts';

/**
 * What a provider says about one of its models, for this account.
 *
 * An engine reporting these must map "no policy at all" to `enabled`, not to
 * `unconfigured`. Copilot attaches a policy object only to models that need
 * consent — the Claude family carries one, `gpt-5.3-codex` and `grok-4.5` carry
 * none — and an absent policy means nothing is gating the model, which is the
 * opposite of an organisation having declined to enable it. Reading absence as
 * `unconfigured` withdraws most of a working roster; verified against a live
 * subscription, where 3 of 17 models carried no policy field.
 */
export interface AvailableModel {
  readonly id: string;
  readonly state: 'enabled' | 'disabled' | 'unconfigured';
}

/**
 * How long a probe is trusted.
 *
 * A day, because entitlement changes on the timescale of someone editing an
 * organisation policy or a plan renewing — not on the timescale of a task. The
 * cost of being stale for an hour is one failed stage that then re-probes; the
 * cost of probing every run is spawning a provider CLI before any work starts.
 */
const TTL_MS = 24 * 60 * 60 * 1000;

interface Probe {
  readonly fetchedAt: number;
  readonly models: readonly AvailableModel[];
}

/**
 * Models found unusable during this run, by `${provider}:${id}`.
 *
 * Runtime is the final authority and outranks any probe: a model enabled when
 * asked can still refuse the next call because an allowance ran out between
 * them. Kept in memory rather than written down, because it is a fact about
 * right now and re-probing on the next run is cheap.
 */
const brokenNow = new Set<string>();

function file(root: string): string {
  return join(root, '.sumo', 'models.json');
}

function read(root: string): Record<string, Probe> {
  try {
    return JSON.parse(readFileSync(file(root), 'utf8')) as Record<string, Probe>;
  } catch {
    // A missing or unreadable probe is a reason to ask again, never a failure.
    return {};
  }
}

function write(root: string, all: Record<string, Probe>): void {
  try {
    mkdirSync(dirname(file(root)), { recursive: true });
    writeFileSync(file(root), `${JSON.stringify(all, null, 2)}\n`, 'utf8');
  } catch {
    // Losing the cache costs a probe, never a task.
  }
}

/**
 * Records that a model refused to work, so nothing routes at it again this run.
 *
 * Called by an engine when a failure is about the model rather than the work —
 * a policy refusal or an exhausted allowance. A stage that merely produced a
 * bad answer must not land here: that is what the escalation ladder is for.
 */
export function markUnusable(provider: string, id: string): void {
  brokenNow.add(`${provider}:${id}`);
}

/** Forgets in-run failures. For tests, and for `/routing` to offer a reset. */
export function clearUnusable(): void {
  brokenNow.clear();
}

/**
 * The set of model ids this engine can currently use, or null when the provider
 * cannot enumerate and every catalogued model should be assumed reachable.
 *
 * `now` is injectable so a test can age a probe without waiting a day.
 */
export async function usable(
  engine: Engine,
  root: string,
  now: number = Date.now(),
): Promise<ReadonlySet<string> | null> {
  if (!engine.availableModels) return null;

  const all = read(root);
  let probe = all[engine.name];

  if (!probe || now - probe.fetchedAt > TTL_MS) {
    try {
      probe = { fetchedAt: now, models: await engine.availableModels() };
      write(root, { ...all, [engine.name]: probe });
    } catch {
      // A provider that cannot be asked right now is not a provider with no
      // models. Fall back to the last answer, and to trusting the catalogue
      // when there has never been one — the alternative is refusing to run
      // offline, which is worse than occasionally routing at a model that
      // turns out to be gated.
      if (!probe) return null;
    }
  }

  return new Set(
    probe.models
      .filter((m) => m.state === 'enabled')
      .map((m) => m.id)
      .filter((id) => !brokenNow.has(`${engine.name}:${id}`)),
  );
}

/**
 * Why a catalogued model is not usable, for the operator — or null if it is.
 *
 * Separate from {@link usable} because a set of ids answers "what may I route
 * at" and this answers "why did my preference not happen", and the second one
 * is the question someone asks out loud.
 */
export function whyUnusable(
  provider: string,
  id: string,
  probe: readonly AvailableModel[] | null,
): string | null {
  if (brokenNow.has(`${provider}:${id}`)) return 'failed earlier in this run';
  if (probe === null) return null;

  const found = probe.find((m) => m.id === id);
  if (!found) return 'not offered to this account';
  if (found.state === 'disabled') return 'disabled by policy';
  if (found.state === 'unconfigured') return 'not enabled for this organisation';
  return null;
}

/** The last probe recorded for a provider, for reporting. Null when never asked. */
export function lastProbe(root: string, provider: string): readonly AvailableModel[] | null {
  if (!existsSync(file(root))) return null;
  return read(root)[provider]?.models ?? null;
}
