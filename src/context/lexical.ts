/**
 * Which files a task is about, decided lexically and locally.
 *
 * BM25 over identifiers that have been split into their parts, plus the file's
 * own path. No model, no embeddings, no network, no graph walk — a query is a
 * few map lookups and takes milliseconds.
 *
 * This exists because the index's own text search is exact-match, and exact
 * match loses to English. A task saying "tag" does not match `addNoteTag`, so
 * the pack comes back thin and the stage falls back to reading its way around
 * the repository — which is the cost the index was bought to remove.
 *
 * Measured against real commits, using each commit's message as the query and
 * the files it actually changed as the answer:
 *
 *     excalidraw, 150 commits, 635 files
 *       exact-match BM25          recall@10 55.6%   MRR 0.464
 *       + split identifiers                  64.5%       0.538
 *       + path tokens                        65.4%       0.547
 *
 *     VS Code, 200 commits, 8,125 files
 *       exact-match BM25          recall@10 50.0%   MRR 0.528
 *       + split identifiers                  56.2%       0.573
 *       + path tokens                        56.5%       0.578
 *
 * The gain holds on the hard subset — the 181 of 200 VS Code commits whose
 * message never names a file that changed — so it is not an artifact of commit
 * messages quoting filenames.
 *
 * Two things were measured and rejected, recorded here so they are not
 * reinvented. Fusing a reference-graph PageRank into the ranking scored *below*
 * splitting alone (55.5% on VS Code); confined to re-ranking BM25's own
 * candidates it drew level and bought nothing for a great deal of machinery.
 * And boosting a file's score from its one-hop neighbours collapsed to 0.5%
 * recall at VS Code's scale, because hub files swamp everything. Structural
 * relevance is real, but it belongs where CodeGraph already applies it — the
 * call paths around a file that has already been chosen — not in choosing.
 *
 * `scripts/retrieval-eval.ts` reproduces all of the above.
 */

import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as features from '../features.ts';
import { runUntruncated } from '../runner.ts';

/** Format version. A bump invalidates every stored index rather than migrating one. */
const FORMAT = 1;

/**
 * How much a path token counts for, against one occurrence in the body.
 *
 * A path is chosen deliberately and only once, so a token in it says far more
 * about what a file is for than the same token appearing once somewhere inside
 * it. Eight was the smallest weight that captured the measured gain; the metric
 * is flat between roughly four and sixteen, so this is not a tuned constant so
 * much as an order of magnitude.
 */
const PATH_WEIGHT = 8;

/** Standard BM25 saturation and length-normalisation. */
const K1 = 1.2;
const B = 0.75;

/** Files above this are almost always generated — a bundle, a lockfile, a fixture dump. */
const MAX_FILE_BYTES = 1_500_000;

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|cs|swift|kt|scala|c|h|cc|cpp|hpp|sh)$/;

/**
 * Words that appear everywhere and therefore distinguish nothing.
 *
 * Deliberately short. BM25 already discounts a term that appears in most
 * documents, so a long list mostly removes signal the maths would have handled;
 * what earns a place here is language keywords and the verbs every commit
 * message opens with, which are frequent in *queries* where BM25 has no
 * statistics to lean on.
 */
const STOP = new Set([
  'the', 'and', 'for', 'this', 'that', 'with', 'from', 'into', 'are', 'was', 'not', 'but',
  'const', 'let', 'var', 'function', 'return', 'import', 'export', 'class', 'interface',
  'type', 'extends', 'implements', 'new', 'void', 'undefined', 'null', 'true', 'false',
  'string', 'number', 'boolean', 'async', 'await', 'public', 'private', 'protected',
  'readonly', 'static', 'default', 'require', 'module', 'exports',
  'fix', 'fixes', 'fixed', 'add', 'adds', 'added', 'update', 'updates', 'updated',
  'remove', 'removes', 'removed', 'make', 'makes', 'made', 'use', 'uses', 'used',
  'change', 'changes', 'changed', 'please', 'should', 'would', 'could', 'can',
]);

/**
 * An identifier and the words inside it.
 *
 * This is the whole trick. `addNoteTag` indexed as one opaque token can only be
 * found by someone who already knows to type `addNoteTag`; indexed also as
 * `add`, `note`, `tag` it is found by someone describing what they want. The
 * literature calls the problem vocabulary mismatch and splitting is its oldest
 * answer; the measurement at the top of this file is what earned it a place.
 *
 * Acronym runs are the case worth care: `HTMLParser` splits after the run
 * rather than between every capital, giving `html` and `parser` instead of
 * five useless letters.
 */
export function splitIdentifier(ident: string): string[] {
  const parts = ident
    .replace(/[_\-.]+/g, ' ')
    // A lower-or-digit followed by an upper starts a new word: addNote → add Note.
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    // A run of uppers followed by an upper-lower is an acronym then a word:
    // HTMLParser → HTML Parser, rather than H T M L Parser.
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(' ')
    .filter((p) => p.length > 0);

  return parts;
}

/**
 * Text to searchable terms: every identifier, plus its parts when they differ.
 *
 * The same function serves the index and the query, which is not a convenience
 * but the requirement — a term written one way on one side and another way on
 * the other simply never matches, and nothing about the failure is visible.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) {
    const ident = match[0];
    const whole = ident.toLowerCase();
    if (!STOP.has(whole)) out.push(whole);

    const parts = splitIdentifier(ident);
    // Only when splitting actually said something new.
    if (parts.length > 1) {
      for (const part of parts) {
        if (part.length > 2 && !STOP.has(part)) out.push(part);
      }
    }
  }
  return out;
}

/** Path terms: directory names and the basename, split like any identifier. */
function pathTokens(path: string): string[] {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    const bare = segment.replace(SOURCE, '');
    for (const part of splitIdentifier(bare)) {
      if (part.length > 2 && !STOP.has(part)) out.push(part);
    }
  }
  return out;
}

export interface RankedFile {
  readonly file: string;
  readonly score: number;
}

/** One file's contribution to the index. Small enough that thousands persist cheaply. */
interface Entry {
  /** Content hash, so an unchanged file is never tokenised twice. */
  readonly h: string;
  /** Term frequencies, path terms already weighted in. */
  readonly tf: Record<string, number>;
  /** Total term count, for BM25's length normalisation. */
  readonly len: number;
}

interface Stored {
  readonly format: number;
  readonly entries: Record<string, Entry>;
}

export class LexicalIndex {
  private readonly entries: Map<string, Entry>;
  private readonly df = new Map<string, number>();
  private readonly avgLen: number;

  private constructor(entries: Map<string, Entry>) {
    this.entries = entries;
    let total = 0;
    for (const entry of entries.values()) {
      total += entry.len;
      for (const term of Object.keys(entry.tf)) {
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
      }
    }
    this.avgLen = entries.size > 0 ? total / entries.size : 1;
  }

  /** How many files are indexed. Exposed so a caller can report emptiness honestly. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Opens the index for a repository, building or updating it as needed.
   *
   * Returns null rather than throwing, on every failure: no repository, no
   * tracked files, an unreadable store. A ranking is an optimisation, and the
   * caller's fallback — the index's own search — is a worse answer rather than
   * no answer.
   */
  static async open(root: string): Promise<LexicalIndex | null> {
    if (!features.get().lexicalRanker) return null;

    try {
      const listed = await runUntruncated('git ls-files', root, 20_000);
      if (!listed.ok) return null;

      const paths = listed.output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && SOURCE.test(line));
      if (paths.length === 0) return null;

      const previous = load(root);
      const entries = new Map<string, Entry>();

      for (const path of paths) {
        const full = join(root, path);
        let text: string;
        try {
          text = readFileSync(full, 'utf8');
        } catch {
          // Listed by git but not on disk, or not text. Nothing to index.
          continue;
        }
        if (text.length > MAX_FILE_BYTES) continue;

        const h = createHash('sha1').update(text).digest('hex').slice(0, 16);
        const before = previous?.get(path);
        // The reason a re-open is milliseconds rather than a minute: on a repo
        // the size of VS Code almost every file is byte-identical to last time,
        // and tokenising is the only expensive step.
        if (before && before.h === h) {
          entries.set(path, before);
          continue;
        }

        const tf: Record<string, number> = {};
        let len = 0;
        for (const term of tokenize(text)) {
          tf[term] = (tf[term] ?? 0) + 1;
          len += 1;
        }
        for (const term of pathTokens(path)) {
          tf[term] = (tf[term] ?? 0) + PATH_WEIGHT;
          len += PATH_WEIGHT;
        }
        entries.set(path, { h, tf, len });
      }

      if (entries.size === 0) return null;
      save(root, entries);
      return new LexicalIndex(entries);
    } catch {
      return null;
    }
  }

  /**
   * The files most likely to matter to a task, best first.
   *
   * Plain BM25. The work that made it accurate happened in `tokenize`, not
   * here — which is the point worth remembering if this is ever tuned: the
   * measured gain came from what the terms are, not from how they are scored.
   */
  rank(query: string, limit = 40): RankedFile[] {
    const terms = new Set(tokenize(query));
    if (terms.size === 0) return [];

    const N = this.entries.size;
    const scores = new Map<string, number>();

    for (const term of terms) {
      const n = this.df.get(term);
      if (n === undefined) continue;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));

      for (const [path, entry] of this.entries) {
        const f = entry.tf[term];
        if (f === undefined) continue;
        const norm = 1 - B + (B * entry.len) / this.avgLen;
        scores.set(path, (scores.get(path) ?? 0) + idf * ((f * (K1 + 1)) / (f + K1 * norm)));
      }
    }

    return [...scores.entries()]
      .map(([file, score]) => ({ file, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

/** Where a repository's index lives. Beside the other per-repo state. */
function storePath(root: string): string {
  return join(root, '.sumo', 'lexical-index.json.gz');
}

/**
 * Reads the stored index, or nothing.
 *
 * Gzipped because the uncompressed form is around a hundred megabytes on a
 * repository the size of VS Code, and about a tenth of that compressed. Any
 * failure — absent, truncated, written by an older format — returns null and
 * costs a rebuild, which is the correct price for a cache that cannot be
 * trusted.
 */
function load(root: string): Map<string, Entry> | null {
  try {
    const path = storePath(root);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as Stored;
    if (parsed.format !== FORMAT) return null;
    return new Map(Object.entries(parsed.entries));
  } catch {
    return null;
  }
}

/** Persists the index. A failure here is slower, never wrong. */
function save(root: string, entries: Map<string, Entry>): void {
  try {
    const path = storePath(root);
    mkdirSync(dirname(path), { recursive: true });
    const stored: Stored = { format: FORMAT, entries: Object.fromEntries(entries) };
    writeFileSync(path, gzipSync(Buffer.from(JSON.stringify(stored), 'utf8')));
  } catch {
    // Read-only checkout, full disk. The next open rebuilds.
  }
}
