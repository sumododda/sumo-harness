/**
 * The embedding table, and the one operation performed on it.
 *
 * Model2Vec is a lookup table: one row per vocabulary token, and a sentence is
 * the mean of its tokens' rows. There is no network to run — no attention, no
 * layers, no matrix-multiply chain — so this file is an array index and an
 * average, and that is the entire model.
 *
 * That is why it was chosen over an ONNX sentence transformer. `onnxruntime-node`
 * ships prebuilt native binaries per platform and is around a hundred megabytes;
 * this is 1.9 MB of int8 data read with `readFileSync`, works identically on
 * every architecture, and cannot fail to compile because there is nothing to
 * compile.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encode } from './tokenizer.ts';

const FORMAT_VERSION = 1;
const HEADER_BYTES = 16;

export interface Embedder {
  readonly dims: number;
  /** A unit-length vector for the text, or null when nothing was recognised. */
  embed(text: string): Float32Array | null;
}

let cached: Embedder | null = null;

/**
 * Loads the table, once per process.
 *
 * Returns null rather than throwing when the model is missing: the router falls
 * back to the paid classifier, which is a slower and more expensive answer but
 * still an answer. A routing hint is never worth taking the session down for.
 */
export function embedder(): Embedder | null {
  if (cached) return cached;

  try {
    const dir = join(import.meta.dirname, '..', '..', 'model');
    const raw = readFileSync(join(dir, 'embeddings.bin'));

    const version = raw.readUInt32LE(0);
    if (version !== FORMAT_VERSION) throw new Error(`model format ${String(version)}`);
    const rows = raw.readUInt32LE(4);
    const dims = raw.readUInt32LE(8);
    const scale = raw.readFloatLE(12);

    const expected = HEADER_BYTES + rows * dims;
    if (raw.length !== expected) {
      throw new Error(`model is ${String(raw.length)} bytes, expected ${String(expected)}`);
    }

    const table = new Int8Array(raw.buffer, raw.byteOffset + HEADER_BYTES, rows * dims);

    const vocab = new Map<string, number>();
    const tokens = readFileSync(join(dir, 'vocab.txt'), 'utf8').split('\n');
    for (let id = 0; id < rows; id += 1) {
      const token = tokens[id];
      if (token !== undefined && token.length > 0) vocab.set(token, id);
    }

    cached = {
      dims,
      embed(text: string): Float32Array | null {
        const ids = encode(text, vocab);
        if (ids.length === 0) return null;

        const sum = new Float32Array(dims);
        for (const id of ids) {
          if (id >= rows) continue;
          const base = id * dims;
          for (let d = 0; d < dims; d += 1) sum[d]! += table[base + d]!;
        }

        // The int8 scale is a constant factor on every component, and the
        // vectors are only ever compared by cosine — which divides it out. It
        // is applied anyway so a vector means the same thing here as upstream.
        let norm = 0;
        for (let d = 0; d < dims; d += 1) {
          const value = (sum[d]! * scale) / ids.length;
          sum[d] = value;
          norm += value * value;
        }
        if (norm === 0) return null;

        const length = Math.sqrt(norm);
        for (let d = 0; d < dims; d += 1) sum[d]! /= length;
        return sum;
      },
    };
    return cached;
  } catch {
    return null;
  }
}

/** Cosine similarity of two unit vectors, which is their dot product. */
export function similarity(a: Float32Array, b: Float32Array): number {
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += a[i]! * b[i]!;
  return total;
}
