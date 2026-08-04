/**
 * Routing by nearest class, locally, for free.
 *
 * Sits between the rules and the paid classifier: the rules answer what they
 * recognise, this answers what it recognises *confidently*, and anything left
 * still costs a model call. Each layer only has to be right about what it
 * claims, not about everything.
 *
 * The confidence gate is the whole design. A classifier that always answers
 * would replace a cheap correct route with a free wrong one, and a wrong route
 * is the most expensive mistake the harness makes — it can send an edit to a
 * read-only stage, or a question through five stages of a bug workflow. So a
 * margin is required between the best and second-best class, and everything
 * below it is handed on rather than guessed at.
 */

import { type Label, COMPLEXITY, CORPUS } from './corpus.ts';
import { embedder, similarity } from './embed.ts';

/**
 * How far ahead the winner must be before its answer is used.
 *
 * These vectors are unit-length, so similarities sit in a narrow band and the
 * *gap* carries the signal rather than the absolute score.
 *
 * Measured on the 64 held-out phrasings in `test/route.test.ts`: errors stop
 * entirely at 0.08 and stay gone through 0.15, so this sits inside a plateau
 * rather than on the edge of one. 0.06 and below is where it starts being
 * confidently wrong, which is the failure worth paying for headroom against —
 * a wrong route can send an edit to a read-only stage or a question through
 * five stages of a bug workflow. Answering less often is cheap by comparison;
 * anything below the margin simply costs the paid classification it would
 * have cost anyway.
 */
const MIN_MARGIN = 0.1;

export interface LocalRoute {
  readonly label: Label;
  readonly complexity: 'trivial' | 'moderate' | 'hard';
  /** How far ahead of the runner-up, for the routing log. */
  readonly margin: number;
}

let centroids: { label: Label; vector: Float32Array }[] | null = null;

/** The mean unit vector of each label's examples, computed once per process. */
function classes(): { label: Label; vector: Float32Array }[] | null {
  if (centroids) return centroids;

  const model = embedder();
  if (!model) return null;

  const built: { label: Label; vector: Float32Array }[] = [];
  for (const [label, examples] of Object.entries(CORPUS) as [Label, readonly string[]][]) {
    const sum = new Float32Array(model.dims);
    let counted = 0;
    for (const example of examples) {
      const vector = model.embed(example);
      if (!vector) continue;
      for (let d = 0; d < model.dims; d += 1) sum[d]! += vector[d]!;
      counted += 1;
    }
    if (counted === 0) continue;

    let norm = 0;
    for (let d = 0; d < model.dims; d += 1) norm += sum[d]! * sum[d]!;
    if (norm === 0) continue;
    const length = Math.sqrt(norm);
    for (let d = 0; d < model.dims; d += 1) sum[d]! /= length;

    built.push({ label, vector: sum });
  }

  if (built.length === 0) return null;
  centroids = built;
  return centroids;
}

/**
 * Routes locally, or returns null to defer.
 *
 * Null is the common and correct outcome for anything ambiguous. It costs one
 * paid classification, which is what would have happened anyway.
 */
export function routeLocally(input: string): LocalRoute | null {
  const model = embedder();
  const built = classes();
  if (!model || !built) return null;

  const vector = model.embed(input);
  if (!vector) return null;

  let best: { label: Label; score: number } | null = null;
  let runnerUp = -Infinity;
  for (const { label, vector: centroid } of built) {
    const score = similarity(vector, centroid);
    if (!best || score > best.score) {
      if (best) runnerUp = best.score;
      best = { label, score };
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }
  if (!best) return null;

  const margin = best.score - runnerUp;
  if (margin < MIN_MARGIN) return null;

  return { label: best.label, complexity: COMPLEXITY[best.label], margin };
}

/** Whether the model is present at all, for `/routing` to report honestly. */
export function localRoutingAvailable(): boolean {
  return embedder() !== null;
}
