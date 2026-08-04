/**
 * The disk is not clean between retries just because the prompt is.
 *
 * `fixUntilVerified` and `implementUntilVerified` already start each retry on a
 * fresh stage carrying only a failure-table summary — never the failed
 * attempt's conversation. But until this brief, whatever the failed attempt
 * actually wrote stayed on disk, so a prompt that reads as "make exactly this
 * change" ran against a tree that already had a previous, failed attempt's
 * edits sitting in it.
 *
 * The property that matters most, and the one proven first: a file that was
 * already dirty before the task started must survive every retry byte for
 * byte. Everything else here follows the same shape `test/fix-gates.test.ts`
 * and `test/feature-handoff.test.ts` use — a stub engine that writes real
 * files to a real fixture repo, and a scripted test command that fails on
 * demand — so the retry loop this exercises is the real one, not a
 * reimplementation of its set-difference logic.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import type { Interface } from 'node:readline/promises';
import type { Engine, StageRequest } from '../src/engine/index.ts';
import * as features from '../src/features.ts';
import { LineReader } from '../src/input.ts';
import { Ledger } from '../src/ledger.ts';
import { run } from '../src/runner.ts';
import { findRepo, TaskState } from '../src/state.ts';
import type { StageResult } from '../src/types.ts';
import { type ApprovedPlan, runFeature } from '../src/workflows/feature.ts';
import { runFix } from '../src/workflows/fix.ts';

afterEach(() => {
  features.set({ cleanRetries: true });
});

function scriptedInput(answers: readonly string[]): LineReader {
  const emitter = new EventEmitter() as Interface;
  const reader = new LineReader(emitter);
  for (const answer of answers) emitter.emit('line', answer);
  return reader;
}

const STUB_RESULT = {
  costUsd: 0,
  turns: 1,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  denials: [],
} as const;

/**
 * Fails a given number of times after the pre-existing-failure baseline that
 * `fix` runs before anything else, then passes. Mirrors
 * `test/escalate-loop.test.ts`'s `scriptedTests`.
 */
function scriptedTests(dir: string, failures: number): string {
  const script = join(dir, 'fake-tests.sh');
  const counter = join(dir, 'runs.txt');
  writeFileSync(counter, '0', 'utf8');
  writeFileSync(
    script,
    `#!/bin/sh
n=$(cat ${counter})
n=$((n + 1))
echo $n > ${counter}
if [ "$n" -eq 1 ]; then
  echo "ok"
  exit 0
fi
m=$((n - 1))
if [ "$m" -le ${failures} ]; then
  echo "still broken (attempt $m)"
  exit 1
fi
echo "ok"
exit 0
`,
    'utf8',
  );
  chmodSync(script, 0o755);
  return script;
}

/**
 * Fails on the exact call numbers given, passes on the rest. Mirrors
 * `test/feature-handoff.test.ts`'s `scriptedSuite`.
 */
function scriptedSuite(dir: string, failOn: readonly number[]): string {
  const script = join(dir, 'suite.sh');
  const counter = join(dir, 'runs.txt');
  writeFileSync(counter, '0', 'utf8');
  writeFileSync(
    script,
    `#!/bin/sh
n=$(cat ${counter})
n=$((n + 1))
echo $n > ${counter}
case " ${failOn.join(' ')} " in
  *" $n "*) echo "not implemented yet (run $n)"; exit 1 ;;
esac
echo ok
exit 0
`,
    'utf8',
  );
  chmodSync(script, 0o755);
  return script;
}

interface FixSnapshot {
  readonly attempt: number;
  readonly trackedAtStart: string;
  readonly preDirtyAtStart: string;
  readonly strayFromPreviousExists: boolean;
}

/**
 * Simulates a failed `fix` attempt actually writing to disk: it edits the
 * tracked file and creates a brand-new one, every time it runs — the exact
 * shape a real failed attempt leaves behind. Before doing either, it records
 * what it found already on disk, which is how the tests below observe
 * whether the previous attempt's mess was cleaned up before this one started.
 */
function stubFixEngine(snapshots: FixSnapshot[]): Engine {
  let attempt = 0;
  return {
    name: 'stub',
    modelFor: (tier) => `stub-${tier}`,
    supportsEffort: () => true,
    async runStage(req: StageRequest): Promise<StageResult> {
      if (req.stage === 'fix') {
        attempt += 1;
        const trackedPath = join(req.cwd, 'tracked.txt');
        const preDirtyPath = join(req.cwd, 'pre-dirty.txt');
        snapshots.push({
          attempt,
          trackedAtStart: readFileSync(trackedPath, 'utf8'),
          preDirtyAtStart: readFileSync(preDirtyPath, 'utf8'),
          strayFromPreviousExists: existsSync(join(req.cwd, `stray-${attempt - 1}.txt`)),
        });
        writeFileSync(trackedPath, `edited by attempt ${attempt}\n`, 'utf8');
        writeFileSync(join(req.cwd, `stray-${attempt}.txt`), `created by attempt ${attempt}\n`, 'utf8');
      }
      return {
        stage: req.stage,
        output: req.stage === 'root-cause' ? 'Root cause: something is broken.' : 'done',
        rung: req.rung,
        model: `stub-${req.rung.tier}`,
        ...STUB_RESULT,
      };
    },
  };
}

/**
 * A file already dirty — modified, uncommitted — before `runFix` is even
 * called, standing in for whatever the operator had in flight when the task
 * started.
 */
async function fixFixture(failures: number) {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-clean-retries-fix-'));
  await run('git init -q && git config user.email t@t && git config user.name t', dir);
  writeFileSync(join(dir, 'tracked.txt'), 'committed\n', 'utf8');
  writeFileSync(join(dir, 'pre-dirty.txt'), 'orig\n', 'utf8');
  await run('git add -A && git commit -qm init', dir);

  writeFileSync(join(dir, 'pre-dirty.txt'), "the operator's own in-flight edit\n", 'utf8');

  const snapshots: FixSnapshot[] = [];
  return {
    dir,
    snapshots,
    ctx: {
      engine: stubFixEngine(snapshots),
      ledger: new Ledger(),
      state: new TaskState(findRepo(dir), 'clean-retries-fix'),
      cwd: dir,
      input: scriptedInput([]),
      isTty: true,
      autoApprove: true,
      testCommand: scriptedTests(dir, failures),
    },
  };
}

test('a file dirty before the task started survives every fix retry untouched', async () => {
  const { dir, snapshots, ctx } = await fixFixture(1);
  try {
    const outcome = await runFix('something is broken', { tier: 'small' }, ctx);

    assert.equal(outcome.kind, 'fixed');
    assert.ok(snapshots.length >= 2, 'must have retried at least once to exercise the revert path');

    for (const snap of snapshots) {
      assert.equal(
        snap.preDirtyAtStart,
        "the operator's own in-flight edit\n",
        'a file dirty before the task started must never be touched by a retry',
      );
    }
    assert.equal(
      readFileSync(join(dir, 'pre-dirty.txt'), 'utf8'),
      "the operator's own in-flight edit\n",
      'and it must still be exactly that after the task finishes',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed attempt\'s own edits are reverted before the next attempt runs', async () => {
  const { dir, snapshots, ctx } = await fixFixture(1);
  try {
    const outcome = await runFix('something is broken', { tier: 'small' }, ctx);
    assert.equal(outcome.kind, 'fixed');

    assert.ok(snapshots.length >= 2, 'must have retried to observe the revert');
    const second = snapshots[1];
    assert.ok(second, 'a second attempt must have run');
    assert.equal(
      second.trackedAtStart,
      'committed\n',
      'the previous attempt\'s edit to a tracked file must be undone before the retry — not left half-applied',
    );
    assert.equal(
      second.strayFromPreviousExists,
      false,
      'the previous attempt\'s brand-new file must be deleted, not left behind — git checkout -- alone would not do this',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with cleanRetries off, a failed attempt\'s stray file is not reverted', async () => {
  features.set({ cleanRetries: false });
  const { dir, snapshots, ctx } = await fixFixture(1);
  try {
    const outcome = await runFix('something is broken', { tier: 'small' }, ctx);
    assert.equal(outcome.kind, 'fixed');

    assert.ok(snapshots.length >= 2, 'must have retried to observe the (absent) revert');
    const second = snapshots[1];
    assert.ok(second, 'a second attempt must have run');
    assert.equal(
      second.trackedAtStart,
      'edited by attempt 1\n',
      'with the flag off, the previous edit is left exactly as the failed attempt made it',
    );
    assert.equal(
      second.strayFromPreviousExists,
      true,
      'with the flag off, the previous attempt\'s stray file is left in place',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('outside a git repo the retry loop neither throws nor attempts a revert', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-clean-retries-nogit-'));
  writeFileSync(join(dir, 'tracked.txt'), 'committed\n', 'utf8');
  writeFileSync(join(dir, 'pre-dirty.txt'), 'orig\n', 'utf8');

  const snapshots: FixSnapshot[] = [];
  try {
    const outcome = await runFix('something is broken', { tier: 'small' }, {
      engine: stubFixEngine(snapshots),
      ledger: new Ledger(),
      state: new TaskState(findRepo(dir), 'clean-retries-fix-nogit'),
      cwd: dir,
      input: scriptedInput([]),
      isTty: true,
      autoApprove: true,
      testCommand: scriptedTests(dir, 1),
    });

    assert.equal(outcome.kind, 'fixed');
    assert.ok(snapshots.length >= 2, 'must have retried without throwing');
    // Without git, `changedFiles` cannot say what changed, so the retry loop
    // must skip the revert entirely rather than guess — the stray file from
    // the first attempt is still exactly where that attempt left it.
    assert.equal(existsSync(join(dir, 'stray-1.txt')), true, 'nothing was reverted with no git to consult');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface ImplementSnapshot {
  readonly attempt: number;
  readonly testFileExists: boolean;
  readonly testFileContent: string | null;
  readonly strayFromPreviousExists: boolean;
}

const LOCKED_TEST_CONTENT = 'describe("x", () => {});\n';

function stubFeatureEngine(snapshots: ImplementSnapshot[]): Engine {
  let attempt = 0;
  return {
    name: 'stub',
    modelFor: (tier) => `stub-${tier}`,
    supportsEffort: () => true,
    async runStage(req: StageRequest): Promise<StageResult> {
      if (req.stage === 'write-tests') {
        writeFileSync(join(req.cwd, 'added.test.ts'), LOCKED_TEST_CONTENT, 'utf8');
      }

      if (req.stage === 'implement') {
        attempt += 1;
        const testPath = join(req.cwd, 'added.test.ts');
        const exists = existsSync(testPath);
        snapshots.push({
          attempt,
          testFileExists: exists,
          testFileContent: exists ? readFileSync(testPath, 'utf8') : null,
          strayFromPreviousExists: existsSync(join(req.cwd, `impl-stray-${attempt - 1}.txt`)),
        });
        // A failed attempt's own source edit — not the locked test.
        writeFileSync(join(req.cwd, `impl-stray-${attempt}.txt`), `attempt ${attempt}\n`, 'utf8');
      }

      return {
        stage: req.stage,
        output: 'done',
        rung: req.rung,
        model: `stub-${req.rung.tier}`,
        ...STUB_RESULT,
      };
    },
  };
}

const APPROVED: ApprovedPlan = {
  plan: 'Approach:\n  Add the thing.',
  findings: 'Files:\n  - a.txt',
  tests: 1,
};

async function featureFixture(failOn: readonly number[]) {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-clean-retries-feature-'));
  // Kept outside the repo, same reason test/feature-handoff.test.ts does: an
  // untracked script inside it would be a dirty tree before branching even runs.
  const aux = mkdtempSync(join(tmpdir(), 'sumo-clean-retries-feature-aux-'));

  await run('git init -q && git config user.email t@t && git config user.name t', dir);
  writeFileSync(join(dir, 'a.txt'), 'x\n', 'utf8');
  await run('git add -A && git commit -qm init', dir);

  const snapshots: ImplementSnapshot[] = [];
  return {
    dir,
    snapshots,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(aux, { recursive: true, force: true });
    },
    ctx: {
      engine: stubFeatureEngine(snapshots),
      ledger: new Ledger(),
      state: new TaskState(findRepo(dir), 'clean-retries-feature'),
      cwd: dir,
      input: scriptedInput(['y', 'y', 'y']),
      isTty: true,
      autoApprove: false,
      testCommand: scriptedSuite(aux, failOn),
    },
  };
}

test('a locked test file survives every implement retry untouched', async () => {
  // Suite runs: 1 pre-existing (green), 2 prove-failing (red, as required),
  // 3 first implement verify (red, forces a retry), 4 second (green).
  const { snapshots, cleanup, ctx } = await featureFixture([2, 3]);
  try {
    const outcome = await runFeature('add the thing', { tier: 'small' }, ctx, '', APPROVED);

    assert.equal(outcome.kind, 'built');
    assert.ok(snapshots.length >= 2, 'must have retried at least once to exercise the revert path');

    for (const snap of snapshots) {
      assert.equal(
        snap.testFileExists,
        true,
        'the test file written this task must never be deleted by an implement retry',
      );
      assert.equal(
        snap.testFileContent,
        LOCKED_TEST_CONTENT,
        'the test file written this task must never be altered by an implement retry',
      );
    }

    // The exclusion is specific to the locked test files — an ordinary stray
    // file from a failed attempt is still cleaned up as usual.
    const second = snapshots[1];
    assert.ok(second, 'a second attempt must have run');
    assert.equal(
      second.strayFromPreviousExists,
      false,
      'a non-test file the previous attempt wrote is still reverted normally',
    );
  } finally {
    cleanup();
  }
});
