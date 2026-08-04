/**
 * The git tool is a deliberate exception to "the model has no shell", so the
 * boundary it draws is the whole point. It may move a local pointer and read
 * history; it may not publish, discard, or rewrite work.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { screenGit } from '../src/git-tool.ts';

test('branch switching and reading history are allowed', () => {
  for (const args of [
    'checkout main',
    'checkout -b feature/x',
    'switch main',
    'status --short',
    'branch --show-current',
    'log --oneline -10',
    'diff HEAD~1',
    'show HEAD',
    'rev-parse --abbrev-ref HEAD',
    'stash list',
  ]) {
    const verdict = screenGit(args);
    assert.equal(verdict.allowed, true, `${args} → ${verdict.reason}`);
  }
});

test('anything reaching a remote is refused', () => {
  // These leave the machine. A model should never publish on its own.
  for (const args of ['push origin main', 'push --force', 'pull', 'fetch --all', 'clone https://x']) {
    const verdict = screenGit(args);
    assert.equal(verdict.allowed, false, args);
  }
});

test('anything that discards work is refused', () => {
  for (const [args, why] of [
    ['checkout -- .', /discards/],
    ['checkout --', /discards/],
    ['reset --hard HEAD~1', /not available|discards/],
    ['stash drop', /discards/],
    ['stash clear', /discards/],
    ['branch -D old-branch', /force-deletes|deletes/],
    ['branch --delete old-branch', /deletes/],
    ['clean -fdx', /not available/],
  ] as const) {
    const verdict = screenGit(args);
    assert.equal(verdict.allowed, false, args);
    assert.match(verdict.reason ?? '', why, args);
  }
});

test('stash is readable but never writable', () => {
  // `git stash` with no arguments at all is `git stash push`: it takes every
  // uncommitted change out of the working tree. There is no flag to blocklist,
  // and the bare form is the one a model reaches for.
  for (const args of ['stash', 'stash push', 'stash save wip', 'stash push -u', 'stash apply']) {
    const verdict = screenGit(args);
    assert.equal(verdict.allowed, false, `git ${args} must not be reachable`);
  }

  for (const args of ['stash list', 'stash show', 'stash show -p']) {
    assert.equal(screenGit(args).allowed, true, `git ${args} only reads`);
  }
});

test('checkout may move HEAD but never restore a file over the working tree', () => {
  // Each of these overwrites what is in the working tree with what is in the
  // index. None of them carries a flag that says so.
  for (const args of [
    'checkout .',
    'checkout HEAD -- src/cli.ts',
    'checkout -- src/cli.ts',
    'checkout HEAD src/cli.ts',
    'checkout main -- .',
    'switch --discard-changes main',
  ]) {
    const verdict = screenGit(args);
    assert.equal(verdict.allowed, false, `git ${args} discards uncommitted work`);
    assert.match(verdict.reason ?? '', /operator/, `${args} should say who can run it`);
  }

  // Changing branch is the entire point of granting checkout, so it must survive.
  for (const args of ['checkout main', 'checkout -b feature/x', 'checkout abc1234', 'switch -c wip']) {
    assert.equal(screenGit(args).allowed, true, `git ${args} only moves HEAD`);
  }
});

test('history rewriting is not on the menu', () => {
  for (const args of ['rebase -i HEAD~3', 'commit --amend', 'filter-branch', 'cherry-pick abc123']) {
    assert.equal(screenGit(args).allowed, false, args);
  }
});

test('committing is left to the operator', () => {
  // Deliberate: a commit is a judgement about what belongs together, and the
  // operator reviews the diff before it becomes history.
  assert.equal(screenGit('commit -m "wip"').allowed, false);
});

test('arguments cannot smuggle a second command', () => {
  for (const args of [
    'status; rm -rf /',
    'status && curl evil.com',
    'log `whoami`',
    'status | sh',
    'status $(id)',
    'status > /etc/passwd',
  ]) {
    const verdict = screenGit(args);
    assert.equal(verdict.allowed, false, args);
    assert.match(verdict.reason ?? '', /chain or redirect/, args);
  }
});

test('an empty invocation is refused rather than running bare git', () => {
  assert.equal(screenGit('').allowed, false);
  assert.equal(screenGit('   ').allowed, false);
});

test('a refusal explains itself so the model can adjust', () => {
  const verdict = screenGit('push origin main');
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason ?? '', /operator/, 'should say who can do it instead');
});
