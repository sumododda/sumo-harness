/**
 * Proves candidate sampling — `fixUntilVerified` trying up to two independent
 * `fix`-stage attempts per rung once a confirmed repro test exists — against
 * the real workflow and the real escalation ladder in src/escalate.ts, the
 * same way test/clean-retries.test.ts proves the revert mechanism this reuses
 * against the real retry loop rather than the set-difference logic alone.
 *
 * The property that matters most: two failing candidates at one rung must
 * cost the ladder exactly one retry, not two, or escalate.ts's own
 * retry-then-climb cadence would be silently consumed twice as fast as it
 * appears to be from outside fix.ts. That is proven by watching WHICH rung
 * each `fix`-stage call actually ran at, not by asserting a call count alone.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import type { StageResult, Tier } from '../src/types.ts';
import { runFix } from '../src/workflows/fix.ts';

afterEach(() => {
  features.set({ candidateSampling: true });
});

const REPRO_FILE = 'test/repro.test.js';
const REPRO_TEST = { file: REPRO_FILE, content: 'assert.equal(1, 2);\n' };

const STUB_RESULT = {
  costUsd: 0,
  turns: 1,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  denials: [],
} as const;

/** node:test's own failure shape, since that is what `failures.parse` reads. */
function failing(file: string, name: string): string {
  return `test at ${file}:3:1\n✖ ${name} (1.234ms)\n`;
}

interface FixSnapshot {
  readonly call: number;
  readonly tier: Tier;
  readonly effort?: string;
  readonly strayFromPreviousExists: boolean;
}

/**
 * Records the rung each `fix`-stage call ran at, and whether the PREVIOUS
 * call's own stray file survived — the exact technique
 * test/clean-retries.test.ts's stubFixEngine uses, applied here to the
 * boundary between two sampled candidates as well as between rung retries.
 */
function stubEngine(snapshots: FixSnapshot[]): Engine {
  let call = 0;
  return {
    name: 'stub',
    modelFor: (tier) => `stub-${tier}`,
    supportsEffort: () => true,
    async runStage(req: StageRequest): Promise<StageResult> {
      if (req.stage === 'evidence') {
        return {
          stage: req.stage,
          output: JSON.stringify({
            observations: [],
            suspects: [],
            repro: null,
            reproTest: REPRO_TEST,
            hypotheses: [],
          }),
          rung: req.rung,
          model: `stub-${req.rung.tier}`,
          ...STUB_RESULT,
        };
      }

      if (req.stage === 'fix') {
        call += 1;
        snapshots.push({
          call,
          tier: req.rung.tier,
          ...(req.rung.effort ? { effort: req.rung.effort } : {}),
          strayFromPreviousExists: existsSync(join(req.cwd, `stray-${call - 1}.txt`)),
        });
        writeFileSync(join(req.cwd, `stray-${call}.txt`), `candidate ${call}\n`, 'utf8');
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

interface ScriptedRun {
  readonly output: string;
  readonly passed: boolean;
}

/** Copied from test/fix-gates.test.ts: canned output/exit-code pairs, one per call. */
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

function scriptedInput(answers: readonly string[]): LineReader {
  const emitter = new EventEmitter() as Interface;
  const reader = new LineReader(emitter);
  for (const answer of answers) emitter.emit('line', answer);
  return reader;
}

async function fixture(runs: readonly ScriptedRun[]) {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-candidate-sampling-'));
  await run('git init -q && git config user.email t@t && git config user.name t', dir);
  writeFileSync(join(dir, 'a.txt'), 'x\n', 'utf8');
  await run('git add -A && git commit -qm init', dir);

  const snapshots: FixSnapshot[] = [];
  return {
    dir,
    snapshots,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    ctx: {
      engine: stubEngine(snapshots),
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

const rungOf = (s: FixSnapshot) => `${s.tier}/${s.effort ?? 'none'}`;

test('candidate 1 fails, the tree is reverted, candidate 2 succeeds, and the task verifies', async () => {
  const { dir, snapshots, cleanup, ctx } = await fixture([
    { output: 'ok\n', passed: true }, // 1: pre-existing baseline
    { output: failing(REPRO_FILE, 'reproduces'), passed: false }, // 2: confirm-run
    { output: failing(REPRO_FILE, 'reproduces'), passed: false }, // 3: verify candidate 1
    { output: 'ok\n', passed: true }, // 4: verify candidate 2
  ]);
  try {
    const outcome = await runFix('the thing is broken', { tier: 'small' }, ctx);

    assert.equal(outcome.kind, 'fixed');
    if (outcome.kind === 'fixed') assert.equal(outcome.verified, true);
    assert.equal(snapshots.length, 2, 'exactly two candidates ran');
    assert.equal(
      snapshots[1]?.strayFromPreviousExists,
      false,
      "candidate 1's own stray file must be reverted before candidate 2 runs",
    );
    assert.equal(
      existsSync(join(dir, 'stray-1.txt')),
      false,
      'reverted for good, not merely hidden from candidate 2',
    );
    assert.equal(ctx.ledger.summarize().candidates, 1, 'one extra candidate was recorded');
  } finally {
    cleanup();
  }
});

test('two failing candidates at one rung cost the ladder exactly one retry, not two', async () => {
  const { snapshots, cleanup, ctx } = await fixture([
    { output: 'ok\n', passed: true }, // 1: baseline
    { output: failing(REPRO_FILE, 'reproduces'), passed: false }, // 2: confirm-run
    { output: failing(REPRO_FILE, 'reproduces'), passed: false }, // 3: rung0 candidate 1
    { output: failing(REPRO_FILE, 'reproduces'), passed: false }, // 4: rung0 candidate 2
    { output: failing(REPRO_FILE, 'reproduces'), passed: false }, // 5: rung0-retry candidate 1
    { output: failing(REPRO_FILE, 'reproduces'), passed: false }, // 6: rung0-retry candidate 2
    { output: 'ok\n', passed: true }, // 7: escalated rung, candidate 1 — succeeds
  ]);
  try {
    const outcome = await runFix('the thing is broken', { tier: 'mid', effort: 'low' }, ctx);

    assert.equal(outcome.kind, 'fixed');
    if (outcome.kind === 'fixed') assert.equal(outcome.verified, true);
    assert.equal(snapshots.length, 5, 'two rung-attempts of two candidates each, then one that succeeded');

    // If two failing candidates had each consumed their own retry budget, the
    // ladder would have escalated after the FIRST rung's two candidates
    // already — the bug this test exists to catch would show up as calls 2
    // and 3 landing on different rungs. Instead all four failing candidates
    // share one rung, and only the fifth call — after BOTH rung-attempts have
    // failed — has moved to a new one.
    assert.equal(rungOf(snapshots[0]!), rungOf(snapshots[1]!));
    assert.equal(rungOf(snapshots[1]!), rungOf(snapshots[2]!));
    assert.equal(rungOf(snapshots[2]!), rungOf(snapshots[3]!));
    assert.notEqual(
      rungOf(snapshots[3]!),
      rungOf(snapshots[4]!),
      'the fifth call is the first to run at an escalated rung',
    );
    assert.equal(
      ctx.ledger.summarize().candidates,
      2,
      'one extra candidate per rung-attempt, and there were two rung-attempts',
    );
  } finally {
    cleanup();
  }
});

test('with candidateSampling off, a confirmed repro test does not trigger a second candidate', async () => {
  features.set({ candidateSampling: false });
  const { snapshots, cleanup, ctx } = await fixture([
    { output: 'ok\n', passed: true }, // 1: baseline
    { output: failing(REPRO_FILE, 'reproduces'), passed: false }, // 2: confirm-run
    { output: failing(REPRO_FILE, 'reproduces'), passed: false }, // 3: verify attempt 1
    { output: 'ok\n', passed: true }, // 4: verify attempt 2 — the ladder's own retry
  ]);
  try {
    const outcome = await runFix('the thing is broken', { tier: 'small' }, ctx);

    assert.equal(outcome.kind, 'fixed');
    if (outcome.kind === 'fixed') assert.equal(outcome.verified, true);
    assert.equal(snapshots.length, 2, 'one fix-stage call per rung, exactly as before this brief');
    assert.equal(rungOf(snapshots[0]!), rungOf(snapshots[1]!), "a retry, not an escalation — the ladder's own");
    assert.equal(ctx.ledger.summarize().candidates, 0, 'no extra candidates when the flag is off');
  } finally {
    cleanup();
  }
});
