/**
 * Task state is what `/resume` reads, and it lives in the user's repo — so both
 * its round-tripping and its refusal to touch tracked files matter.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { run } from '../src/runner.ts';
import { findRepo, TaskState } from '../src/state.ts';

async function repo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-state-'));
  await run('git init -q && git config user.email t@t && git config user.name t', dir);
  writeFileSync(join(dir, 'a.txt'), 'x\n', 'utf8');
  await run('git add -A && git commit -qm init', dir);
  return dir;
}

test('progress round-trips so /resume can read it', async () => {
  const dir = await repo();
  try {
    const state = new TaskState(findRepo(dir), 'task-1');
    state.saveProgress({ mode: 'fix', task: 'the cart is wrong', stage: 'root-cause', finished: false });

    const loaded = new TaskState(findRepo(dir), 'task-1').loadProgress();
    assert.deepEqual(loaded, {
      mode: 'fix',
      task: 'the cart is wrong',
      stage: 'root-cause',
      finished: false,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the newest task is the one resumed', async () => {
  const dir = await repo();
  try {
    const info = findRepo(dir);
    // Ids begin with a sortable timestamp, so ordering is by name.
    new TaskState(info, '20260101T000000-fix').saveProgress({
      mode: 'fix', task: 'older', stage: 'done', finished: true,
    });
    new TaskState(info, '20260601T000000-feature').saveProgress({
      mode: 'feature', task: 'newer', stage: 'plan', finished: false,
    });

    const latest = TaskState.latest(info);
    assert.equal(latest?.loadProgress()?.task, 'newer');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a repo with no tasks yields nothing rather than throwing', async () => {
  const dir = await repo();
  try {
    assert.equal(TaskState.latest(findRepo(dir)), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('corrupt progress is ignored instead of crashing the session', async () => {
  const dir = await repo();
  try {
    const state = new TaskState(findRepo(dir), 'task-bad');
    state.write('task.json', '{ not json');
    assert.equal(state.loadProgress(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('artifacts are hidden from git without touching a tracked .gitignore', async () => {
  const dir = await repo();
  try {
    new TaskState(findRepo(dir), 'task-1').write('plan.md', 'a plan\n');

    // The exclusion belongs in .git/info/exclude, which is not version
    // controlled — editing the user's .gitignore would show up in their diffs.
    const exclude = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8');
    assert.match(exclude, /^\.sumo\/$/m);
    // The index is a local cache and clutters git status just as much.
    assert.match(exclude, /^\.codegraph\/$/m);

    const status = await run('git status --porcelain', dir);
    assert.doesNotMatch(status.output, /\.sumo/, 'artifacts must not appear as changes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a task stopped at a gate is resumable, a delivered plan is not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-resume-'));
  try {
    const repo = { root: dir, isGit: false };

    // Rejecting a plan is exactly when you want to go again with different
    // framing. Recorded as finished, `/resume` showed the task and then
    // declined to pick it up, leaving retyping as the only way back.
    const stopped = new TaskState(repo, 'stopped-task');
    stopped.saveProgress({
      mode: 'feature',
      task: 'add a search command',
      stage: 'stopped',
      finished: false,
      note: 'you stopped it',
    });
    assert.equal(stopped.loadProgress()?.finished, false, 'stopped means resumable');

    // Declining to build in plan mode is different: the plan was the
    // deliverable, and re-running would redo work already done.
    const planned = new TaskState(repo, 'planned-task');
    planned.saveProgress({
      mode: 'plan',
      task: 'plan the search command',
      stage: 'planned',
      finished: true,
    });
    assert.equal(planned.loadProgress()?.finished, true, 'a delivered plan is done');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
