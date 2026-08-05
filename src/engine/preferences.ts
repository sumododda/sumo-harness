/**
 * Models the operator has turned off.
 *
 * Three different things can stop a model being routed at, and keeping them
 * apart is the whole point of this file existing separately from
 * `availability.ts`:
 *
 *   - the **catalogue** says whether a model exists at all;
 *   - the **account** says whether this subscription may call it, which is what
 *     the probe in `availability.ts` records;
 *   - **you** say whether you want it used, which is this.
 *
 * Only the third is a preference, and it is the only one that survives a probe
 * refresh — an organisation re-enabling a model must not silently undo a
 * decision to stop paying for it.
 *
 * Stored in the home directory rather than the repository because it is a fact
 * about an account and a wallet, not about a checkout: someone who does not
 * want to spend Opus tokens does not want to re-say so in every clone. That
 * also keeps it clear of `<repo>/.sumo/models.json`, which is the provider's
 * answer rather than the operator's — a distinction worth a different filename,
 * since they would otherwise be two files with one name meaning opposite
 * things.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Where the choices live. Printed by `sumo models`, so it is never a mystery.
 *
 * A function rather than a constant so `SUMO_HOME` is read per call. That is
 * what lets a test exercise this at all: the alternative is a suite that writes
 * to the developer's own `~/.sumo`, and a test run that turns off a model they
 * were using.
 */
export function disabledPath(): string {
  return join(process.env['SUMO_HOME'] ?? homedir(), '.sumo', 'models-disabled.json');
}

interface Stored {
  /** `${provider}:${id}` for each model turned off. */
  readonly disabled: readonly string[];
}

function key(provider: string, id: string): string {
  return `${provider}:${id}`;
}

function read(): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(disabledPath(), 'utf8')) as Stored;
    return new Set(parsed.disabled ?? []);
  } catch {
    // Absent or unreadable means nothing has been turned off, which is the
    // correct starting state and not a condition worth reporting.
    return new Set();
  }
}

function write(keys: ReadonlySet<string>): void {
  mkdirSync(dirname(disabledPath()), { recursive: true });
  const stored: Stored = { disabled: [...keys].sort() };
  writeFileSync(disabledPath(), `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
}

/** Every model turned off, as `${provider}:${id}`. */
export function disabledModels(): ReadonlySet<string> {
  return read();
}

/** Whether this model has been turned off. */
export function isDisabled(provider: string, id: string): boolean {
  return read().has(key(provider, id));
}

/** Turns a model off. Returns false when it was already off. */
export function turnOff(provider: string, id: string): boolean {
  const keys = read();
  if (keys.has(key(provider, id))) return false;
  keys.add(key(provider, id));
  write(keys);
  return true;
}

/** Turns a model back on. Returns false when it was not off. */
export function turnOn(provider: string, id: string): boolean {
  const keys = read();
  if (!keys.delete(key(provider, id))) return false;
  write(keys);
  return true;
}
