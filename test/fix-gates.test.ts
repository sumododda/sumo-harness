/**
 * Proves the two gaps between `fix` and `feature`'s test-safety guarantees are
 * actually closed, not just that the pieces they're built from work in
 * isolation.
 *
 * `feature` locks the tests it writes and treats a suite still red only from
 * failures that pre-date the task as verified; `fix` had neither, so a red
 * test could be made to pass by editing it, and a repo with one unrelated
 * failing test made a correct fix unverifiable forever. Both are proven here
 * against the gate and the ladder the workflow actually builds, the way
 * `test/feature-handoff.test.ts` proves the same claims for `feature`.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Interface } from 'node:readline/promises';
import type { Engine, StageRequest } from '../src/engine/index.ts';
import { LineReader } from '../src/input.ts';
import { Ledger } from '../src/ledger.ts';
import { run } from '../src/runner.ts';
import { findRepo, TaskState } from '../src/state.ts';
import type { StageResult, Tier } from '../src/types.ts';
import { runFix } from '../src/workflows/fix.ts';

/** What the gate said when the fix stage tried to touch a file. */
interface GateVerdicts {
  test?: string | null;
  source?: string | null;
}

/** Records every stage that ran, and asks the gate the workflow actually built. */
function stubEngine(
  seen: { stage: string; tier: Tier; effort?: string }[],
  verdicts: GateVerdicts = {},
  testFile = 'test/thing.test.ts',
): Engine {
  return {
    name: 'stub',
    modelFor: (tier) => `stub-${tier}`,
    supportsEffort: () => true,
    async runStage(req: StageRequest): Promise<StageResult> {
      seen.push({
        stage: req.stage,
        tier: req.rung.tier,
        ...(req.rung.effort ? { effort: req.rung.effort } : {}),
      });

      if (req.stage === 'fix') {
        verdicts.test = req.gate?.('Edit', { file_path: testFile }) ?? null;
        verdicts.source = req.gate?.('Edit', { file_path: 'src/thing.ts' }) ?? null;
      }

      return {
        stage: req.stage,
        output: req.stage === 'root-cause' ? 'Root cause: something is broken.' : 'done',
        costUsd: 0,
        turns: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        rung: req.rung,
        model: `stub-${req.rung.tier}`,
        denials: [],
      };
    },
  };
}

interface ScriptedRun {
  readonly output: string;
  readonly passed: boolean;
}

/**
 * A test command that replays canned output/exit-code pairs in order, one per
 * call, and holds on the last one once the list runs out.
 *
 * Unlike a plain pass/fail counter, this lets a test dictate exactly which
 * failure appears on which call — the pre-existing baseline, the post-fix
 * verify, and any retries after it can each say something different, which is
 * the whole point of testing whether a *new* failure is told apart from an
 * *old* one.
 */
function scriptedRuns(dir: string, runs: readonly ScriptedRun[]): string {
  const script = join(dir, 'suite.sh');
  const counter = join(dir, 'runs.txt');
  writeFileSync(counter, '0', 'utf8');
  runs.forEach((r, i) => {
    writeFileSync(join(dir, `out-${i + 1}.txt`), r.output, 'utf8');
    writeFileSync(join(dir, `code-${i + 1}.txt`), r.passed ? '0' : '1', 'utf8');
  });
  writeFileSync(
    script,
    `#!/bin/sh
n=$(cat "${counter}")
n=$((n + 1))
echo $n > "${counter}"
if [ "$n" -gt ${runs.length} ]; then n=${runs.length}; fi
cat "${dir}/out-$n.txt"
exit "$(cat "${dir}/code-$n.txt")"
`,
    'utf8',
  );
  chmodSync(script, 0o755);
  return script;
}

/** node:test's own failure shape, since that is what `failures.parse` reads. */
function failing(file: string, name: string): string {
  return `test at ${file}:3:1\n✖ ${name} (1.234ms)\n`;
}

function scriptedInput(answers: readonly string[]): LineReader {
  const emitter = new EventEmitter() as Interface;
  const reader = new LineReader(emitter);
  for (const answer of answers) emitter.emit('line', answer);
  return reader;
}

async function fixture(
  runs: readonly ScriptedRun[],
  verdicts: GateVerdicts = {},
  seen: { stage: string; tier: Tier; effort?: string }[] = [],
  testFile = 'test/thing.test.ts',
) {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-fix-gates-'));
  await run('git init -q && git config user.email t@t && git config user.name t', dir);
  writeFileSync(join(dir, 'a.txt'), 'x\n', 'utf8');
  await run('git add -A && git commit -qm init', dir);

  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    ctx: {
      engine: stubEngine(seen, verdicts, testFile),
      ledger: new Ledger(),
      state: new TaskState(findRepo(dir), TaskState.newId('fix')),
      cwd: dir,
      input: scriptedInput([]),
      isTty: true,
      autoApprove: true,
      testCommand: scriptedRuns(dir, runs),
    },
  };
}

test('a currently-failing test file is locked during the fix stage, the source file is not', async () => {
  const verdicts: GateVerdicts = {};
  const seen: { stage: string; tier: Tier; effort?: string }[] = [];
  const { ctx, cleanup } = await fixture(
    [
      { output: failing('test/thing.test.ts', 'the bug reproduces'), passed: false },
      { output: 'ok\n', passed: true },
    ],
    verdicts,
    seen,
  );
  try {
    const outcome = await runFix('the thing is broken', { tier: 'small' }, ctx);

    assert.equal(outcome.kind, 'fixed');
    assert.ok(seen.some((s) => s.stage === 'fix'), 'the fix stage ran');
    assert.match(
      verdicts.test ?? '',
      /locked/,
      'editing the file the bug report is failing on is refused',
    );
    assert.equal(verdicts.source, null, 'editing the implementation is allowed');
  } finally {
    cleanup();
  }
});

test('a suite whose only remaining failures pre-date the task is treated as verified', async () => {
  const seen: { stage: string; tier: Tier; effort?: string }[] = [];
  // The same failure, byte for byte, on the baseline and after the fix: this
  // task never touched it.
  const staleFailure = failing('test/unrelated.test.ts', 'an old, unrelated bug');
  const { ctx, cleanup } = await fixture(
    [
      { output: staleFailure, passed: false },
      { output: staleFailure, passed: false },
    ],
    {},
    seen,
  );
  try {
    const outcome = await runFix('the thing is broken', { tier: 'small' }, ctx);

    assert.equal(outcome.kind, 'fixed');
    if (outcome.kind === 'fixed') assert.equal(outcome.verified, true);
    assert.equal(
      seen.filter((s) => s.stage === 'fix').length,
      1,
      'no retry for a failure this task did not cause',
    );
  } finally {
    cleanup();
  }
});

test('a genuinely new failure is still retried, not waved through as pre-existing', async () => {
  const seen: { stage: string; tier: Tier; effort?: string }[] = [];
  const { ctx, cleanup } = await fixture(
    [
      { output: failing('test/unrelated.test.ts', 'an old, unrelated bug'), passed: false },
      { output: failing('test/other.test.ts', 'a new failure this attempt introduced'), passed: false },
      { output: 'ok\n', passed: true },
    ],
    {},
    seen,
  );
  try {
    const outcome = await runFix('the thing is broken', { tier: 'mid', effort: 'low' }, ctx);

    assert.equal(outcome.kind, 'fixed');
    if (outcome.kind === 'fixed') assert.equal(outcome.verified, true);
    const attempts = seen.filter((s) => s.stage === 'fix');
    assert.equal(attempts.length, 2, 'the new failure earns a retry, same as any other failure');
    assert.deepEqual(
      attempts.map((a) => a.tier),
      ['mid', 'mid'],
      'a retry stays at the same rung',
    );
  } finally {
    cleanup();
  }
});
