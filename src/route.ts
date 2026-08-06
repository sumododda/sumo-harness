/**
 * The one call that decides what a turn is.
 *
 * Separate from `intent.ts`, which knows what the modes mean but nothing about
 * providers, and from `repl.ts`, which knows about the session but should not
 * be the only thing that can run a classification. Keeping it here is what lets
 * `scripts/routing-eval.ts` measure the path the harness actually takes rather
 * than a copy of it that can drift.
 */

import type { Fleet } from './engine/fleet.ts';
import { hash } from './hash.ts';
import { CLASSIFY_PROMPT, CLASSIFY_SCHEMA, isLabel, type Label } from './intent.ts';
import type { Ledger } from './ledger.ts';
import { CLASSIFIER_ROLE } from './prompts.ts';
import { runStage } from './stage.ts';
import { rungAt } from './types.ts';

export interface Classification {
  readonly mode: Label;
  /** `trivial`, `moderate`, or `hard` — the schema constrains it. */
  readonly complexity: string;
}

/**
 * The cache key for one request's classification.
 *
 * Built from the prompt as the model would see it, so editing `CLASSIFY_PROMPT`
 * or its schema invalidates every answer the old wording produced — a route
 * cached under one set of mode descriptions must never be replayed under
 * another. The text is normalised first: retyping a request with different
 * capitalisation or spacing is the same request.
 *
 * Deliberately *not* keyed on the repository fingerprint, unlike every other
 * cache in the harness. What mode a sentence asks for does not change when a
 * file does — "the totals come out wrong" is a bug report before and after the
 * edit that fixes it — and keying on the tree would expire every route on every
 * keystroke, which is the same as having no cache at all.
 *
 * Nor on which model answered. Rung 0 can change under `/model`, and two small
 * models are expected to agree on a five-way label; where they do not, the
 * disagreement shows up in `/routing` as a correction rather than silently.
 */
export function routeKey(input: string): string {
  const normalised = input.trim().toLowerCase().replace(/\s+/g, ' ');
  return hash('route', CLASSIFY_PROMPT(normalised), CLASSIFY_SCHEMA);
}

/**
 * Asks the cheapest model what this request is. Null when it could not say.
 *
 * One turn, no tools, a constrained answer. Null covers both a call that failed
 * and one that named a mode the harness cannot dispatch — the caller treats
 * them the same way, because in both cases there is no route to be had and
 * something has to happen anyway.
 */
export async function classify(
  input: string,
  fleet: Fleet,
  ledger: Ledger,
  cwd: string,
): Promise<Classification | null> {
  try {
    const result = await runStage(
      fleet,
      {
        name: 'route',
        prompt: CLASSIFY_PROMPT(input),
        rung: rungAt(0),
        // Not a coding stage: no tools, and none of the repository framing that
        // makes a model reach for them. Both matter — see `CLASSIFIER_ROLE`.
        system: CLASSIFIER_ROLE,
        capabilities: [],
        cwd,
        // One turn is the whole job with nothing to explore. Headroom for a
        // second exists only because a model that opens with a sentence should
        // still get to finish the answer.
        maxTurns: 2,
        maxBudget: 0.02,
        outputSchema: CLASSIFY_SCHEMA,
      },
      ledger,
    );

    const parsed = JSON.parse(result.output) as { mode: string; complexity: string };
    // The schema constrains the enum, so this holds for every well-formed
    // answer. It is checked anyway because the alternative to one cheap string
    // comparison is dispatching a turn to a stage that does not exist — and
    // caching that answer, so it would happen again for free.
    return isLabel(parsed.mode) ? { mode: parsed.mode, complexity: parsed.complexity } : null;
  } catch {
    // A failed classification must never block the turn.
    return null;
  }
}
