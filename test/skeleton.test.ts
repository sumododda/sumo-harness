/**
 * `skeleton()` is the mechanism bug #22 asks for: signatures a survey stage can
 * judge relevance from, without paying to `Read` a whole file. These tests run
 * a real (tiny) index, because the thing being pinned down is what the indexed
 * `signature` column actually contains — a hand-built fake would only prove the
 * test's own assumptions about that column, not CodeGraph's.
 */

import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { CodeGraphContext } from '../src/context/codegraph.ts';
import * as features from '../src/features.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Copies the fixture somewhere disposable so the index it builds never lands in the repo. */
function stage(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-skeleton-'));
  cpSync(join(FIXTURES, 'skeleton'), dir, { recursive: true });
  return dir;
}

afterEach(() => {
  features.set({ skeletonContext: true });
});

test('the skeleton names every exported signature and drops every body', async (t) => {
  const dir = stage();
  try {
    const ctx = await CodeGraphContext.open(dir, true);
    if (!ctx) {
      t.skip('no codegraph platform binary available to build a real index');
      return;
    }

    const text = await ctx.skeleton(['widget.ts']);

    assert.match(text, /class Widget/);
    assert.match(text, /constructor\(name: string\)/);
    assert.match(text, /async render\(size: number\): Promise<string>/);
    assert.match(text, /makeWidget\(name: string\): Widget/);
    assert.match(text, /const DEFAULT_SIZE/);

    // No function or method body statement leaked through.
    assert.doesNotMatch(text, /for \(/);
    assert.doesNotMatch(text, /total \+=/);
    assert.doesNotMatch(text, /return/);
    // Unexported, so not part of the surface a skeleton describes.
    assert.doesNotMatch(text, /secret/);

    const full = readFileSync(join(dir, 'widget.ts'), 'utf8');
    assert.ok(
      text.length < full.length * 0.6,
      `skeleton (${text.length} chars) should be materially smaller than the file (${full.length} chars)`,
    );

    await ctx.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a path with nothing indexed yields nothing, not a throw', async (t) => {
  const dir = stage();
  try {
    const ctx = await CodeGraphContext.open(dir, true);
    if (!ctx) {
      t.skip('no codegraph platform binary available to build a real index');
      return;
    }
    assert.equal(await ctx.skeleton(['does/not/exist.ts']), '');
    await ctx.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the flag gates whether pack prepends a skeleton block', async (t) => {
  const dir = stage();
  try {
    const ctx = await CodeGraphContext.open(dir, true);
    if (!ctx) {
      t.skip('no codegraph platform binary available to build a real index');
      return;
    }

    features.set({ skeletonContext: false });
    const off = await ctx.pack('Widget render');
    assert.doesNotMatch(off, /Skeletons —/);

    features.set({ skeletonContext: true });
    const on = await ctx.pack('Widget render');
    assert.match(on, /Skeletons —/);
    assert.match(on, /class Widget/);

    await ctx.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
