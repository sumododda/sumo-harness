#!/usr/bin/env node
/**
 * Turns the upstream Model2Vec release into the two files the router ships.
 *
 * Run by hand when the model changes, not on install — the output is committed,
 * so a clone has everything and neither a build nor a download can fail.
 *
 * The conversion is quantisation and nothing else. Model2Vec is already a plain
 * lookup table: one row of floats per vocabulary token, no attention and no
 * matrix-multiply chain, so "inference" is averaging a handful of rows. That is
 * the whole reason it was chosen over an ONNX sentence transformer — there is
 * no runtime to install, nothing compiled per architecture, and the artifact is
 * data rather than code.
 *
 *   node scripts/build-router-model.ts
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.env.M2V_REPO ?? 'minishlab/potion-base-2M';
const BASE = `https://huggingface.co/${REPO}/resolve/main`;
const OUT = join(import.meta.dirname, '..', 'model');

async function fetchBuffer(name: string): Promise<Buffer> {
  const response = await fetch(`${BASE}/${name}`);
  if (!response.ok) throw new Error(`${name}: ${String(response.status)}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Reads the single `embeddings` tensor out of a safetensors file. */
function readEmbeddings(buf: Buffer): { rows: number; dims: number; data: Float32Array } {
  const headerLength = Number(buf.readBigUInt64LE(0));
  const header = JSON.parse(buf.subarray(8, 8 + headerLength).toString('utf8')) as Record<
    string,
    { dtype: string; shape: number[]; data_offsets: [number, number] }
  >;
  const tensor = header['embeddings'];
  if (!tensor) throw new Error('no `embeddings` tensor');
  if (tensor.dtype !== 'F32') throw new Error(`unexpected dtype ${tensor.dtype}`);

  const [rows, dims] = tensor.shape as [number, number];
  const start = 8 + headerLength + tensor.data_offsets[0];
  // Copied rather than viewed: the slice must be 4-byte aligned for Float32Array
  // and a Buffer offset carries no such promise.
  const bytes = Uint8Array.prototype.slice.call(buf, start, start + rows * dims * 4);
  return { rows, dims, data: new Float32Array(bytes.buffer) };
}

/**
 * Symmetric int8 quantisation with one scale for the whole matrix.
 *
 * Per-row scales would be more faithful, but the vectors are compared by cosine
 * similarity — which normalises each vector anyway — so a single scale drops out
 * of the comparison almost entirely. Measured against the fp32 original, the
 * classification it feeds does not change on any example in the corpus.
 */
function quantise(data: Float32Array): { scale: number; quantised: Int8Array } {
  let peak = 0;
  for (const value of data) {
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
  }
  const scale = peak / 127;
  const quantised = new Int8Array(data.length);
  for (let i = 0; i < data.length; i += 1) {
    quantised[i] = Math.max(-127, Math.min(127, Math.round(data[i]! / scale)));
  }
  return { scale, quantised };
}

const [safetensors, tokenizerJson] = await Promise.all([
  fetchBuffer('model.safetensors'),
  fetchBuffer('tokenizer.json'),
]);

const { rows, dims, data } = readEmbeddings(safetensors);
const { scale, quantised } = quantise(data);

const tokenizer = JSON.parse(tokenizerJson.toString('utf8')) as {
  model: { vocab: Record<string, number>; unk_token: string; continuing_subword_prefix: string };
  normalizer: { lowercase: boolean; strip_accents: boolean | null };
};

// Written in id order, so loading is a single split with no sorting.
const vocab: string[] = new Array<string>(rows).fill('');
for (const [token, id] of Object.entries(tokenizer.model.vocab)) {
  if (id < rows) vocab[id] = token;
}

// A tiny header keeps the reader honest: dimensions and vocabulary size are
// asserted at load rather than assumed, so a truncated file fails loudly.
const header = Buffer.alloc(16);
header.writeUInt32LE(1, 0); // format version
header.writeUInt32LE(rows, 4);
header.writeUInt32LE(dims, 8);
header.writeFloatLE(scale, 12);

writeFileSync(join(OUT, 'embeddings.bin'), Buffer.concat([header, Buffer.from(quantised.buffer)]));
writeFileSync(join(OUT, 'vocab.txt'), `${vocab.join('\n')}\n`);

process.stdout.write(
  `${REPO}\n` +
    `  ${String(rows)} × ${String(dims)}  scale ${scale.toExponential(3)}\n` +
    `  embeddings.bin  ${(16 + quantised.length) / 1e6} MB  (from ${data.byteLength / 1e6} MB fp32)\n` +
    `  vocab.txt       ${vocab.join('\n').length / 1e6} MB\n` +
    `  unk ${tokenizer.model.unk_token} · prefix ${tokenizer.model.continuing_subword_prefix} · ` +
    `lowercase ${String(tokenizer.normalizer.lowercase)}\n`,
);
