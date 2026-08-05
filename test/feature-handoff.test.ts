/**
 * What `plan` hands to `feature` when you approve a proposal.
 *
 * Approving in `plan` mode used to hand over nothing but a decision, so the
 * build re-explored, re-planned, and asked for the same approval again thirty
 * seconds later. The stages replayed from cache, so it cost nothing — but an
 * approval gate that repeats itself is one people learn to click through, and
 * that gate is the only thing standing between the harness and an unsupervised
 * write to someone's repository.
 *
 * A stub engine keeps the whole thing free and deterministic; a live model
 * cannot be relied on to produce the same plan twice, which is exactly what
 * this needs to observe.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import type { StageResult, Tier } from '../src/types.ts';
import { type ApprovedPlan, runFeature } from '../src/workflows/feature.ts';

/** What the gate said when the implement stage tried to touch a file. */
interface GateVerdicts {
  test?: string | null;
  source?: string | null;
}

/** Records every stage that actually ran. */
function stubEngine(
  seen: string[],
  verdicts: GateVerdicts = {},
  rungs: { stage: string; tier: Tier; effort?: string }[] = [],
): Engine {
  // Each attempt writes a test of its own, the way a real iteration would.
  // Rewriting one filename would leave the second attempt with no *new* test
  // file, which the workflow rightly treats as having written nothing.
  let attempt = 0;

  return {
    name: 'stub',
    costUnit: 'usd' as const,
    supportsOutputSchema: true,
    modelFor: (tier: Tier) => `stub-${tier}`,
    supportsEffort: () => true,
    async runStage(req: StageRequest): Promise<StageResult> {
      seen.push(req.stage);
      rungs.push({
        stage: req.stage,
        tier: req.rung.tier,
        ...(req.rung.effort ? { effort: req.rung.effort } : {}),
      });

      // The write-tests stage has to produce a file, or the workflow correctly
      // stops for having been handed nothing to lock.
      if (req.stage === 'write-tests') {
        attempt += 1;
        writeFileSync(join(req.cwd, `added-${attempt}.test.ts`), '// from the stub\n', 'utf8');
      }

      // The gate the workflow built for this stage, asked the two questions the
      // "tests are locked while implementing" claim rests on. Asking it here is
      // the only way to see what the workflow actually wired up, rather than
      // what the gate would do if it were wired correctly.
      if (req.stage === 'implement') {
        verdicts.test = req.gate?.('Edit', { file_path: 'added-1.test.ts' }) ?? null;
        verdicts.source = req.gate?.('Edit', { file_path: 'src/thing.ts' }) ?? null;
      }

      return {
        stage: req.stage,
        output: 'done',
        cost: 0,
        costUnit: 'usd',
        provider: 'stub',
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
 * A suite that fails on exactly the runs named, and passes on the rest.
 *
 * The workflow runs the suite three times per attempt and each one means
 * something different: green before anything is written (nothing was already
 * broken), red after the tests are written (they exercise behaviour that does
 * not exist yet), green after the change (it works). A suite that always passed
 * was rejected at the second one — correctly, since tests that pass before the
 * feature exists prove nothing.
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
  *" $n "*) echo "✖ not implemented yet (run $n)"; exit 1 ;;
esac
echo ok
exit 0
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

async function fixture(
  failOn: readonly number[] = [],
  verdicts: GateVerdicts = {},
  rungs: { stage: string; tier: Tier; effort?: string }[] = [],
) {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-handoff-'));
  // The suite script and its counter live outside the repo on purpose. Written
  // inside it they are untracked files, which is a dirty tree, and a dirty tree
  // is exactly what makes the workflow decline to branch — so the fixture would
  // have been testing its own mess rather than the branching.
  const aux = mkdtempSync(join(tmpdir(), 'sumo-handoff-aux-'));

  await run('git init -q && git config user.email t@t && git config user.name t', dir);
  writeFileSync(join(dir, 'a.txt'), 'x\n', 'utf8');
  await run('git add -A && git commit -qm init', dir);

  const seen: string[] = [];
  return {
    dir,
    seen,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(aux, { recursive: true, force: true });
    },
    ctx: {
      fleet: Fleet.of(stubEngine(seen, verdicts, rungs)),
      ledger: new Ledger(),
      state: new TaskState(findRepo(dir), 'handoff-test'),
      cwd: dir,
      input: scriptedInput(['y', 'y', 'y']),
      isTty: true,
      // Deliberately false: an approval that is handed over must not need the
      // auto-approve escape hatch to get through. If the gate still runs, the
      // scripted answers would hide that — this makes it observable.
      autoApprove: false,
      testCommand: scriptedSuite(aux, failOn),
    },
  };
}

const APPROVED: ApprovedPlan = {
  plan: 'Approach:\n  Add the thing.',
  findings: 'Files:\n  - a.txt',
  tests: 1,
};

test('an approved plan is built, not planned again', async () => {
  const { seen, ctx, cleanup } = await fixture([2]);
  try {
    const outcome = await runFeature('add the thing', { tier: 'small' }, ctx, '', APPROVED);

    assert.equal(outcome.kind, 'built');
    // The two stages whose whole output was already handed over.
    assert.equal(seen.includes('explore'), false, 'explore must not run again');
    assert.equal(seen.includes('plan'), false, 'plan must not run again');
    // And the work still happened.
    assert.deepEqual(seen, ['write-tests', 'implement']);
  } finally {
    cleanup();
  }
});

test('without a handoff the workflow still explores and plans for itself', async () => {
  const { seen, ctx, cleanup } = await fixture([2]);
  try {
    // `/feature` typed directly has nothing handed to it, so the gate is real
    // and the scripted `y` is what gets through it.
    const outcome = await runFeature(
      'add the thing',
      { tier: 'small' },
      { ...ctx, autoApprove: true },
    );

    assert.equal(outcome.kind, 'built');
    assert.equal(seen[0], 'explore', 'it surveys first');
    assert.ok(seen.includes('plan'), 'and writes its own proposal');
  } finally {
    cleanup();
  }
});

test('a handed-over plan that declares no tests skips the test stages', async () => {
  const { seen, ctx, cleanup } = await fixture();
  try {
    // Documentation, a config default, a rename: real work with no testable
    // contract. This used to reach write-tests, correctly report there was
    // nothing to write, and be stopped for being right.
    const outcome = await runFeature('document the thing', { tier: 'small' }, ctx, '', {
      ...APPROVED,
      tests: 0,
    });

    assert.equal(outcome.kind, 'built');
    assert.equal(seen.includes('write-tests'), false, 'nothing to write, so nothing runs');
    assert.deepEqual(seen, ['implement']);
  } finally {
    cleanup();
  }
});

test('the branch is made once and rejoined on the next attempt', async () => {
  const { dir, ctx, cleanup } = await fixture([2, 5]);
  try {
    const first = await runFeature('add the thing', { tier: 'small' }, ctx, '', APPROVED);
    const after = await run('git rev-parse --abbrev-ref HEAD', dir);

    // Iterating: same request, second attempt. It belongs where the first is.
    const second = await runFeature('add the thing', { tier: 'small' }, ctx, '', APPROVED);

    assert.equal(first.kind === 'built' ? first.branch : null, 'sumo/add-thing');
    assert.equal(second.kind === 'built' ? second.branch : null, 'sumo/add-thing');
    assert.equal(after.output.trim(), 'sumo/add-thing');

    const branches = await run('git branch --list "sumo/*" --format="%(refname:short)"', dir);
    assert.deepEqual(
      branches.output.trim().split('\n').filter(Boolean),
      ['sumo/add-thing'],
      'one branch for one piece of work, however many attempts it takes',
    );
  } finally {
    cleanup();
  }
});

test('the tests written this turn are locked while implementing', async () => {
  // The load-bearing claim of the whole workflow: "make the tests pass" must not
  // be satisfiable by weakening a test. The gate enforces that, but only if the
  // workflow hands it the right paths — so this asks the gate the workflow
  // actually built, rather than one constructed for the test.
  const verdicts: GateVerdicts = {};
  const { seen, ctx, cleanup } = await fixture([2], verdicts);
  try {
    await runFeature('add the thing', { tier: 'small' }, ctx, '', APPROVED);

    assert.ok(seen.includes('implement'), 'the implement stage ran');
    assert.match(
      verdicts.test ?? '',
      /locked/,
      'editing the test written this turn is refused',
    );
    assert.equal(verdicts.source, null, 'editing the implementation is allowed');
  } finally {
    cleanup();
  }
});

test('a plan with no tests locks nothing, and still may not weaken the suite', async () => {
  // The no-tests path skips write-tests, so there is nothing from this turn to
  // lock. It must not lock arbitrarily, and must not silently gain the right to
  // rewrite tests that already existed either — there simply are none of its own.
  const verdicts: GateVerdicts = {};
  const { ctx, cleanup } = await fixture([], verdicts);
  try {
    await runFeature('document the thing', { tier: 'small' }, ctx, '', { ...APPROVED, tests: 0 });

    assert.equal(verdicts.source, null, 'the change it was approved to make is allowed');
    assert.equal(verdicts.test, null, 'nothing was written this turn, so nothing is locked');
  } finally {
    cleanup();
  }
});

test('a failing verification is retried, then climbed, in feature as well as fix', async () => {
  // `fix` has had its ladder tested since it was written; `feature` carries a
  // second copy of the same loop and never did. A ladder that only works in one
  // of the two workflows is worse than none, because the other silently gives
  // up on the first failure.
  //
  // Suite runs: 1 pre-existing (green), 2 prove-failing (red, as required),
  // then one verify per implement attempt — 3 and 4 red, 5 green.
  const rungs: { stage: string; tier: Tier; effort?: string }[] = [];
  const { ctx, cleanup } = await fixture([2, 3, 4], {}, rungs);
  try {
    const outcome = await runFeature(
      'add the thing',
      { tier: 'mid', effort: 'low' },
      ctx,
      '',
      APPROVED,
    );

    assert.equal(outcome.kind, 'built');
    if (outcome.kind === 'built') assert.equal(outcome.verified, true);

    const attempts = rungs.filter((r) => r.stage === 'implement');
    assert.equal(attempts.length, 3, 'first attempt, one retry, one climb');
    // A retry is not an escalation: the same rung gets a second go with the
    // failing output in hand before anything more expensive is reached for.
    assert.equal(attempts[0]?.tier, 'mid');
    assert.equal(attempts[1]?.tier, 'mid', 'the retry stays where it was');
    // Only then does it climb — and effort rises before the model does.
    assert.equal(attempts[2]?.tier, 'mid', 'thinking harder is cheaper than a bigger model');
    assert.notEqual(attempts[2]?.effort, attempts[1]?.effort, 'but it does change gear');
  } finally {
    cleanup();
  }
});

test('feature gives up rather than climbing forever', async () => {
  // Nothing passes, ever. The ladder has to stop on its own.
  const rungs: { stage: string; tier: Tier; effort?: string }[] = [];
  const { ctx, cleanup } = await fixture([2, 3, 4, 5, 6, 7, 8, 9, 10], {}, rungs);
  try {
    const outcome = await runFeature('add the thing', { tier: 'small' }, ctx, '', APPROVED);

    assert.equal(outcome.kind, 'stopped');
    // Three cheap attempts beat one expensive one only up to a point; past it,
    // the retries cost more than the answer was ever worth.
    const attempts = rungs.filter((r) => r.stage === 'implement');
    assert.ok(attempts.length <= 6, `gave up after ${attempts.length} attempts, not forever`);
    assert.ok(attempts.length >= 2, 'but it did try more than once');
  } finally {
    cleanup();
  }
});
