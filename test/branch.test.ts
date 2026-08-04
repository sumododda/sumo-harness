/**
 * Branch handling touches the user's repo state, so its refusals matter as much
 * as its successes.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { branchNameFor, createBranch, currentBranch, run } from '../src/runner.ts';

async function repo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-branch-'));
  await run('git init -q', dir);
  await run('git config user.email t@t && git config user.name t', dir);
  writeFileSync(join(dir, 'a.txt'), 'hello\n', 'utf8');
  await run('git add -A && git commit -qm init', dir);
  return dir;
}

test('branch names are readable and derived from the task', () => {
  // Filler words are dropped so the name spends its length on meaning.
  assert.equal(
    branchNameFor('add a discount function to the cart'),
    'sumo/add-discount-function-cart',
  );
  // Punctuation and case must not leak into a ref name.
  assert.equal(branchNameFor('Fix: applyTax() returns NaN!'), 'sumo/fix-applytax-returns-nan');
  // Nonsense input still yields a usable name rather than an invalid ref.
  assert.equal(branchNameFor('!!!'), 'sumo/task');
});

test('the same work always names the same branch', () => {
  // The name used to carry a timestamp, so every attempt at one feature got a
  // branch of its own and the previous attempt was stranded on the last one.
  // Iterating is the normal case, and it has to land where the work already is.
  assert.equal(branchNameFor('add oauth login'), branchNameFor('add oauth login'));
  assert.doesNotMatch(branchNameFor('add oauth login'), /\d{6}T\d{4}/);
});

test('branch names stay valid git refs', () => {
  // git rejects refs with spaces, backslashes, ~ ^ : ? * [ and .. sequences.
  for (const task of [
    'add support for a/b testing',
    'fix the ~weird~ [thing]',
    'handle x^2 : y?',
    'deal with ..relative paths',
  ]) {
    const name = branchNameFor(task);
    assert.doesNotMatch(name.slice('sumo/'.length), /[\s~^:?*[\\]|\.\./, name);
  }
});

test('a branch is created and checked out', async () => {
  const dir = await repo();
  try {
    const result = await createBranch(dir, 'sumo/test-branch');
    assert.equal(result.kind, 'created');
    assert.equal(await currentBranch(dir), 'sumo/test-branch');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a dirty tree is left alone rather than stashed behind your back', async () => {
  const dir = await repo();
  try {
    writeFileSync(join(dir, 'a.txt'), 'uncommitted work\n', 'utf8');
    const before = await currentBranch(dir);

    const result = await createBranch(dir, 'sumo/should-not-happen');

    assert.equal(result.kind, 'skipped');
    assert.equal(await currentBranch(dir), before, 'must stay put');
    // The user's edit must survive untouched.
    const status = await run('git status --porcelain', dir);
    assert.match(status.output, /a\.txt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('outside a git repo it declines instead of failing the task', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-nogit-'));
  try {
    const result = await createBranch(dir, 'sumo/whatever');
    assert.equal(result.kind, 'skipped');
    assert.match(result.kind === 'skipped' ? result.why : '', /not a git repository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('running the same task again joins its branch instead of refusing', async () => {
  const dir = await repo();
  try {
    await createBranch(dir, 'sumo/taken');
    await run('git checkout -q -', dir);

    // This used to be refused, which meant the second attempt at a feature ran
    // with no branch at all — the work landed wherever the operator happened
    // to be standing.
    const second = await createBranch(dir, 'sumo/taken');
    assert.equal(second.kind, 'reused');
    assert.equal(await currentBranch(dir), 'sumo/taken');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a branch is never forked off another harness branch', async () => {
  const dir = await repo();
  try {
    await createBranch(dir, 'sumo/first-task');

    // Asking for a different branch while standing on one of ours: creating it
    // here would stack a branch on a branch, carrying the first task's commits
    // into the second. Three such branches once pointed at one commit with no
    // distinct work between them.
    const second = await createBranch(dir, 'sumo/second-task');

    assert.equal(second.kind, 'reused');
    assert.equal(second.kind === 'reused' ? second.branch : '', 'sumo/first-task');
    assert.equal(await currentBranch(dir), 'sumo/first-task', 'must stay put');

    // `rev-parse --verify` exits non-zero for a ref that is not there.
    const exists = await run('git rev-parse --verify --quiet sumo/second-task', dir);
    assert.equal(exists.ok, false, 'no second branch was created');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a dirty tree on a harness branch still joins it', async () => {
  const dir = await repo();
  try {
    await createBranch(dir, 'sumo/in-progress');
    writeFileSync(join(dir, 'a.txt'), 'work in flight\n', 'utf8');

    // Iterating mid-change is the normal case: the previous attempt left the
    // tree dirty, and the next attempt belongs on the same branch regardless.
    const again = await createBranch(dir, 'sumo/in-progress');
    assert.equal(again.kind, 'reused');
    assert.equal(await currentBranch(dir), 'sumo/in-progress');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
