/**
 * The search the harness runs itself.
 *
 * The block it produces is prompt-facing, so it is checked here rather than by
 * eye: it is what a research stage reads before it decides what to fetch, and a
 * URL lost between `ddgr` and the prompt is a citation the stage cannot make.
 *
 * The live search is exercised only when `ddgr` is actually installed, the same
 * way the token-count check skips without credentials. It is free and local, so
 * there is nothing to gate behind `SUMO_E2E`.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { resultsBlock, type Result, search } from '../src/websearch.ts';

function ddgrInstalled(): boolean {
  try {
    execFileSync('ddgr', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const RESULTS: readonly Result[] = [
  {
    title: 'Voice Interface API Documentation',
    url: 'https://api-docs.wisprflow.ai/introduction',
    abstract: "Flow's Voice interface API converts audio into text.",
  },
  { title: 'Quickstart', url: 'https://api-docs.wisprflow.ai/quickstart', abstract: '' },
];

test('every URL survives into the block, because each one is a citation', () => {
  const block = resultsBlock(RESULTS);
  for (const r of RESULTS) {
    assert.ok(block.includes(r.url), `${r.url} never reached the prompt`);
  }
});

test('the block says the results are a starting point, not the answer', () => {
  // Without this the stage treats five summaries as the whole of the web and
  // stops, which is worse than not having searched: it looks researched.
  const block = resultsBlock(RESULTS);
  assert.match(block, /starting point/i);
  assert.match(block, /cite/i);
  assert.match(block, /fetch/i);
});

test('a result with no summary is still offered, not dropped', () => {
  // DuckDuckGo omits the abstract often enough to matter, and a title and a URL
  // are still worth fetching. Dropping it would shrink the result set in a way
  // nothing downstream could notice.
  const block = resultsBlock(RESULTS);
  assert.ok(block.includes('https://api-docs.wisprflow.ai/quickstart'));
});

test('the block ends with a blank line, so it cannot run into the question', () => {
  // It is concatenated straight onto the next part by `render`.
  assert.ok(resultsBlock(RESULTS).endsWith('\n\n'));
});

test('an empty query is not a search', async () => {
  assert.equal(await search('   '), null);
});

test('a real search returns results with usable URLs', { skip: !ddgrInstalled() }, async () => {
  const found = await search('DuckDuckGo', 3);

  assert.ok(found, 'ddgr is installed but returned nothing');
  assert.ok(found.length > 0 && found.length <= 3);
  for (const r of found) {
    assert.match(r.url, /^https?:\/\//, 'a result must be somewhere the stage can go');
    assert.equal(typeof r.title, 'string');
    assert.equal(typeof r.abstract, 'string');
  }
});

test('the same query is not searched twice in a session', { skip: !ddgrInstalled() }, async () => {
  // Not for speed. A stage's cache key is its prompt, so a results block that
  // changed between two identical questions would make research the one
  // read-only mode that could never be replayed.
  const first = await search('DuckDuckGo', 3);
  const second = await search('DuckDuckGo', 3);
  assert.deepEqual(second, first);
});
