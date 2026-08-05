#!/usr/bin/env node
/**
 * Prices a retrieval method against real commits.
 *
 * A commit is a labelled example nobody had to write: its message is what
 * someone asked for, and the files it changed are the answer. Ranking every
 * file in the repository against the message and looking at where the changed
 * ones landed measures the only thing that matters about the pack — whether the
 * files a task is about arrive without being searched for.
 *
 * Run against a clone, not this repository: the point is scale and variety.
 *
 *     git clone --depth 800 https://github.com/microsoft/vscode /tmp/vscode
 *     node scripts/retrieval-eval.ts /tmp/vscode src 200
 *
 * Recorded results, so a change has something to beat:
 *
 *     excalidraw   635 files, 150 commits      recall@10   MRR
 *       exact match (what the index does)          55.6%   0.464
 *       + split identifiers                        64.5%   0.538
 *       + path tokens          ← shipped           65.4%   0.547
 *
 *     VS Code    8,125 files, 200 commits      recall@10   MRR
 *       exact match                                50.0%   0.528
 *       + split identifiers                        56.2%   0.573
 *       + path tokens          ← shipped           56.5%   0.578
 *
 * On the hard subset — the 181 of 200 VS Code commits whose message never names
 * a file that changed — the shipped method still reads 54.0% against 48.2%, so
 * the gain is not commit messages quoting filenames back.
 *
 * Two methods were measured and rejected, recorded so they are not reinvented.
 * A reference-graph PageRank fused into the ranking scored *below* splitting
 * alone (55.5% on VS Code); confined to re-ranking it drew level and bought
 * nothing for a great deal of machinery. Boosting each file from its one-hop
 * neighbours collapsed to 0.5% recall at VS Code's scale, hub files swamping
 * everything. Structural relevance is real and belongs where CodeGraph already
 * applies it — around a file already chosen — not in the choosing.
 *
 * Not part of `npm run check`: it needs a cloned repository and takes minutes.
 * The mechanism it measures is unit-tested in `test/lexical.test.ts`.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { splitIdentifier, tokenize } from '../src/context/lexical.ts';

const [, , repoArg, srcArg = 'src', commitsArg = '150'] = process.argv;
if (!repoArg) {
  process.stderr.write('usage: retrieval-eval.ts <repo-path> [src-dir] [commits]\n');
  process.exit(2);
}
const root = repoArg;
const MAX_CASES = Number(commitsArg);

const SOURCE = /\.(ts|tsx|js|jsx|py|go|rs|java|rb)$/;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (SOURCE.test(name) && !name.endsWith('.d.ts')) yield path;
  }
}

process.stderr.write(`reading ${join(root, srcArg)} …\n`);
const files: { rel: string; text: string }[] = [];
for (const path of walk(join(root, srcArg))) {
  try {
    const text = readFileSync(path, 'utf8');
    files.push({ rel: relative(root, path), text: text.slice(0, 1_500_000) });
  } catch {
    // Unreadable or binary. Nothing to index.
  }
}
process.stderr.write(`  ${String(files.length)} files\n`);

/** Exact-match tokens: the baseline, and what an FTS index sees. */
function exact(text: string): string[] {
  return [...text.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)].map((m) => m[0].toLowerCase());
}

/** The shipped tokenizer, plus the file's path — see `src/context/lexical.ts`. */
function shipped(text: string, path = ''): string[] {
  const out = tokenize(text);
  for (const segment of path.split('/')) {
    for (const part of splitIdentifier(segment.replace(SOURCE, ''))) {
      if (part.length > 2) for (let i = 0; i < 8; i += 1) out.push(part);
    }
  }
  return out;
}

type Ranker = (query: string) => { file: string; score: number }[];

function buildBm25(tokenizeDoc: (text: string, path: string) => string[]): Ranker {
  const docs = files.map((f) => {
    const tf = new Map<string, number>();
    const toks = tokenizeDoc(f.text, f.rel);
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { rel: f.rel, tf, len: toks.length };
  });
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const avg = docs.reduce((a, d) => a + d.len, 0) / Math.max(1, docs.length);
  const N = docs.length;

  return (query) => {
    const scores = new Map<string, number>();
    for (const term of new Set(tokenizeDoc(query, ''))) {
      const n = df.get(term);
      if (n === undefined) continue;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      for (const d of docs) {
        const f = d.tf.get(term);
        if (f === undefined) continue;
        const norm = 1 - 0.75 + (0.75 * d.len) / avg;
        scores.set(d.rel, (scores.get(d.rel) ?? 0) + idf * ((f * 2.2) / (f + 1.2 * norm)));
      }
    }
    return [...scores.entries()]
      .map(([file, score]) => ({ file, score }))
      .sort((a, b) => b.score - a.score);
  };
}

process.stderr.write('building indexes …\n');
const rankExact = buildBm25((text) => exact(text));
const rankShipped = buildBm25((text, path) => shipped(text, path));

process.stderr.write('collecting commits …\n');
const log = execFileSync(
  'git',
  ['-C', root, 'log', '--no-merges', '--format=%H%x1f%s%x1f%b%x1e', '-n', '900'],
  { maxBuffer: 64 * 1024 * 1024 },
).toString();

const inCorpus = new Set(files.map((f) => f.rel));
const cases: { query: string; targets: string[] }[] = [];
for (const entry of log.split('\x1e')) {
  const [hash, subject, body] = entry.trim().split('\x1f');
  if (!hash || !subject || subject.length < 12) continue;
  let changed: string[];
  try {
    changed = execFileSync('git', ['-C', root, 'show', '--name-only', '--format=', hash], {
      maxBuffer: 8 * 1024 * 1024,
    })
      .toString()
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => inCorpus.has(l));
  } catch {
    continue;
  }
  const targets = [...new Set(changed)];
  // One file is too easy to be interesting; a sweeping refactor has no single
  // right answer. What is left is ordinary work.
  if (targets.length < 1 || targets.length > 8) continue;
  cases.push({ query: `${subject} ${(body ?? '').slice(0, 400)}`, targets });
  if (cases.length >= MAX_CASES) break;
}
process.stderr.write(`  ${String(cases.length)} cases\n\n`);

/** The subset where the message never names a changed file: no free wins. */
const hard = cases.filter(
  (c) =>
    !c.targets.some((t) => {
      const base = (t.split('/').pop() ?? '').replace(SOURCE, '').toLowerCase();
      return base.length > 0 && c.query.toLowerCase().includes(base);
    }),
);

function score(name: string, rank: Ranker, subset: typeof cases): void {
  let r10 = 0;
  let r25 = 0;
  let mrr = 0;
  for (const c of subset) {
    const ranked = rank(c.query);
    const top10 = new Set(ranked.slice(0, 10).map((r) => r.file));
    const top25 = new Set(ranked.slice(0, 25).map((r) => r.file));
    r10 += c.targets.filter((t) => top10.has(t)).length / c.targets.length;
    r25 += c.targets.filter((t) => top25.has(t)).length / c.targets.length;
    const first = ranked.findIndex((r) => c.targets.includes(r.file));
    mrr += first < 0 ? 0 : 1 / (first + 1);
  }
  const n = Math.max(1, subset.length);
  process.stdout.write(
    `${name.padEnd(14)} recall@10 ${((100 * r10) / n).toFixed(1).padStart(5)}%   ` +
      `recall@25 ${((100 * r25) / n).toFixed(1).padStart(5)}%   ` +
      `MRR ${(mrr / n).toFixed(3)}\n`,
  );
}

process.stdout.write(`all ${String(cases.length)} cases\n`);
score('exact match', rankExact, cases);
score('shipped', rankShipped, cases);
process.stdout.write(`\nhard subset (${String(hard.length)}: message names no changed file)\n`);
score('exact match', rankExact, hard);
score('shipped', rankShipped, hard);
