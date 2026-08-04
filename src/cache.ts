/**
 * An exact result cache.
 *
 * On a valid hit this avoids the entire model call — every input token and every
 * output token, not a fraction of them. That makes it the cheapest saving
 * available, and also the one with the sharpest failure mode: a hit that should
 * have been a miss returns a confidently stale answer.
 *
 * The safety argument is entirely in the key. Every input capable of changing
 * the result is hashed into it, including the repository's own content (see
 * {@link repoFingerprint}). Nothing is matched approximately — there is no
 * similarity search here, deliberately, because a near-miss on a code question
 * is a wrong answer rather than a slightly worse one.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as features from './features.ts';

/** Entries older than this are ignored and swept. Hygiene, not correctness. */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

interface Envelope<T> {
  readonly storedAt: number;
  readonly value: T;
}

let reads = 0;
let hits = 0;

/**
 * Whether reuse is on.
 *
 * Read from the feature registry rather than held here, so `--no-cache` and a
 * benchmark configuration are the same switch rather than two that can disagree.
 */
export function isEnabled(): boolean {
  return features.get().cache;
}

/** Hit rate for this session, for `/cache`. */
export function sessionStats(): { readonly reads: number; readonly hits: number } {
  return { reads, hits };
}

function shard(root: string, key: string): string {
  return join(root, '.sumo', 'cache', key.slice(0, 2));
}

/**
 * Reads a cached value, or null when there is nothing usable.
 *
 * Expired entries are removed as they are found, so a long-lived repo does not
 * accumulate answers about code that no longer exists.
 *
 * `T` appears only in the return type, which means it is an unchecked cast
 * wearing a type parameter — nothing here validates that the JSON on disk is
 * the shape the caller asked for. That is deliberate and load-bearing: what
 * makes a hit safe is the key, which already includes every input capable of
 * changing the answer, so an entry that matches was written by this same code
 * path with this same shape. Validating it again would be re-checking the
 * harness's own output. Returning `unknown` instead would simply move the same
 * cast to every call site.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function read<T>(root: string, key: string): T | null {
  if (!isEnabled()) return null;

  reads += 1;
  const path = join(shard(root, key), `${key}.json`);

  try {
    const envelope = JSON.parse(readFileSync(path, 'utf8')) as Envelope<T>;
    if (Date.now() - envelope.storedAt > MAX_AGE_MS) {
      rmSync(path, { force: true });
      return null;
    }
    hits += 1;
    return envelope.value;
  } catch {
    // Absent, unreadable, or truncated by a previous crash: all are misses.
    return null;
  }
}

/** Stores a value under a key that already accounts for everything variable. */
export function write(root: string, key: string, value: unknown): void {
  if (!isEnabled()) return;

  const dir = shard(root, key);
  try {
    mkdirSync(dir, { recursive: true });
    const envelope: Envelope<unknown> = { storedAt: Date.now(), value };
    writeFileSync(join(dir, `${key}.json`), JSON.stringify(envelope), 'utf8');
    // Sweeping only the shard just written bounds the cost to ~1/256 of the
    // cache while still visiting every shard over time.
    sweep(dir);
  } catch {
    // A cache that cannot write is a slow cache, not a broken harness.
  }
}

/** Computes a value once per key. Used for work that is not a model call. */
export async function memo<T>(
  root: string,
  key: string,
  compute: () => Promise<T>,
): Promise<{ readonly value: T; readonly cached: boolean }> {
  const hit = read<T>(root, key);
  if (hit !== null) return { value: hit, cached: true };

  const value = await compute();
  write(root, key, value);
  return { value, cached: false };
}

/** Empties the cache for a repo. Returns how many entries were removed. */
export function clear(root: string): number {
  const dir = join(root, '.sumo', 'cache');
  const count = entries(root).length;
  rmSync(dir, { recursive: true, force: true });
  return count;
}

export function stats(root: string): { readonly entries: number; readonly bytes: number } {
  let bytes = 0;
  for (const path of entries(root)) {
    try {
      bytes += statSync(path).size;
    } catch {
      // Swept between listing and stat; it simply does not count.
    }
  }
  return { entries: entries(root).length, bytes };
}

function entries(root: string): string[] {
  const dir = join(root, '.sumo', 'cache');
  if (!existsSync(dir)) return [];

  const found: string[] = [];
  try {
    for (const shardName of readdirSync(dir)) {
      const shardDir = join(dir, shardName);
      try {
        for (const file of readdirSync(shardDir)) {
          if (file.endsWith('.json')) found.push(join(shardDir, file));
        }
      } catch {
        // Not a directory, or removed underneath us.
      }
    }
  } catch {
    // No cache directory yet.
  }
  return found;
}

function sweep(dir: string): void {
  const cutoff = Date.now() - MAX_AGE_MS;
  try {
    for (const file of readdirSync(dir)) {
      const path = join(dir, file);
      try {
        if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
      } catch {
        // Already gone.
      }
    }
  } catch {
    // Shard vanished; nothing to sweep.
  }
}
