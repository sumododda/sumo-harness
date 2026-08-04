/**
 * `changedFiles` decides whether the test-writing stage did anything, and which
 * paths get locked while the implementation is written. Both answers are wrong
 * if a newly created file is invisible to it — which is exactly what happens
 * when the question is asked with `git diff` alone.
 *
 * Found the hard way: a `feature` run wrote the first test for a module that had
 * none, and the harness declared that no tests had been written.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { changedFiles, run } from '../src/runner.ts';

async function repo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-changed-'));
  writeFileSync(join(dir, 'cart.js'), 'export const rate = 0.1;\n', 'utf8');
  await run('git init -q .', dir);
  await run('git add -A', dir);
  await run('git -c user.email=t@example.com -c user.name=Test commit -q -m first', dir);
  return dir;
}

test('a newly created file counts as changed', async () => {
  const dir = await repo();
  try {
    mkdirSync(join(dir, 'tests'));
    writeFileSync(join(dir, 'tests', 'cart.test.js'), 'test("x", () => {});\n', 'utf8');

    // `git diff --name-only HEAD` reports nothing here: git has never heard of
    // this file. Missing it made `feature` abort with "no test files were
    // written" immediately after writing one.
    assert.deepEqual(await changedFiles(dir), ['tests/cart.test.js']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('modified tracked files still count', async () => {
  const dir = await repo();
  try {
    writeFileSync(join(dir, 'cart.js'), 'export const rate = 0.25;\n', 'utf8');
    assert.deepEqual(await changedFiles(dir), ['cart.js']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('both kinds are reported together, without duplicates', async () => {
  const dir = await repo();
  try {
    writeFileSync(join(dir, 'cart.js'), 'export const rate = 0.25;\n', 'utf8');
    writeFileSync(join(dir, 'money.js'), 'export const zero = 0;\n', 'utf8');

    assert.deepEqual(await changedFiles(dir), ['cart.js', 'money.js']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a staged new file is not counted twice', async () => {
  const dir = await repo();
  try {
    writeFileSync(join(dir, 'money.js'), 'export const zero = 0;\n', 'utf8');
    await run('git add money.js', dir);

    // Staged-but-uncommitted appears in `git diff HEAD`; it must not also arrive
    // from the untracked list.
    assert.deepEqual(await changedFiles(dir), ['money.js']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ignored files are not reported', async () => {
  const dir = await repo();
  try {
    writeFileSync(join(dir, '.gitignore'), 'secret.txt\n', 'utf8');
    writeFileSync(join(dir, 'secret.txt'), 'shh\n', 'utf8');

    // `--exclude-standard` matters: without it every build artifact and every
    // .sumo/ file would be reported as work this task did.
    assert.deepEqual(await changedFiles(dir), ['.gitignore']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a clean repo reports nothing', async () => {
  const dir = await repo();
  try {
    assert.deepEqual(await changedFiles(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('outside a git repo it reports nothing rather than throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-nogit-changed-'));
  try {
    assert.deepEqual(await changedFiles(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
