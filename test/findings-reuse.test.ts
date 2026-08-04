/**
 * Reusing a previous run's survey of the repository.
 *
 * The stage cache was supposed to make a retry free and did not: its key is the
 * exact prompt, and the prompt carried the conversation, which grows every turn.
 * So a task that failed late re-surveyed the repository and paid full price for
 * an answer it already had — measured across 30 real tasks, the cache saved
 * $0.09 of $4.60.
 *
 * Dropping the conversation from the survey stages fixes the common case. This
 * covers the rest: a cleared or evicted cache, where the repository is
 * nonetheless byte-for-byte what it was.
 *
 * The refusal matters more than the reuse. Findings describe files, so handing
 * them to a plan written against different files is not a stale answer, it is a
 * confidently wrong one — which is why every case here that changes something
 * asserts nothing is reused.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type RepoInfo, TaskState } from '../src/state.ts';

const TASK = 'add a tags command listing each tag with a count';
const FINDINGS = 'Files\n  src/cli.ts\nReuse\n  listNotes  src/store.ts';

/** Writes a finished survey into a repo, under a sortable id. */
function saveSurvey(repo: RepoInfo, id: string, task: string, fingerprint: string, text = FINDINGS): void {
  const state = new TaskState(repo, id);
  state.write('explore.md', text);
  state.write('fingerprint.txt', fingerprint);
  state.write('task.json', JSON.stringify({ mode: 'plan', task, stage: 'planned' }));
}

function withRepo(fn: (repo: RepoInfo) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'sumo-findings-'));
  try {
    fn({ root, isGit: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the same task against the same repository reuses the survey', () => {
  withRepo((repo) => {
    saveSurvey(repo, '20260801T000000-plan', TASK, 'abc123');
    assert.equal(TaskState.findFindings(repo, TASK, 'abc123'), FINDINGS);
  });
});

test('a changed repository is surveyed again, not reused', () => {
  // The property that makes this safe to do at all. A survey names files; if
  // those files moved, saying so from memory is worse than not saying it.
  withRepo((repo) => {
    saveSurvey(repo, '20260801T000000-plan', TASK, 'abc123');
    assert.equal(TaskState.findFindings(repo, TASK, 'DIFFERENT'), null);
  });
});

test('a different task is surveyed again, even on the same repository', () => {
  withRepo((repo) => {
    saveSurvey(repo, '20260801T000000-plan', TASK, 'abc123');
    assert.equal(TaskState.findFindings(repo, 'something else entirely', 'abc123'), null);
  });
});

test('the newest matching survey wins', () => {
  withRepo((repo) => {
    saveSurvey(repo, '20260801T000000-plan', TASK, 'abc123', 'OLDER');
    saveSurvey(repo, '20260809T000000-plan', TASK, 'abc123', 'NEWER');
    assert.equal(TaskState.findFindings(repo, TASK, 'abc123'), 'NEWER');
  });
});

test('an empty survey is not offered as one', () => {
  // A stage that ended early can leave the file behind with nothing in it, and
  // an empty survey reused is a plan written against no findings at all.
  withRepo((repo) => {
    saveSurvey(repo, '20260801T000000-plan', TASK, 'abc123');
    writeFileSync(
      join(repo.root, '.sumo', 'tasks', '20260801T000000-plan', 'explore.md'),
      '   \n',
      'utf8',
    );
    assert.equal(TaskState.findFindings(repo, TASK, 'abc123'), null);
  });
});

test('a repository with no history at all is simply surveyed', () => {
  withRepo((repo) => {
    assert.equal(TaskState.findFindings(repo, TASK, 'abc123'), null);
  });
});
