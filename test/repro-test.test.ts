/**
 * Proves the reproduction-test mechanism this brief adds to `fix`: a proposed
 * test file is screened the same way `buildGate` screens a tool call, written
 * to disk only with explicit consent, trusted only once the harness has
 * confirmed it actually fails, and — once confirmed — locked exactly like any
 * other currently-failing test. Mirrors test/fix-gates.test.ts's and
 * test/clean-retries.test.ts's stub-engine-against-a-real-fixture-repo style
 * rather than inventing a new test harness.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Interface } from 'node:readline/promises';
import type { Engine, StageRequest } from '../src/engine/index.ts';
import { Fleet } from '../src/engine/fleet.ts';
import { LineReader } from '../src/input.ts';
import { Ledger } from '../src/ledger.ts';
import { run } from '../src/runner.ts';
import { findRepo, TaskState } from '../src/state.ts';
import type { StageResult } from '../src/types.ts';
import { runFix } from '../src/workflows/fix.ts';

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

function scriptedInput(answers: readonly string[]): LineReader {
  const emitter = new EventEmitter() as Interface;
  const reader = new LineReader(emitter);
  for (const answer of answers) emitter.emit('line', answer);
  return reader;
}

interface ScriptedRun {
  readonly output: string;
  readonly passed: boolean;
}

/**
 * A test command that replays canned output/exit-code pairs in order, one per
 * call, and holds on the last once the list runs out. Copied from
 * test/fix-gates.test.ts, which needs the exact same thing: the
 * pre-existing baseline, the repro-test confirm-run, and the post-fix verify
 * each need to say something different.
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

/** What the gate said when the fix stage tried to edit the proposed repro test. */
interface GateVerdicts {
  reproFile?: string | null;
}

/** Records the gate's verdict on `checkPath`, the way test/fix-gates.test.ts's stubEngine does. */
function stubEngine(
  reproTest: { file: string; content: string } | null,
  verdicts: GateVerdicts = {},
  checkPath?: string,
): Engine {
  return {
    name: 'stub',
    costUnit: 'usd' as const,
    supportsOutputSchema: true,
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
            reproTest,
            hypotheses: [],
          }),
          rung: req.rung,
          model: `stub-${req.rung.tier}`,
          ...STUB_RESULT,
        };
      }

      if (req.stage === 'fix' && checkPath) {
        verdicts.reproFile = req.gate?.('Edit', { file_path: checkPath }) ?? null;
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

async function fixture(
  reproTest: { file: string; content: string } | null,
  runs: readonly ScriptedRun[],
  opts: { verdicts?: GateVerdicts; checkPath?: string } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-repro-test-'));
  await run('git init -q && git config user.email t@t && git config user.name t', dir);
  writeFileSync(join(dir, 'a.txt'), 'x\n', 'utf8');
  await run('git add -A && git commit -qm init', dir);

  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    ctx: {
      fleet: Fleet.of(stubEngine(reproTest, opts.verdicts, opts.checkPath)),
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

test('a proposed repro test that genuinely fails is written, confirmed failing, and locked', async () => {
  const reproTest = { file: 'test/repro.test.js', content: 'assert.equal(1, 2);\n' };
  const verdicts: GateVerdicts = {};
  const { dir, cleanup, ctx } = await fixture(
    reproTest,
    [
      { output: 'ok\n', passed: true }, // 1: pre-existing baseline — clean
      { output: failing('test/repro.test.js', 'reproduces the bug'), passed: false }, // 2: confirm-run
      { output: 'ok\n', passed: true }, // 3: verify after fix
    ],
    { verdicts, checkPath: 'test/repro.test.js' },
  );
  try {
    const outcome = await runFix('the thing is broken', { tier: 'small' }, ctx);

    assert.equal(outcome.kind, 'fixed');
    if (outcome.kind === 'fixed') assert.equal(outcome.verified, true);

    assert.equal(
      readFileSync(join(dir, 'test/repro.test.js'), 'utf8'),
      reproTest.content,
      'the harness wrote exactly the proposed content',
    );
    assert.match(
      verdicts.reproFile ?? '',
      /locked/i,
      'a confirmed repro test is locked during fix, the same as any other currently-failing test',
    );
  } finally {
    cleanup();
  }
});

test('a proposed repro test that does not fail is discarded, and the file is left on disk', async () => {
  const reproTest = { file: 'test/repro.test.js', content: 'assert.equal(1, 1);\n' };
  const verdicts: GateVerdicts = {};
  const { dir, cleanup, ctx } = await fixture(
    reproTest,
    [
      { output: 'ok\n', passed: true }, // 1: baseline
      { output: 'ok\n', passed: true }, // 2: confirm-run — passes immediately
      { output: 'ok\n', passed: true }, // 3: verify after fix
    ],
    { verdicts, checkPath: 'test/repro.test.js' },
  );
  try {
    const outcome = await runFix('the thing is broken', { tier: 'small' }, ctx);

    assert.equal(outcome.kind, 'fixed');
    if (outcome.kind === 'fixed') assert.equal(outcome.verified, true);

    // Deliberate choice, not an oversight: the content is real and the
    // operator already approved writing it, so it stays — see the comment on
    // maybeWriteReproTest in src/workflows/fix.ts for the reasoning.
    assert.equal(
      readFileSync(join(dir, 'test/repro.test.js'), 'utf8'),
      reproTest.content,
      'a discarded repro test is left in place, not deleted',
    );
    assert.equal(
      verdicts.reproFile,
      null,
      'a discarded repro test was never confirmed, so it is not locked',
    );
  } finally {
    cleanup();
  }
});

test('a repro test targeting a credential-shaped path is refused and never written', async () => {
  const reproTest = { file: '.env', content: 'FOO=bar\n' };
  const { dir, cleanup, ctx } = await fixture(reproTest, [
    { output: 'ok\n', passed: true }, // 1: baseline
    { output: 'ok\n', passed: true }, // 2: verify after fix
  ]);
  try {
    const outcome = await runFix('the thing is broken', { tier: 'small' }, ctx);

    assert.equal(outcome.kind, 'fixed');
    if (outcome.kind === 'fixed') assert.equal(outcome.verified, true, 'refusal degrades gracefully, task proceeds');
    assert.equal(
      existsSync(join(dir, '.env')),
      false,
      'a credential-shaped path (the same pattern gate-tools.ts refuses everywhere else) is refused before any write',
    );
  } finally {
    cleanup();
  }
});

test('a repro test whose content looks like a real secret is refused and never written', async () => {
  // Same AWS-key pattern test/gate.test.ts already exercises against
  // buildGate — asserting against a real gate-tools.ts pattern rather than a
  // test-only invention.
  const reproTest = {
    file: 'test/repro.test.js',
    content: "export const key = 'AKIAABCDEFGHIJKLMNOP';",
  };
  const { dir, cleanup, ctx } = await fixture(reproTest, [
    { output: 'ok\n', passed: true }, // 1: baseline
    { output: 'ok\n', passed: true }, // 2: verify after fix
  ]);
  try {
    const outcome = await runFix('the thing is broken', { tier: 'small' }, ctx);

    assert.equal(outcome.kind, 'fixed');
    if (outcome.kind === 'fixed') assert.equal(outcome.verified, true);
    assert.equal(
      existsSync(join(dir, 'test/repro.test.js')),
      false,
      // This write reaches disk with no Edit/Write tool call for buildGate to
      // ever see — without fix.ts's own screen, this content would land on
      // disk unchecked, which is exactly the gap this brief exists to close.
      'secret-shaped content is refused before it ever reaches disk, even at an ordinary path',
    );
  } finally {
    cleanup();
  }
});

test('when there is no test command, a proposed repro test degrades to unavailable rather than erroring', async () => {
  const reproTest = { file: 'test/repro.test.js', content: 'assert.equal(1, 2);\n' };
  const { dir, cleanup, ctx } = await fixture(reproTest, [{ output: 'ok\n', passed: true }]);
  try {
    const outcome = await runFix('the thing is broken', { tier: 'small' }, { ...ctx, testCommand: null });

    assert.equal(outcome.kind, 'fixed');
    if (outcome.kind === 'fixed') assert.equal(outcome.verified, false, 'unverified, not falsely successful');
    assert.equal(
      existsSync(join(dir, 'test/repro.test.js')),
      false,
      'without a way to confirm it fails, the file is never written at all',
    );
  } finally {
    cleanup();
  }
});
