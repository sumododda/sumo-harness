/**
 * Proves the escalation loop is actually wired into the fix workflow, not just
 * that the state machine is correct in isolation.
 *
 * Uses a stub engine and a scripted test command, so the whole ladder — retry,
 * climb, climb, give up — runs deterministically and for free. A live model
 * cannot be relied on to fail on demand, which is exactly what this needs.
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

/** Records which rung each stage ran at, and answers instantly. */
function stubEngine(seen: { stage: string; tier: Tier; effort?: string }[]): Engine {
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
      return {
        stage: req.stage,
        output: req.stage === 'evidence' ? 'Observations\n- none\nRepro — none' : 'done',
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

/**
 * Builds a test command that fails a given number of times, then passes.
 * State lives in a counter file so each invocation is a fresh process.
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
if [ "$n" -le ${failures} ]; then
  echo "✖ still broken (attempt $n)"
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

/** A LineReader pre-loaded with gate answers. */
function scriptedInput(answers: string[]): LineReader {
  const emitter = new EventEmitter() as Interface;
  const reader = new LineReader(emitter);
  for (const answer of answers) emitter.emit('line', answer);
  return reader;
}

async function fixture(failures: number) {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-ladder-'));
  await run('git init -q && git config user.email t@t && git config user.name t', dir);
  writeFileSync(join(dir, 'a.txt'), 'x\n', 'utf8');
  await run('git add -A && git commit -qm init', dir);

  const seen: { stage: string; tier: Tier; effort?: string }[] = [];
  return {
    dir,
    seen,
    ctx: {
      engine: stubEngine(seen),
      ledger: new Ledger(),
      state: new TaskState(findRepo(dir), 'ladder-test'),
      cwd: dir,
      input: scriptedInput(['y', 'y', 'y', 'y', 'y']),
      isTty: true,
      autoApprove: true,
      testCommand: scriptedTests(dir, failures),
    },
  };
}

test('a fix that passes first time never escalates', async () => {
  const { dir, seen, ctx } = await fixture(0);
  try {
    const outcome = await runFix('something is broken', { tier: 'small' }, ctx);

    assert.equal(outcome.kind, 'fixed');
    if (outcome.kind === 'fixed') assert.equal(outcome.verified, true);
    assert.equal(seen.filter((s) => s.stage === 'fix').length, 1, 'exactly one attempt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one failure is retried at the same rung', async () => {
  const { dir, seen, ctx } = await fixture(1);
  try {
    const outcome = await runFix('something is broken', { tier: 'mid', effort: 'low' }, ctx);

    assert.equal(outcome.kind, 'fixed');
    const attempts = seen.filter((s) => s.stage === 'fix');
    assert.equal(attempts.length, 2, 'the failure earns one retry');
    // Same rung: a retry is not an escalation.
    assert.deepEqual(
      attempts.map((a) => a.tier),
      ['mid', 'mid'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('effort rises before the model does', async () => {
  const { dir, seen, ctx } = await fixture(3);
  try {
    const outcome = await runFix('something is broken', { tier: 'mid', effort: 'low' }, ctx);

    assert.equal(outcome.kind, 'fixed');
    const attempts = seen.filter((s) => s.stage === 'fix');

    // first → retry → climb to mid/high → its own retry. Four attempts and the
    // model has not changed once: raising effort is tried before paying more.
    assert.deepEqual(
      attempts.map((a) => a.tier),
      ['mid', 'mid', 'mid', 'mid'],
    );

    // Asserting the tier alone is what let the effort dimension be silently
    // discarded: the stage hardcoded `medium`, so all four of these attempts
    // were identical and "raising effort" raised nothing. The name of this test
    // was true of the ladder and false of what actually ran.
    assert.deepEqual(
      attempts.map((a) => a.effort),
      ['low', 'low', 'high', 'high'],
      'the climb is a change in thinking depth, not just in bookkeeping',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the model tier only changes once cheaper moves are exhausted', async () => {
  const { dir, seen, ctx } = await fixture(4);
  try {
    const outcome = await runFix('something is broken', { tier: 'mid', effort: 'low' }, ctx);

    assert.equal(outcome.kind, 'fixed');
    const tiers = seen.filter((s) => s.stage === 'fix').map((a) => a.tier);

    // Only the fifth attempt, after two rungs each had a retry, reaches large.
    assert.deepEqual(tiers, ['mid', 'mid', 'mid', 'mid', 'large']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('it gives up rather than climbing forever, and says how to revert', async () => {
  // Never passes: the ladder must terminate on its own.
  const { dir, seen, ctx } = await fixture(99);
  try {
    const outcome = await runFix('something is broken', { tier: 'mid', effort: 'low' }, ctx);

    assert.equal(outcome.kind, 'stopped');
    if (outcome.kind === 'stopped') assert.match(outcome.why, /escalations/);

    // Bounded: two escalations, one retry each, and no more.
    const attempts = seen.filter((s) => s.stage === 'fix').length;
    assert.ok(attempts <= 6, `made ${attempts} attempts`);
    assert.ok(attempts >= 4, `gave up too early after ${attempts}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without a test command it reports honestly instead of retrying blind', async () => {
  const { dir, seen, ctx } = await fixture(99);
  try {
    const outcome = await runFix('something is broken', { tier: 'mid', effort: 'low' }, {
      ...ctx,
      testCommand: null,
    });

    assert.equal(outcome.kind, 'fixed');
    if (outcome.kind === 'fixed') {
      assert.equal(outcome.verified, false, 'unverified, not falsely successful');
    }
    assert.equal(seen.filter((s) => s.stage === 'fix').length, 1, 'no blind retries');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
