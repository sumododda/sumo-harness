/**
 * The operator profile: durable preferences that ride every session.
 *
 * Kept deliberately small — this text is prepended to every stage's system
 * prompt, so each line is paid for on every call.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const PROFILE_PATH = join(homedir(), '.sumo', 'profile.md');

const SEED = `# Operator profile

- Production-grade code only. No placeholder logic, no "TODO: handle later".
- Never duplicate an existing helper. Search for one and reuse it; prefer
  editing an existing function over adding a near-identical new one.
- Fix causes, not symptoms. No defensive padding to make a symptom disappear.
- Match the surrounding code's style, naming, and error handling.
- Keep changes minimal and scoped to the task.
`;

/** Reads the profile, seeding it on first run. */
export function loadProfile(): string {
  try {
    return readFileSync(PROFILE_PATH, 'utf8').trim();
  } catch {
    mkdirSync(dirname(PROFILE_PATH), { recursive: true });
    writeFileSync(PROFILE_PATH, SEED, 'utf8');
    return SEED.trim();
  }
}

/** Appends one durable preference. Backs `sumo remember`. */
export function remember(fact: string): void {
  loadProfile();
  appendFileSync(PROFILE_PATH, `- ${fact.trim()}\n`, 'utf8');
}

/** Rough token estimate, used to warn when the profile grows expensive. */
export function estimateTokens(text: string): number {
  return estimateTokensFromChars(text.length);
}

/**
 * The same estimate for text that has already been measured.
 *
 * Deliberately a heuristic. An exact count means a round trip to the provider,
 * and these numbers exist to attribute a prompt's bulk — a share that is roughly
 * right answers that just as well as one that is exactly right.
 */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / 4);
}
