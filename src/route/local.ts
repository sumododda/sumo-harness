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
 *
 * The shipped corpus in `corpus.ts` is the same for every user, which makes it
 * out of distribution for anyone's actual vocabulary by construction. Each
 * repo's own corrections — `/again <mode>`, recorded by `routing-log.ts` — are
 * folded into a per-repo overlay on top of it, so the centroids get more
 * accurate for whoever is actually using them. The gate above is untouched by
 * this: an overlay changes what the router believes, never how sure it has to
 * be before it says so.
 */

import { corrections } from '../routing-log.ts';
import { type Label, COMPLEXITY, CORPUS } from './corpus.ts';
import { type Embedder, embedder, similarity } from './embed.ts';

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

interface RawCentroid {
  readonly label: Label;
  /**
   * Unnormalised sum of the label's example embeddings — kept raw so a
   * correction can be folded in before the one division that makes it a unit
   * vector, rather than undoing and redoing that division.
   */
  readonly sum: Float32Array;
}

let raw: RawCentroid[] | null = null;

/** The shipped corpus, summed per label. Computed once per process. */
function rawCentroids(model: Embedder): RawCentroid[] | null {
  if (raw) return raw;

  const built: RawCentroid[] = [];
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
    built.push({ label, sum });
  }

  if (built.length === 0) return null;
  raw = built;
  return raw;
}

/** A vector's unit-length form, or null for the zero vector. */
function unit(vector: Float32Array): Float32Array | null {
  let norm = 0;
  for (let d = 0; d < vector.length; d += 1) norm += vector[d]! * vector[d]!;
  if (norm === 0) return null;
  const length = Math.sqrt(norm);
  const out = new Float32Array(vector.length);
  for (let d = 0; d < vector.length; d += 1) out[d] = vector[d]! / length;
  return out;
}

let centroids: { label: Label; vector: Float32Array }[] | null = null;

/** The mean unit vector of each label's shipped examples — no corrections. */
function classes(model: Embedder): { label: Label; vector: Float32Array }[] | null {
  if (centroids) return centroids;

  const built = rawCentroids(model);
  if (!built) return null;

  const out: { label: Label; vector: Float32Array }[] = [];
  for (const { label, sum } of built) {
    const vector = unit(sum);
    if (vector) out.push({ label, vector });
  }
  if (out.length === 0) return null;

  centroids = out;
  return centroids;
}

function isLabel(mode: string): mode is Label {
  return mode === 'chat' || mode === 'do' || mode === 'fix' || mode === 'feature';
}

/**
 * How much one correction counts against a shipped example when both are
 * summed into a centroid.
 *
 * Not the same weight as a shipped example (1.0): measured against the 64
 * held-out phrasings in `test/route.test.ts`, weighting a correction the same
 * as a shipped example already flips two of them under a correction log about
 * something else entirely, because a couple of held-out margins sit within a
 * thousandth of the gate — any nudge to the wrong centroid tips them. 0.3
 * stayed clean there under the same test while still being enough for a
 * handful of corrections that agree to flip a genuinely borderline phrase with
 * margin to spare (0.143 against the 0.1 gate, for five corrections on one
 * topic). So one or two corrections nudge; it takes real, repeated agreement
 * to move a boundary.
 */
const CORRECTION_WEIGHT = 0.3;

const overlays = new Map<string, { label: Label; vector: Float32Array }[]>();
const folded = new Map<string, number>();

/**
 * The shipped centroids, nudged by this repo's corrections.
 *
 * Read and built once per root per process — like `classes()`, this is a
 * startup cost, not a per-turn one. A correction made mid-session is picked up
 * on the next run of the harness, the same way the shipped corpus would be
 * after an edit to `corpus.ts`.
 */
function classesFor(model: Embedder, root: string): { label: Label; vector: Float32Array }[] | null {
  const cached = overlays.get(root);
  if (cached) return cached;

  const built = rawCentroids(model);
  if (!built) return null;

  const corrected = corrections(root);
  if (corrected.length === 0) {
    const shipped = classes(model);
    if (shipped) {
      overlays.set(root, shipped);
      folded.set(root, 0);
    }
    return shipped;
  }

  const sums = new Map<Label, Float32Array>(built.map(({ label, sum }) => [label, Float32Array.from(sum)]));

  let count = 0;
  for (const { text, mode } of corrected) {
    if (!isLabel(mode)) continue;
    const sum = sums.get(mode);
    if (!sum) continue;
    const vector = model.embed(text);
    if (!vector) continue;
    for (let d = 0; d < model.dims; d += 1) sum[d]! += vector[d]! * CORRECTION_WEIGHT;
    count += 1;
  }

  const out: { label: Label; vector: Float32Array }[] = [];
  for (const [label, sum] of sums) {
    const vector = unit(sum);
    if (vector) out.push({ label, vector });
  }
  if (out.length === 0) return null;

  overlays.set(root, out);
  folded.set(root, count);
  return out;
}

/**
 * Routes locally, or returns null to defer.
 *
 * Null is the common and correct outcome for anything ambiguous. It costs one
 * paid classification, which is what would have happened anyway.
 *
 * `root` selects the repo whose corrections (if any) nudge the centroids —
 * it defaults to the process's own working directory, which is the repo the
 * harness is running against for every real caller. Callers that want the
 * shipped centroids with no overlay, such as a hermetic test, pass a root
 * with no `.sumo/routing.jsonl` under it.
 */
export function routeLocally(input: string, root: string = process.cwd()): LocalRoute | null {
  const model = embedder();
  if (!model) return null;
  const built = classesFor(model, root);
  if (!built) return null;

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

/**
 * How many of this repo's corrections are folded into its overlay — for
 * `/routing` to report, once something calls it. Zero for a repo with no
 * corrections, an unreadable log, or no model.
 */
export function correctionsInPlay(root: string): number {
  const model = embedder();
  if (!model) return 0;
  classesFor(model, root);
  return folded.get(root) ?? 0;
}
