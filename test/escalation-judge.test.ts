/**
 * Proves the escalation judge — a cheap advisory stage that runs right before
 * `escalate.ts`'s `afterFailure`, deciding whether a failed rung-attempt is a
 * near miss or a sign the approach/model can't do this — is actually wired
 * into `fix.ts`'s real loop, the same way test/candidate-sampling.test.ts
 * proves candidate sampling against the real workflow rather than trusting
 * the state machine alone.
 *
 * The property that matters most: a scripted `capabilityFailure` verdict must
 * change which rung the very NEXT `fix`-stage call lands on — skipping the
 * same-rung retry, and skipping a same-tier rung when there is one to skip —
 * proven by watching WHICH rung each call actually ran at, the same
 * `rungOf(snapshot)` technique candidate-sampling.test.ts already established.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import type { Interface } from 'node:readline/promises';
import type { Engine, StageRequest } from '../src/engine/index.ts';
import { Fleet } from '../src/engine/fleet.ts';
import * as features from '../src/features.ts';
import { LineReader } from '../src/input.ts';
import { Ledger } from '../src/ledger.ts';
import { run } from '../src/runner.ts';
import { findRepo, TaskState } from '../src/state.ts';
import type { StageResult, Tier } from '../src/types.ts';
import { runFix } from '../src/workflows/fix.ts';

afterEach(() => {
  features.set({ escalationJudge: true });
});

const STUB_RESULT = {
  cost: 0,
  costUnit: 'usd',
  provider: 'stub',
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
  readonly tier: Tier;
  readonly effort?: string;
}

/**
 * Records the rung each `fix`-stage call ran at, and every stage name seen —
 * the latter so a test can prove the judge was (or was not) called at all,
 * not just infer it from a rung that happens to match either story.
 *
 * `judgeAnswers` is popped one per `judge`-stage call, held on the last entry
 * once exhausted — same replay-and-hold shape `scriptedRuns` below uses for
 * the test command. `'__throw__'` makes that call throw instead of answering.
 */
function stubEngine(
  snapshots: FixSnapshot[],
  seenStages: string[],
  judgeAnswers: readonly string[] = [],
): Engine {
  let judgeCall = 0;
  return {
    name: 'stub',
    costUnit: 'usd' as const,
    supportsOutputSchema: true,
    modelFor: (tier) => `stub-${tier}`,
    supportsEffort: () => true,
    async runStage(req: StageRequest): Promise<StageResult> {
      seenStages.push(req.stage);

      if (req.stage === 'evidence') {
        return {
          stage: req.stage,
          // No repro test proposed: candidate sampling must never engage in
          // these tests, so the judge is the only mechanism under test.
          output: JSON.stringify({ observations: [], suspects: [], repro: null, reproTest: null, hypotheses: [] }),
          rung: req.rung,
          model: `stub-${req.rung.tier}`,
          ...STUB_RESULT,
        };
      }

      if (req.stage === 'judge') {
        const answer = judgeAnswers[Math.min(judgeCall, judgeAnswers.length - 1)] ?? '';
        judgeCall += 1;
        if (answer === '__throw__') throw new Error('judge exploded');
        return { stage: req.stage, output: answer, rung: req.rung, model: `stub-${req.rung.tier}`, ...STUB_RESULT };
      }

      if (req.stage === 'fix') {
        snapshots.push({ tier: req.rung.tier, ...(req.rung.effort ? { effort: req.rung.effort } : {}) });
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

async function fixture(runs: readonly ScriptedRun[], judgeAnswers: readonly string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-escalation-judge-'));
  await run('git init -q && git config user.email t@t && git config user.name t', dir);
  writeFileSync(join(dir, 'a.txt'), 'x\n', 'utf8');
  await run('git add -A && git commit -qm init', dir);

  const snapshots: FixSnapshot[] = [];
  const seenStages: string[] = [];
  return {
    dir,
    snapshots,
    seenStages,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    ctx: {
      fleet: Fleet.of(stubEngine(snapshots, seenStages, judgeAnswers)),
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

const REPRO_FILE = 'test/repro.test.js';
const rungOf = (s: FixSnapshot) => `${s.tier}/${s.effort ?? 'none'}`;

test('a confident capability-failure verdict skips the same-rung retry AND the same-tier rung beyond it', async () => {
  const { snapshots, seenStages, cleanup, ctx } = await fixture(
    [
      { output: 'ok\n', passed: true }, // 1: pre-existing baseline
      { output: failing(REPRO_FILE, 'reproduces'), passed: false }, // 2: verify rung mid/low
      { output: 'ok\n', passed: true }, // 3: verify the escalated attempt
    ],
    [JSON.stringify({ verdict: 'capabilityFailure' })],
  );
  try {
    // mid/low is rung 1; its own retry would normally be tried before mid/high
    // (rung 2, same tier) is ever reached. A confident capability failure
    // must skip both: the very next fix-stage call should land on large/medium
    // (rung 3), not mid/low again and not mid/high.
    const outcome = await runFix('the thing is broken', { tier: 'mid', effort: 'low' }, ctx);

    assert.equal(outcome.kind, 'fixed');
    if (outcome.kind === 'fixed') assert.equal(outcome.verified, true);
    assert.equal(snapshots.length, 2, 'one failed attempt, then one escalated attempt — no same-rung retry');
    assert.equal(rungOf(snapshots[0]!), 'mid/low');
    assert.equal(
      rungOf(snapshots[1]!),
      'large/medium',
      'skipped straight past mid/high to the genuine tier change beyond it',
    );
    assert.equal(seenStages.filter((s) => s === 'judge').length, 1, 'the judge ran exactly once');
  } finally {
    cleanup();
  }
});

test('with escalationJudge off, a scripted capability failure is never asked for and the ladder retries as before', async () => {
  features.set({ escalationJudge: false });
  const { snapshots, seenStages, cleanup, ctx } = await fixture(
    [
      { output: 'ok\n', passed: true }, // 1: baseline
      { output: failing(REPRO_FILE, 'reproduces'), passed: false }, // 2: verify attempt 1
      { output: 'ok\n', passed: true }, // 3: verify attempt 2 — the ladder's own retry
    ],
    [JSON.stringify({ verdict: 'capabilityFailure' })],
  );
  try {
    const outcome = await runFix('the thing is broken', { tier: 'mid', effort: 'low' }, ctx);

    assert.equal(outcome.kind, 'fixed');
    if (outcome.kind === 'fixed') assert.equal(outcome.verified, true);
    assert.equal(seenStages.filter((s) => s === 'judge').length, 0, 'the flag being off means the judge never runs');
    assert.equal(snapshots.length, 2, 'one fix-stage call per rung, exactly as before this brief');
    assert.equal(rungOf(snapshots[0]!), rungOf(snapshots[1]!), "a retry, not an escalation — the ladder's own");
  } finally {
    cleanup();
  }
});

test('a judge stage that throws is treated as a near miss, not allowed to change the outcome', async () => {
  const { snapshots, cleanup, ctx } = await fixture(
    [
      { output: 'ok\n', passed: true },
      { output: failing(REPRO_FILE, 'reproduces'), passed: false },
      { output: 'ok\n', passed: true },
    ],
    ['__throw__'],
  );
  try {
    const outcome = await runFix('the thing is broken', { tier: 'mid', effort: 'low' }, ctx);

    assert.equal(outcome.kind, 'fixed');
    if (outcome.kind === 'fixed') assert.equal(outcome.verified, true);
    assert.equal(snapshots.length, 2, 'the ladder proceeded exactly as a near miss would');
    assert.equal(rungOf(snapshots[0]!), rungOf(snapshots[1]!), 'a same-rung retry, not an escalation');
  } finally {
    cleanup();
  }
});

test('a judge stage that answers unparseable garbage is treated as a near miss', async () => {
  const { snapshots, cleanup, ctx } = await fixture(
    [
      { output: 'ok\n', passed: true },
      { output: failing(REPRO_FILE, 'reproduces'), passed: false },
      { output: 'ok\n', passed: true },
    ],
    ['not json at all'],
  );
  try {
    const outcome = await runFix('the thing is broken', { tier: 'mid', effort: 'low' }, ctx);

    assert.equal(outcome.kind, 'fixed');
    if (outcome.kind === 'fixed') assert.equal(outcome.verified, true);
    assert.equal(snapshots.length, 2, 'the ladder proceeded exactly as a near miss would');
    assert.equal(rungOf(snapshots[0]!), rungOf(snapshots[1]!), 'a same-rung retry, not an escalation');
  } finally {
    cleanup();
  }
});

test('a nearMiss verdict behaves identically to today: one same-rung retry', async () => {
  const { snapshots, cleanup, ctx } = await fixture(
    [
      { output: 'ok\n', passed: true },
      { output: failing(REPRO_FILE, 'reproduces'), passed: false },
      { output: 'ok\n', passed: true },
    ],
    [JSON.stringify({ verdict: 'nearMiss' })],
  );
  try {
    const outcome = await runFix('the thing is broken', { tier: 'mid', effort: 'low' }, ctx);

    assert.equal(outcome.kind, 'fixed');
    if (outcome.kind === 'fixed') assert.equal(outcome.verified, true);
    assert.equal(snapshots.length, 2);
    assert.equal(rungOf(snapshots[0]!), rungOf(snapshots[1]!), 'a same-rung retry, not an escalation');
  } finally {
    cleanup();
  }
});
