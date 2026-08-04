/**
 * Mid-workflow `/resume` at the approval gate.
 *
 * A task that stopped exactly at its gate — rejected, or the revision limit
 * was hit — comes back as `{ kind: 'stopped'; at: 'gate' }` from `runFix`/
 * `runFeature`, and the gate's own artifact (both the TOON `prompt` form and
 * the boxed `display` form) is saved beside the usual output so the SAME
 * proposal can be re-shown without paying to reach it again. Every other stop
 * — nothing produced, the ladder giving up after approval — must not carry
 * `at: 'gate'`, or `/resume` would offer to skip straight to a decision that
 * was never actually reached.
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
import type { StageResult } from '../src/types.ts';
import { runFeature } from '../src/workflows/feature.ts';
import { runFix } from '../src/workflows/fix.ts';

/** Answers each stage with a fixed, per-test-controlled string. */
function stubEngine(seen: string[], outputs: Record<string, string> = {}): Engine {
  let writeTestAttempt = 0;
  return {
    name: 'stub',
    modelFor: (tier) => `stub-${tier}`,
    supportsEffort: () => true,
    async runStage(req: StageRequest): Promise<StageResult> {
      seen.push(req.stage);
      // The write-tests stage has to leave a new file behind, or the workflow
      // correctly stops for having nothing to lock.
      if (req.stage === 'write-tests') {
        writeTestAttempt += 1;
        writeFileSync(join(req.cwd, `added-${writeTestAttempt}.test.ts`), '// from the stub\n', 'utf8');
      }
      return {
        stage: req.stage,
        output: outputs[req.stage] ?? 'done',
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

function scriptedInput(answers: readonly string[]): LineReader {
  const emitter = new EventEmitter() as Interface;
  const reader = new LineReader(emitter);
  for (const answer of answers) emitter.emit('line', answer);
  return reader;
}

async function repoDir(prefix: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  await run('git init -q && git config user.email t@t && git config user.name t', dir);
  writeFileSync(join(dir, 'a.txt'), 'x\n', 'utf8');
  await run('git add -A && git commit -qm init', dir);
  return dir;
}

/** A suite that always fails, for provoking a ladder into giving up. */
function alwaysFailingSuite(dir: string): string {
  const script = join(dir, 'always-fail.sh');
  writeFileSync(script, '#!/bin/sh\necho "still broken"\nexit 1\n', 'utf8');
  chmodSync(script, 0o755);
  return script;
}

/**
 * A suite that fails on exactly the runs named, and passes on the rest — so a
 * green pre-existing check, a red proof-of-failure, and a run of red retries
 * can each be scripted independently.
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
  *" $n "*) echo "still broken (run $n)"; exit 1 ;;
esac
echo ok
exit 0
`,
    'utf8',
  );
  chmodSync(script, 0o755);
  return script;
}

/** Captures everything written to stdout while `fn` runs. */
async function captured(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    chunks.push(chunk);
    return true;
  });
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join('');
}

// ---------------------------------------------------------------- fix ----

test('fix: rejecting the root cause at the gate saves both artifact forms', async () => {
  const dir = await repoDir('sumo-resume-fix-');
  try {
    const seen: string[] = [];
    const state = new TaskState(findRepo(dir), 'fix-reject');
    const ctx = {
      engine: stubEngine(seen, { 'root-cause': 'Cause: listNotes swallows ENOENT.' }),
      ledger: new Ledger(),
      state,
      cwd: dir,
      input: scriptedInput(['n']),
      isTty: true,
      autoApprove: false,
      testCommand: null,
    };

    const outcome = await runFix('the cart total is wrong', { tier: 'small' }, ctx);

    assert.equal(outcome.kind, 'stopped');
    if (outcome.kind === 'stopped') assert.equal(outcome.at, 'gate');
    assert.equal(state.read('rootcause.md'), 'Cause: listNotes swallows ENOENT.');
    assert.equal(state.read('rootcause.display.md'), 'Cause: listNotes swallows ENOENT.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fix: resuming re-enters the gate without evidence or root-cause, and shows the same proposal', async () => {
  const dir = await repoDir('sumo-resume-fix-');
  try {
    const state = new TaskState(findRepo(dir), 'fix-resume');
    const seen1: string[] = [];
    const first = await runFix('the cart total is wrong', { tier: 'small' }, {
      engine: stubEngine(seen1, { 'root-cause': 'Cause: listNotes swallows ENOENT.' }),
      ledger: new Ledger(),
      state,
      cwd: dir,
      input: scriptedInput(['n']),
      isTty: true,
      autoApprove: false,
      testCommand: null,
    });
    assert.equal(first.kind, 'stopped');
    if (first.kind === 'stopped') assert.equal(first.at, 'gate');

    const savedPrompt = state.read('rootcause.md');
    const savedDisplay = state.read('rootcause.display.md');
    assert.ok(savedPrompt);
    assert.ok(savedDisplay);

    const seen2: string[] = [];
    const output = await captured(async () => {
      const second = await runFix(
        'the cart total is wrong',
        { tier: 'small' },
        {
          // A different engine: if evidence or root-cause ran again, this
          // output — not the saved one — is what would reach the gate.
          engine: stubEngine(seen2, { 'root-cause': 'DIFFERENT — must not be reached' }),
          ledger: new Ledger(),
          state,
          cwd: dir,
          input: scriptedInput(['y']),
          isTty: true,
          autoApprove: false,
          testCommand: null,
        },
        '',
        { rootCause: { value: null, prompt: savedPrompt, display: savedDisplay } },
      );
      assert.equal(second.kind, 'fixed');
    });

    assert.equal(seen2.includes('evidence'), false, 'evidence must not run again');
    assert.equal(seen2.includes('root-cause'), false, 'root-cause must not run again');
    assert.deepEqual(seen2, ['fix']);
    assert.match(output, /listNotes swallows ENOENT/, 'the saved proposal is what gets shown');
    assert.doesNotMatch(output, /DIFFERENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fix: hitting the revision limit at the gate is a gate stop too', async () => {
  const dir = await repoDir('sumo-resume-fix-');
  try {
    const seen: string[] = [];
    let revision = 0;
    const state = new TaskState(findRepo(dir), 'fix-revlimit');
    const engine: Engine = {
      name: 'stub',
      modelFor: (tier) => `stub-${tier}`,
      supportsEffort: () => true,
      async runStage(req) {
        seen.push(req.stage);
        if (req.stage === 'root-cause') revision += 1;
        return {
          stage: req.stage,
          output: req.stage === 'root-cause' ? `Cause, attempt ${revision}` : 'done',
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

    const outcome = await runFix('the cart total is wrong', { tier: 'small' }, {
      engine,
      ledger: new Ledger(),
      state,
      cwd: dir,
      input: scriptedInput(['change the approach', 'try something else', 'one more attempt']),
      isTty: true,
      autoApprove: false,
      testCommand: null,
    });

    assert.equal(outcome.kind, 'stopped');
    if (outcome.kind === 'stopped') {
      assert.equal(outcome.at, 'gate');
      assert.match(outcome.why, /revisions/);
    }
    // The initial diagnosis, plus two revisions before the budget runs out.
    assert.equal(seen.filter((s) => s === 'root-cause').length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fix: root-cause producing nothing is not a gate stop', async () => {
  const dir = await repoDir('sumo-resume-fix-');
  try {
    const seen: string[] = [];
    const state = new TaskState(findRepo(dir), 'fix-empty');
    const outcome = await runFix('the cart total is wrong', { tier: 'small' }, {
      engine: stubEngine(seen, { 'root-cause': '' }),
      ledger: new Ledger(),
      state,
      cwd: dir,
      input: scriptedInput(['y']),
      isTty: true,
      autoApprove: false,
      testCommand: null,
    });

    assert.equal(outcome.kind, 'stopped');
    if (outcome.kind === 'stopped') assert.equal(outcome.at, undefined);
    assert.equal(seen.includes('fix'), false, 'the gate was never reached');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fix: giving up mid-ladder after approval is not a gate stop', async () => {
  const dir = await repoDir('sumo-resume-fix-');
  try {
    const seen: string[] = [];
    const state = new TaskState(findRepo(dir), 'fix-giveup');
    const outcome = await runFix('the cart total is wrong', { tier: 'mid', effort: 'low' }, {
      engine: stubEngine(seen, { 'root-cause': 'Cause: x' }),
      ledger: new Ledger(),
      state,
      cwd: dir,
      input: scriptedInput(['y']),
      isTty: true,
      autoApprove: false,
      testCommand: alwaysFailingSuite(dir),
    });

    assert.equal(outcome.kind, 'stopped');
    if (outcome.kind === 'stopped') assert.equal(outcome.at, undefined, 'approval already happened');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ feature ----

test('feature: rejecting the plan at the gate saves both artifact forms plus the tests count', async () => {
  const dir = await repoDir('sumo-resume-feature-');
  try {
    const seen: string[] = [];
    const state = new TaskState(findRepo(dir), 'feature-reject');
    const outcome = await runFeature('add a search command', { tier: 'small' }, {
      engine: stubEngine(seen, { plan: 'Approach: add the thing.' }),
      ledger: new Ledger(),
      state,
      cwd: dir,
      input: scriptedInput(['n']),
      isTty: true,
      autoApprove: false,
      testCommand: null,
    });

    assert.equal(outcome.kind, 'stopped');
    if (outcome.kind === 'stopped') assert.equal(outcome.at, 'gate');
    assert.equal(state.read('plan.md'), 'Approach: add the thing.');
    assert.equal(state.read('plan.display.md'), 'Approach: add the thing.');
    // The plan text is unparseable JSON, so it falls back to "one test" rather
    // than silently claiming the work needs none.
    assert.equal(state.read('plan.tests.txt'), '1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('feature: resuming re-enters the gate without explore or plan, and lands back on the same branch', async () => {
  const dir = await repoDir('sumo-resume-feature-');
  try {
    const original = (await run('git rev-parse --abbrev-ref HEAD', dir)).output.trim();
    const state = new TaskState(findRepo(dir), 'feature-resume');
    const seen1: string[] = [];
    const first = await runFeature('add a search command', { tier: 'small' }, {
      engine: stubEngine(seen1, { plan: 'Approach: add the thing.' }),
      ledger: new Ledger(),
      state,
      cwd: dir,
      input: scriptedInput(['n']),
      isTty: true,
      autoApprove: false,
      testCommand: null,
    });
    assert.equal(first.kind, 'stopped');
    const firstBranch = first.kind === 'stopped' ? first.branch : null;
    if (first.kind === 'stopped') assert.equal(first.at, 'gate');
    assert.ok(firstBranch);

    const savedPrompt = state.read('plan.md');
    const savedDisplay = state.read('plan.display.md');
    const savedTests = state.read('plan.tests.txt');
    assert.ok(savedPrompt);
    assert.ok(savedDisplay);
    assert.ok(savedTests);

    // Standing somewhere else entirely by the time /resume runs — the
    // operator's own navigation, not anything the workflow did.
    await run(`git checkout ${original}`, dir);

    const seen2: string[] = [];
    const output = await captured(async () => {
      const second = await runFeature(
        'add a search command',
        { tier: 'small' },
        {
          engine: stubEngine(seen2, { plan: 'DIFFERENT — must not be reached' }),
          ledger: new Ledger(),
          state,
          cwd: dir,
          input: scriptedInput(['y']),
          isTty: true,
          autoApprove: false,
          testCommand: null,
        },
        '',
        undefined,
        {
          plan: { value: null, prompt: savedPrompt, display: savedDisplay },
          tests: Number.parseInt(savedTests, 10),
        },
      );
      assert.equal(second.kind, 'built');
      if (second.kind === 'built') assert.equal(second.branch, firstBranch);
    });

    assert.equal(seen2.includes('explore'), false, 'explore must not run again');
    assert.equal(seen2.includes('plan'), false, 'plan must not run again');
    assert.deepEqual(seen2, ['write-tests', 'implement']);
    assert.match(output, /add the thing/, 'the saved proposal is what gets shown');
    assert.doesNotMatch(output, /DIFFERENT/);

    const after = await run('git rev-parse --abbrev-ref HEAD', dir);
    assert.equal(after.output.trim(), firstBranch, 'landed back on the task\'s own branch, not wherever HEAD was');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('feature: hitting the revision limit at the gate is a gate stop too', async () => {
  const dir = await repoDir('sumo-resume-feature-');
  try {
    const seen: string[] = [];
    const state = new TaskState(findRepo(dir), 'feature-revlimit');
    const outcome = await runFeature('add a search command', { tier: 'small' }, {
      engine: stubEngine(seen, { plan: 'Approach: something.' }),
      ledger: new Ledger(),
      state,
      cwd: dir,
      // `gatePlan`'s revision-limit check is `revisions >= MAX_REVISIONS`, one
      // full revision later than `gateRootCause`'s `revision + 1 >= MAX_REVISIONS`
      // — a pre-existing asymmetry between the two gates, left as-is rather than
      // rewritten (out of scope here), so this needs one more scripted answer.
      input: scriptedInput(['change it', 'try again', 'once more', 'last one']),
      isTty: true,
      autoApprove: false,
      testCommand: null,
    });

    assert.equal(outcome.kind, 'stopped');
    if (outcome.kind === 'stopped') {
      assert.equal(outcome.at, 'gate');
      assert.match(outcome.why, /revisions/);
    }
    assert.equal(seen.filter((s) => s === 'plan').length, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('feature: a plan that produces nothing is not a gate stop', async () => {
  const dir = await repoDir('sumo-resume-feature-');
  try {
    const seen: string[] = [];
    const state = new TaskState(findRepo(dir), 'feature-empty');
    const outcome = await runFeature('add a search command', { tier: 'small' }, {
      engine: stubEngine(seen, { plan: '' }),
      ledger: new Ledger(),
      state,
      cwd: dir,
      input: scriptedInput(['y']),
      isTty: true,
      autoApprove: false,
      testCommand: null,
    });

    assert.equal(outcome.kind, 'stopped');
    if (outcome.kind === 'stopped') assert.equal(outcome.at, undefined);
    assert.equal(seen.includes('write-tests'), false, 'the gate was never reached');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('feature: giving up mid-ladder after approval is not a gate stop', async () => {
  const dir = await repoDir('sumo-resume-feature-');
  const aux = mkdtempSync(join(tmpdir(), 'sumo-resume-feature-aux-'));
  try {
    const seen: string[] = [];
    const state = new TaskState(findRepo(dir), 'feature-giveup');
    // Run 1: pre-existing check, green. Run 2: prove-failing, red as required.
    // Every run after that stays red, so the ladder climbs and gives up.
    const outcome = await runFeature('add a search command', { tier: 'small' }, {
      engine: stubEngine(seen, { plan: 'Approach: something.' }),
      ledger: new Ledger(),
      state,
      cwd: dir,
      input: scriptedInput(['y']),
      isTty: true,
      autoApprove: false,
      testCommand: scriptedSuite(aux, [2, 3, 4, 5, 6, 7, 8, 9, 10]),
    });

    assert.equal(outcome.kind, 'stopped');
    if (outcome.kind === 'stopped') assert.equal(outcome.at, undefined, 'approval already happened');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(aux, { recursive: true, force: true });
  }
});
