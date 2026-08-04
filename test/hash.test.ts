/**
 * The fingerprint is what makes reuse safe, so its failure mode matters more
 * than its success: a digest that misses a change serves a stale answer as if it
 * were fresh. These tests are mostly about what must *not* compare equal.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hash, invalidate, repoFingerprint } from '../src/hash.ts';
import { run } from '../src/runner.ts';

/** A throwaway git repo with one committed file. */
async function repo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-hash-'));
  writeFileSync(join(dir, 'cart.js'), 'export const rate = 0.1;\n', 'utf8');
  await run('git init -q .', dir);
  await run('git add -A', dir);
  await run(
    'git -c user.email=t@example.com -c user.name=Test commit -q -m first',
    dir,
  );
  return dir;
}

/** The fingerprint memoises per process; every read here wants a fresh one. */
async function fresh(dir: string): Promise<string | null> {
  invalidate(dir);
  return await repoFingerprint(dir);
}

test('hash ignores key order but not values', () => {
  assert.equal(hash({ a: 1, b: 2 }), hash({ b: 2, a: 1 }));
  assert.notEqual(hash({ a: 1 }), hash({ a: 2 }));
  assert.notEqual(hash({ a: 1 }), hash({ b: 1 }));
});

test('hash separates its arguments', () => {
  // Without a delimiter these would both digest the string "abc".
  assert.notEqual(hash('ab', 'c'), hash('a', 'bc'));
});

test('hash is stable across calls and handles nesting', () => {
  const value = { files: ['a.ts', 'b.ts'], meta: { depth: 2, tags: [{ k: 'v' }] } };
  assert.equal(hash(value), hash(structuredClone(value)));
  assert.notEqual(hash(value), hash({ ...value, meta: { depth: 3, tags: [{ k: 'v' }] } }));
});

test('a clean repo fingerprints stably', async () => {
  const dir = await repo();
  try {
    const first = await fresh(dir);
    assert.ok(first, 'a git repo must be fingerprintable');
    assert.equal(await fresh(dir), first, 'nothing changed, so nothing may differ');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('editing a tracked file changes the fingerprint', async () => {
  const dir = await repo();
  try {
    const before = await fresh(dir);
    writeFileSync(join(dir, 'cart.js'), 'export const rate = 0.2;\n', 'utf8');
    assert.notEqual(await fresh(dir), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an untracked file changes the fingerprint, and so does its content', async () => {
  const dir = await repo();
  try {
    const clean = await fresh(dir);

    writeFileSync(join(dir, 'scratch.js'), 'const a = 1;\n', 'utf8');
    const added = await fresh(dir);
    assert.notEqual(added, clean, 'a new untracked file is a change');

    // The status line is identical here; only the bytes differ. Hashing the
    // listing alone would miss this.
    writeFileSync(join(dir, 'scratch.js'), 'const a = 2;\n', 'utf8');
    assert.notEqual(await fresh(dir), added, 'untracked content must be hashed, not just named');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file inside an untracked directory is seen', async () => {
  const dir = await repo();
  try {
    mkdirSync(join(dir, 'lib'));
    writeFileSync(join(dir, 'lib', 'util.js'), 'const a = 1;\n', 'utf8');
    const before = await fresh(dir);

    // Plain `git status --porcelain` collapses this to `?? lib/`, so the edit
    // below would be invisible without --untracked-files=all.
    writeFileSync(join(dir, 'lib', 'util.js'), 'const a = 2;\n', 'utf8');
    assert.notEqual(await fresh(dir), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('committing changes the fingerprint', async () => {
  const dir = await repo();
  try {
    writeFileSync(join(dir, 'cart.js'), 'export const rate = 0.3;\n', 'utf8');
    const dirty = await fresh(dir);

    await run('git add -A', dir);
    await run('git -c user.email=t@example.com -c user.name=Test commit -q -m second', dir);

    // The tree is identical; HEAD is not. Both are inputs to an answer.
    assert.notEqual(await fresh(dir), dirty);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deleting a tracked file changes the fingerprint', async () => {
  const dir = await repo();
  try {
    const before = await fresh(dir);
    rmSync(join(dir, 'cart.js'));
    assert.notEqual(await fresh(dir), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('outside a git repo there is no fingerprint, so nothing may be reused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-nogit-'));
  try {
    assert.equal(await fresh(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the fingerprint is memoised until invalidated', async () => {
  const dir = await repo();
  try {
    const before = await repoFingerprint(dir);
    writeFileSync(join(dir, 'cart.js'), 'export const rate = 0.9;\n', 'utf8');

    // Within a turn the tree is treated as fixed; only read-only stages reuse
    // results, so nothing they read was written after the key was computed.
    assert.equal(await repoFingerprint(dir), before);
    invalidate(dir);
    assert.notEqual(await repoFingerprint(dir), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
