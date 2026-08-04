/**
 * `feature` — the test-first workflow.
 *
 * branch → explore (read-only) → plan → YOUR APPROVAL → write failing tests →
 * the harness proves they fail → implement with those tests LOCKED → the
 * harness proves they pass.
 *
 * Two things are enforced in code rather than requested in a prompt. The plan
 * stage cannot write, so nothing is built before you have agreed to it. And
 * during implementation the permission gate refuses edits to the test files, so
 * "make the tests pass" cannot be satisfied by weakening a test.
 */

import pc from 'picocolors';
import type { Engine } from '../engine/index.ts';
import { afterFailure, startAt } from '../escalate.ts';
import * as failures from '../failures.ts';
import { askApproval, MAX_REVISIONS, producedNothing, rescopeHint } from '../gate.ts';
import type { LineReader } from '../input.ts';
import type { Ledger } from '../ledger.ts';
import { DISCUSS_STAGE, EXPLORE_STAGE, FEATURE_PLAN_STAGE, IMPLEMENT_STAGE, WRITE_TESTS_STAGE } from '../prompts.ts';
import * as runner from '../runner.ts';
import { Explore, jsonSchema, Plan } from '../schemas.ts';
import { runStage } from '../stage.ts';
import type { Progress } from '../progress.ts';
import type { Steering } from '../steer.ts';
import type { TaskState } from '../state.ts';
import { rungAt, type Rung } from '../types.ts';
import * as ui from '../ui.ts';

export interface FeatureContext {
  readonly engine: Engine;
  readonly ledger: Ledger;
  readonly state: TaskState;
  readonly cwd: string;
  readonly input: LineReader;
  readonly isTty: boolean;
  readonly autoApprove: boolean;
  readonly testCommand: string | null;
  /** True when the index supplied context, so broad searching is throttled. */
  readonly indexed?: boolean;
  /** How much of the first stage's prompt came from the index, for the ledger. */
  readonly packChars?: number;
  /** Anything typed while this task runs, folded into the next stage. */
  readonly steer?: Steering;
  /** Announces which leg of the route each stage is. */
  readonly progress?: Progress;
}

export type FeatureOutcome =
  | {
      readonly kind: 'built';
      readonly verified: boolean;
      readonly branch: string | null;
    }
  | { readonly kind: 'stopped'; readonly why: string; readonly branch: string | null };

/**
 * A plan the operator has already approved, handed over rather than re-derived.
 *
 * `plan` mode ends by asking whether to build; without this, the build then ran
 * its own explore and plan and asked the very same question again, thirty
 * seconds later. The stages replayed from cache for nothing, so it cost no
 * money — but being asked twice reads as the harness not having heard the first
 * answer, and an approval gate that repeats itself is one people learn to click
 * through.
 */
export interface ApprovedPlan {
  readonly plan: string;
  /** The exploration the plan was written against — the tests are written from it. */
  readonly findings: string;
  /** How many tests the plan asks for. Zero is a claim, not an omission. */
  readonly tests: number;
}

export async function runFeature(
  task: string,
  rung: Rung,
  ctx: FeatureContext,
  /** The index's answer for this task. Stable, unlike the conversation. */
  packContext = '',
  alreadyApproved?: ApprovedPlan,
): Promise<FeatureOutcome> {
  const { engine, ledger, state, cwd } = ctx;

  // 0. Branch first, so everything that follows is reviewable and revertable.
  const branch = await startBranch(task, ctx);

  // Record what was already broken. Without this, "make the failing tests pass"
  // sweeps in unrelated pre-existing failures and the feature quietly grows.
  const preExisting = await preExistingFailures(ctx);

  // And what was already modified. `startBranch` declines on a dirty tree and
  // the task continues on the current branch, so "everything git reports as
  // changed" is not the same as "what the write-tests stage produced" — it also
  // contains whatever the operator had in flight. Taken as tests, those files
  // would be locked against editing during implement, and an empty tests stage
  // would look like it had written something.
  const alreadyChanged = new Set(await runner.changedFiles(cwd));

  // 1. Explore — read-only. Its job is to find what already exists. Skipped
  // outright when `plan` mode already did it and the operator approved what it
  // produced; re-running it would replay from cache, but only to arrive back at
  // an answer that was handed over in the first place.
  const explore = alreadyApproved ? null : await runStage(
    engine,
    {
      name: 'explore',
      prompt: EXPLORE_STAGE(task, await runner.repoFiles(cwd), packContext),
      // Retrieval, not reasoning: effort stays low whatever the rung.
      rung: { tier: rung.tier === 'small' ? 'small' : 'mid', effort: 'low' },
      capabilities: ['read', 'search'],
      cwd,
      ...(ctx.indexed ? { indexed: true } : {}),
      ...(ctx.packChars !== undefined ? { packChars: ctx.packChars } : {}),
      allowWrites: false,
      outputSchema: jsonSchema(Explore),
      ...(ctx.steer ? { steer: ctx.steer } : {}),
      ...(ctx.progress ? { progress: ctx.progress } : {}),
      onEvent: ui.renderEvent,
    },
    ledger,
  );
  let exploreText = alreadyApproved?.findings ?? '';
  if (explore) {
    ui.endTurn();
    const found = ui.shownExplore(explore.output);
    exploreText = found.prompt;
    state.write('explore.md', exploreText);
    if (found.value) ui.renderArtifact(found.display);
  }

  // 2. Plan, then the gate. Nothing is built before you agree to it — but an
  // approval already given is not asked for again.
  const approved = alreadyApproved
    ? { kind: 'approved' as const, plan: alreadyApproved.plan, tests: alreadyApproved.tests }
    : await gatePlan(task, exploreText, rung, ctx);
  if (approved.kind === 'stopped') {
    return { kind: 'stopped', why: approved.why, branch };
  }

  // Some approved work has no testable contract at all — documentation, a
  // config default, a rename. Test-first is the right default for behaviour,
  // but as a hard gate it killed those tasks at the stage that had nothing to
  // write: the plan correctly declared no tests, and the workflow stopped the
  // task for being right, after paying for every stage that got it there.
  //
  // The plan is the authority. When it asks for none, the test stages are
  // skipped rather than failed, and the suite still has to come back green.
  if (approved.tests === 0) {
    process.stdout.write(
      pc.dim('  the plan declares no tests — going straight to the change\n'),
    );
    return await implementUntilVerified(
      approved.plan,
      'The approved plan specifies no tests: this change has no testable behaviour.',
      preExisting,
      [],
      rung,
      branch,
      ctx,
    );
  }

  // 3. Tests first — and only tests.
  const tests = await runStage(
    engine,
    {
      name: 'write-tests',
      prompt: WRITE_TESTS_STAGE(approved.plan, exploreText),
      rung: { tier: rung.tier, effort: rung.tier === 'small' ? undefined : 'medium' },
      capabilities: ['read', 'search', 'edit'],
      cwd,
      ...(ctx.indexed ? { indexed: true } : {}),
      allowWrites: true,
      ...(ctx.steer ? { steer: ctx.steer } : {}),
      ...(ctx.progress ? { progress: ctx.progress } : {}),
      onEvent: ui.renderEvent,
    },
    ledger,
  );
  ui.endTurn();
  state.write('tests.md', tests.output);

  const testFiles = (await runner.changedFiles(cwd)).filter((f) => !alreadyChanged.has(f));
  if (testFiles.length === 0) {
    return { kind: 'stopped', why: 'no test files were written', branch };
  }

  // 4. Prove the tests fail. A green suite here means they test nothing.
  const baseline = await proveFailing(ctx);
  if (baseline.kind === 'stopped') {
    return { kind: 'stopped', why: baseline.why, branch };
  }

  // 5 & 6. Implement and verify, climbing the ladder while the tests fail.
  return await implementUntilVerified(
    approved.plan,
    baseline.output,
    preExisting,
    testFiles,
    rung,
    branch,
    ctx,
  );
}

/**
 * Implements, then lets the test suite decide whether to try again, try harder,
 * or stop. The test files stay locked through every attempt, so no amount of
 * escalation can turn "make the tests pass" into "change the tests".
 */
async function implementUntilVerified(
  plan: string,
  failingOutput: string,
  preExisting: string | null,
  testFiles: readonly string[],
  rung: Rung,
  branch: string | null,
  ctx: FeatureContext,
): Promise<FeatureOutcome> {
  let ladder = startAt(rung);
  let testOutput = failingOutput;
  let attempt = 0;
  let previous: failures.Failure[] = [];

  for (;;) {
    const current = rungAt(ladder.rung);
    const implement = await runStage(
      ctx.engine,
      {
        name: 'implement',
        prompt: IMPLEMENT_STAGE(plan, testOutput, preExisting),
        // The ladder's rung, verbatim. This used to hardcode `medium`, which
        // discarded the effort dimension entirely: climbing from mid/low to
        // mid/high produced an identical stage — same model, same thinking —
        // so that escalation bought a second full attempt and changed nothing.
        // The ladder exists to say how hard to try; the stage does not get to
        // overrule it.
        rung: current,
        capabilities: ['read', 'search', 'edit'],
        cwd: ctx.cwd,
        ...(ctx.indexed ? { indexed: true } : {}),
        allowWrites: true,
        lockedPaths: testFiles,
        attempt,
        // New files still go through Write; existing ones are edited in place.
        preferTargetedEdits: true,
        ...(ctx.steer ? { steer: ctx.steer } : {}),
        ...(ctx.progress ? { progress: ctx.progress } : {}),
        onEvent: ui.renderEvent,
      },
      ctx.ledger,
    );
    ui.endTurn();
    ctx.state.write('implement.md', implement.output);

    if (!ctx.testCommand) {
      process.stdout.write(pc.yellow('\n  unverified — no test command detected\n'));
      return { kind: 'built', verified: false, branch };
    }

    process.stdout.write(pc.dim(`\n  running ${ctx.testCommand}\n`));
    const final = await runner.runTests(ctx.testCommand, ctx.cwd);
    ctx.state.write('verify.txt', final.output);

    if (final.passed) {
      process.stdout.write(pc.green('  tests pass\n'));
      return { kind: 'built', verified: true, branch };
    }

    // A suite that was already red stays red. Report whether this task made it
    // worse, rather than a failure the task did not cause.
    if (preExisting && runner.newFailures(preExisting, final.output).length === 0) {
      process.stdout.write(
        pc.green('  your tests pass') +
          pc.yellow(' — the suite is still red from failures that pre-date this task\n'),
      );
      return { kind: 'built', verified: true, branch };
    }

    const step = afterFailure(ladder);
    if (step.kind === 'giveUp') {
      process.stdout.write(pc.red(`  giving up — ${step.why}\n`));
      if (branch) {
        process.stdout.write(pc.dim(`  the work is on ${branch}; delete it to discard\n`));
      }
      return { kind: 'stopped', why: step.why, branch };
    }

    process.stdout.write(pc.yellow(`  ${step.why}\n`));
    if (step.state.rung !== ladder.rung) ctx.ledger.noteEscalation();
    ladder = step.state;
    attempt += 1;

    // The failing assertions, as a table rather than as the log they arrived in.
    // Falls back to the raw output whenever the parser recognised nothing.
    const parsed = failures.parse(final.output);
    const table = failures.toPrompt(parsed, previous);
    previous = parsed;
    testOutput = table === '' ? final.output : table;
  }
}

/**
 * Runs the suite before anything is written, so a already-broken project can be
 * distinguished from breakage this task caused.
 *
 * Returns the failing output, or null when the suite was green (the normal
 * case). Cheap: one deterministic test run, no tokens.
 */
async function preExistingFailures(ctx: FeatureContext): Promise<string | null> {
  if (!ctx.testCommand) return null;

  const outcome = await runner.runTests(ctx.testCommand, ctx.cwd);
  if (outcome.passed) return null;

  process.stdout.write(
    pc.yellow('  note: the suite is already failing before this task starts\n'),
  );
  ctx.state.write('pre-existing.txt', outcome.output);
  return outcome.output;
}

/** Puts the task on its own branch, reporting clearly when it cannot. */
async function startBranch(task: string, ctx: FeatureContext): Promise<string | null> {
  const wanted = runner.branchNameFor(task);
  const result = await runner.createBranch(ctx.cwd, wanted);

  if (result.kind === 'created') {
    process.stdout.write(pc.dim(`  branch ${pc.cyan(result.branch)} (from ${result.from})\n`));
    return result.branch;
  }

  // Said out loud rather than inferred from a silent absence of "branch …":
  // joining an existing branch is the right default, but only if you can see
  // that it happened.
  if (result.kind === 'reused') {
    // A branch named for this task is iteration, and needs no explanation. A
    // branch named for a different one means new work landing beside old — the
    // right default while iterating, the wrong one when starting something
    // else, and only the operator can tell which. So the way out is named
    // rather than left to be discovered.
    const note =
      result.branch === wanted
        ? ''
        : pc.dim(` — /git checkout main first to start ${pc.cyan(wanted)}`);
    process.stdout.write(`${pc.dim(`  continuing on ${pc.cyan(result.branch)}`)}${note}\n`);
    return result.branch;
  }

  process.stdout.write(pc.yellow(`  working on the current branch — ${result.why}\n`));
  return null;
}

/**
 * The plan stage plus its approval loop.
 *
 * The plan is written once and then held. Asking a question about it must not
 * regenerate it — an earlier version re-ran the plan stage on every `continue`,
 * so a question cost a fresh plan and answered about a proposal that no longer
 * existed. Only an actual revision buys a new one.
 */
async function gatePlan(
  task: string,
  findings: string,
  rung: Rung,
  ctx: FeatureContext,
): Promise<
  { kind: 'approved'; plan: string; tests: number } | { kind: 'stopped'; why: string }
> {
  // How many tests the current proposal asks for. A plan that asks for none is
  // making a claim about the work, and the workflow has to honour it.
  let tests = 0;
  // Why the last plan stage ended, when it ended early. Kept beside `tests`
  // because both are facts about the attempt rather than about the plan.
  let stopped: string | undefined;

  const makePlan = async (feedback: string): Promise<ui.Shown<Plan>> => {
    const planned = await runStage(
      ctx.engine,
      {
        name: 'plan',
        prompt: FEATURE_PLAN_STAGE(task, findings, feedback),
        // Planning is where thinking actually pays, so effort steps up here.
        rung: { tier: rung.tier, effort: rung.tier === 'small' ? undefined : 'high' },
        capabilities: ['read', 'search'],
        cwd: ctx.cwd,
        ...(ctx.indexed ? { indexed: true } : {}),
        allowWrites: false,
        outputSchema: jsonSchema(Plan),
        ...(ctx.steer ? { steer: ctx.steer } : {}),
        ...(ctx.progress ? { progress: ctx.progress } : {}),
        onEvent: ui.renderEvent,
      },
      ctx.ledger,
    );
    ui.endTurn();
    stopped = planned.stopped;

    const proposal = ui.shownPlan(planned.output);
    // An unparseable plan is not a claim that no tests are needed, so it counts
    // as one rather than routing the task down the no-tests path by accident.
    tests = proposal.value ? proposal.value.tests.length : 1;
    ctx.state.write('plan.md', proposal.prompt);
    return proposal;
  };

  let plan = await makePlan('');
  let revisions = 0;
  // After a question is answered the plan is still on screen; reprinting it
  // would push the answer out of view.
  let shown = false;

  for (;;) {
    // A stage that ended early answers with nothing, and a gate with nothing in
    // it invites approval of nothing. Covers the revision path too, because a
    // revision assigns `plan` and comes back around.
    if (plan.prompt.trim().length === 0) {
      return { kind: 'stopped', why: producedNothing('plan', stopped) };
    }

    const decision = await askApproval(
      ctx.input,
      {
        title: 'Approve this plan?',
        ...(ctx.steer ? { steer: ctx.steer } : {}),
        // A schema-answering stage streams nothing, so the gate shows the plan.
        ...(shown ? {} : { body: plan.display }),
        warnings: ctx.testCommand
          ? []
          : ['No test command detected — tests cannot be proven to fail or pass. Set one with /tests <command>.'],
      },
      ctx.isTty,
      ctx.autoApprove,
    );

    if (decision.kind === 'approved') return { kind: 'approved', plan: plan.prompt, tests };
    if (decision.kind === 'rejected') return { kind: 'stopped', why: 'you stopped it' };

    // A question is not a revision: answer it and ask again, keeping the
    // proposal intact and the revision budget untouched.
    if (decision.kind === 'discuss') {
      await runStage(
        ctx.engine,
        {
          name: 'discuss',
          prompt: DISCUSS_STAGE(plan.prompt, decision.question),
          rung: { tier: rung.tier === 'small' ? 'small' : 'mid', effort: 'low' },
          capabilities: ['read', 'search'],
          cwd: ctx.cwd,
          ...(ctx.indexed ? { indexed: true } : {}),
          allowWrites: false,
          ...(ctx.steer ? { steer: ctx.steer } : {}),
          ...(ctx.progress ? { progress: ctx.progress } : {}),
          onEvent: ui.renderEvent,
        },
        ctx.ledger,
      );
      ui.endTurn();
      shown = true;
      continue;
    }

    if (revisions >= MAX_REVISIONS) {
      return { kind: 'stopped', why: rescopeHint('this feature') };
    }
    revisions += 1;
    plan = await makePlan(decision.feedback);
    shown = false;
  }
}

/**
 * Runs the suite and insists it is red.
 *
 * A green suite at this point is a failure, not a success: it means the new
 * tests do not exercise the missing behaviour, and implementing against them
 * would prove nothing.
 */
async function proveFailing(
  ctx: FeatureContext,
): Promise<{ kind: 'ok'; output: string } | { kind: 'stopped'; why: string }> {
  if (!ctx.testCommand) {
    return { kind: 'ok', output: '(no test command; tests were not run)' };
  }

  process.stdout.write(pc.dim(`\n  running ${ctx.testCommand} — expecting failures\n`));
  const outcome = await runner.runTests(ctx.testCommand, ctx.cwd);
  ctx.state.write('baseline.txt', outcome.output);

  if (outcome.passed) {
    process.stdout.write(pc.yellow('  tests already pass — they do not test the new behaviour\n'));
    return {
      kind: 'stopped',
      why: 'the new tests passed before anything was implemented, so they prove nothing',
    };
  }

  process.stdout.write(pc.green('  failing as expected\n'));
  return { kind: 'ok', output: outcome.output };
}
