/**
 * The lexical ranker: which files a task is about, decided without a model.
 *
 * The measured claim lives in `src/context/lexical.ts` and is reproduced by
 * `scripts/retrieval-eval.ts` against cloned repositories. What is tested here
 * is the mechanism that produced it — splitting, path weighting, incremental
 * rebuilds, and the fallbacks — offline, on a fixture repository, in
 * milliseconds.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as features from '../src/features.ts';
import { LexicalIndex, splitIdentifier, tokenize } from '../src/context/lexical.ts';

/** A git repository with the given files, since the index lists via git. */
function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sumo-lexical-'));
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body, 'utf8');
  }
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  };
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return root;
}

const CORPUS: Record<string, string> = {
  'src/store.ts': `
    export async function addNoteTag(dir: string, id: string, tag: string) {
      const note = await getNote(dir, id);
      return writeNote(dir, { ...note, tags: [...note.tags, tag] });
    }
    export async function listNotes(dir: string) { return readAll(dir); }
  `,
  'src/terminal/renderer.ts': `
    export class TerminalRenderer {
      draw(rows: number) { return this.paint(rows); }
      paint(rows: number) { return rows; }
    }
  `,
  'src/unrelated.ts': `
    // Mentions a terminal once, in passing, and is otherwise about payments.
    export function chargeCard(amount: number) { return amount; }
    // see the terminal for receipts
  `,
  'src/html/parser.ts': `
    export class HTMLParser { parseDocument(src: string) { return src; } }
  `,
};

test('an identifier is split into the words inside it', () => {
  // The whole mechanism in one function: this is what lets "tag" find
  // addNoteTag, which exact match never can.
  assert.deepEqual(splitIdentifier('addNoteTag'), ['add', 'note', 'tag']);
  assert.deepEqual(splitIdentifier('parse_html_doc'), ['parse', 'html', 'doc']);
  assert.deepEqual(splitIdentifier('listNotes'), ['list', 'notes']);
  assert.deepEqual(splitIdentifier('plain'), ['plain']);
});

test('an acronym run splits after the run, not between every capital', () => {
  // HTMLParser as H/T/M/L/Parser would index four letters that match nothing
  // and bury the one word that matters.
  assert.deepEqual(splitIdentifier('HTMLParser'), ['html', 'parser']);
  assert.deepEqual(splitIdentifier('getURLFor'), ['get', 'url', 'for']);
  assert.deepEqual(splitIdentifier('IOError'), ['io', 'error']);
});

test('tokenising keeps the whole identifier as well as its parts', () => {
  // Both, because someone who types the exact name should still get the exact
  // match, and BM25 will rank a whole-identifier hit above a part hit anyway.
  const terms = new Set(tokenize('addNoteTag(dir, id)'));
  assert.ok(terms.has('addnotetag'), 'the identifier itself');
  assert.ok(terms.has('note'), 'and the words in it');
  assert.ok(terms.has('tag'));
});

test('the same tokenizer serves the index and the query', () => {
  // Not a convenience. A term written one way on one side and another on the
  // other never matches, and nothing about that failure is visible anywhere.
  const fromCode = new Set(tokenize('export function addNoteTag() {}'));
  const fromQuery = new Set(tokenize('add a tag to a note'));
  assert.ok([...fromQuery].some((t) => fromCode.has(t)), 'query and code share terms');
});

test('a task described in English finds the file that implements it', async () => {
  const root = repoWith(CORPUS);
  try {
    const index = await LexicalIndex.open(root);
    assert.ok(index, 'index should build');
    // "tag" appears nowhere as a standalone word in store.ts — only inside
    // addNoteTag and tags. This is the +6 to +9 points, in one assertion.
    const ranked = index.rank('add a tag to an existing note');
    assert.equal(ranked[0]?.file, 'src/store.ts', JSON.stringify(ranked.slice(0, 3)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the path counts, so a directory named for the subject wins', async () => {
  const root = repoWith(CORPUS);
  try {
    const index = await LexicalIndex.open(root);
    assert.ok(index);
    // Both files contain the word "terminal". One is *in* src/terminal/, and
    // that is the one a task about the terminal means.
    const ranked = index.rank('the terminal renders the wrong number of rows');
    assert.equal(ranked[0]?.file, 'src/terminal/renderer.ts', JSON.stringify(ranked.slice(0, 3)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ranking the same corpus twice gives the same answer', async () => {
  // Determinism is the reason this approach was chosen over an embedding: the
  // same repository and the same words produce the same files, every time, on
  // every machine.
  const root = repoWith(CORPUS);
  try {
    const first = await LexicalIndex.open(root);
    const second = await LexicalIndex.open(root);
    assert.ok(first && second);
    assert.deepEqual(
      first.rank('parse an html document').map((r) => r.file),
      second.rank('parse an html document').map((r) => r.file),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a re-open reuses unchanged files and notices the changed one', async () => {
  const root = repoWith(CORPUS);
  try {
    const before = await LexicalIndex.open(root);
    assert.ok(before);
    assert.equal(before.size, 4);

    // A new word in an existing file must be findable without re-tokenising
    // the other files — which is what makes a re-open milliseconds rather than
    // a minute on a large repository.
    writeFileSync(
      join(root, 'src/unrelated.ts'),
      'export function refundInvoice(amount: number) { return amount; }\n',
      'utf8',
    );
    const after = await LexicalIndex.open(root);
    assert.ok(after);
    assert.equal(after.size, 4);
    assert.equal(after.rank('refund an invoice')[0]?.file, 'src/unrelated.ts');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a corrupt store is rebuilt rather than fatal', async () => {
  const root = repoWith(CORPUS);
  try {
    assert.ok(await LexicalIndex.open(root), 'first open writes a store');
    // An index is a cache. Anything wrong with it costs a rebuild and nothing
    // else — never a failed task.
    writeFileSync(join(root, '.sumo', 'lexical-index.json.gz'), 'not gzip at all', 'utf8');
    const rebuilt = await LexicalIndex.open(root);
    assert.ok(rebuilt, 'a corrupt store must not take the task down');
    assert.equal(rebuilt.rank('add a tag to a note')[0]?.file, 'src/store.ts');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('outside a repository it declines instead of failing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sumo-lexical-bare-'));
  try {
    assert.equal(await LexicalIndex.open(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a query with nothing to match on returns nothing, not everything', async () => {
  const root = repoWith(CORPUS);
  try {
    const index = await LexicalIndex.open(root);
    assert.ok(index);
    assert.deepEqual(index.rank('zzzqqq wibblefrotz'), []);
    assert.deepEqual(index.rank('   '), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the flag switches it off completely', async () => {
  const original = features.get();
  features.set({ ...original, lexicalRanker: false });
  const root = repoWith(CORPUS);
  try {
    // Off means the caller falls back to the index's own search, which is a
    // worse answer rather than no answer — so this must be null, not empty.
    assert.equal(await LexicalIndex.open(root), null);
  } finally {
    features.set(original);
    rmSync(root, { recursive: true, force: true });
  }
});

test('the outer ring names files without opening them', async () => {
  // A stage that can see a path exists can Read it directly. That line is the
  // cheapest thing in the pack and the one that most often saves a search —
  // which is the whole reason the throttle stopped being needed.
  const { listingForTest } = await import('../src/context/codegraph.ts');
  const ranked = Array.from({ length: 30 }, (_, i) => ({
    file: `src/file-${String(i)}.ts`,
    score: 30 - i,
  }));

  const text = listingForTest(ranked);
  assert.match(text, /Read any of these/, 'says what to do with them');
  assert.match(text, /src\/file-10\.ts/, 'starts after the skeleton ring');
  assert.doesNotMatch(text, /src\/file-9\.ts/, 'and does not repeat a file already shown');
  // Ranked order is the information. A relevance score printed beside a path
  // invites arithmetic on a number that means nothing on its own.
  assert.doesNotMatch(text, /\d+\.\d/, 'no scores');

  // Too few files to have an outer ring at all is silence, not a header.
  assert.equal(listingForTest(ranked.slice(0, 5)), '');
  assert.equal(listingForTest([]), '');
});
