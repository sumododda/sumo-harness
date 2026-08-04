/**
 * Whether to ask the index at all.
 *
 * Retrieval is not free even when it costs no API call: the pack occupies a
 * couple of thousand tokens of every prompt it lands in, and an irrelevant one
 * competes with the instructions for the model's attention. The research on
 * repository completion is direct about this — retrieving when the local context
 * already suffices costs latency and tokens and can make the answer worse.
 *
 * The bar for skipping is deliberately high. Two cases are clear-cut; everything
 * else retrieves, because a missing pack costs the model several rounds of
 * reading its way to the same files, which is far dearer than a wasted one.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import * as features from './features.ts';
import { type Mode, TRIVIAL } from './intent.ts';
import type { Rung } from './types.ts';

export interface RetrievalDecision {
  readonly retrieve: boolean;
  /** Shown on the mode line, so a skipped lookup is never silent. */
  readonly why: string;
}

/** Files a task might name. Limited to what this harness indexes. */
const PATH_LIKE = /(?:^|[\s"'`(])([\w./-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|json|md))(?=$|[\s"'`),:;])/g;

export function shouldRetrieve(
  mode: Mode,
  rung: Rung,
  input: string,
  cwd: string,
): RetrievalDecision {
  // Switched off, every turn retrieves — the behaviour this gating replaced,
  // and the baseline its saving is measured against.
  if (!features.get().gatedRetrieval) return { retrieve: true, why: '' };

  // A named file is a better answer than a ranked guess at one. The model has
  // Read; pointing it at the whole repo instead would be a downgrade.
  const named = namedFile(input, cwd);
  if (named) {
    return { retrieve: false, why: `names ${named}` };
  }

  // Renaming a variable or fixing a typo does not need a semantic slice of the
  // repository — it needs the file, which the model will open anyway.
  if (mode === 'do' && rung.tier === 'small' && TRIVIAL.test(input)) {
    return { retrieve: false, why: 'mechanical edit' };
  }

  return { retrieve: true, why: '' };
}

/**
 * A path in the task text that actually exists.
 *
 * Existence is the point: "update the parser.ts logic" naming a file that is
 * not there is a description, not a pointer, and should still be retrieved for.
 */
function namedFile(input: string, cwd: string): string | null {
  for (const match of input.matchAll(PATH_LIKE)) {
    const candidate = match[1]!;
    if (isAbsolute(candidate)) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    if (existsSync(join(cwd, candidate))) return candidate;
  }
  return null;
}
