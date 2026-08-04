/**
 * `fix` — the evidence-driven bug workflow.
 *
 * evidence (read-only) → repro run by the harness → root cause → YOUR APPROVAL
 * → fix → the harness verifies by running the tests.
 *
 * The ordering is enforced here in code, not requested in a prompt: the fix
 * stage is the first one granted write access, and it is unreachable until the
 * gate returns approved. And while fixing, the permission gate refuses edits
 * to whichever test files are already failing, so a red test cannot be made to
 * pass by editing the test rather than the bug.
 */

import pc from 'picocolors';
import type { Engine } from '../engine/index.ts';
import { afterFailure, startAt } from '../escalate.ts';
import * as failures from '../failures.ts';
import { askApproval, MAX_REVISIONS, producedNothing, rescopeHint } from '../gate.ts';
import { repoFingerprint } from '../hash.ts';
import type { LineReader } from '../input.ts';
import type { Ledger } from '../ledger.ts';
import {
  DISCUSS_STAGE,
  EVIDENCE_STAGE,
  feedbackBlock,
  FIX_STAGE,
  ROOT_CAUSE_STAGE,
} from '../prompts.ts';
import * as runner from '../runner.ts';
import { Evidence, jsonSchema, RootCause } from '../schemas.ts';
import { runStage } from '../stage.ts';
import type { Progress } from '../progress.ts';
import type { Steering } from '../steer.ts';
import { TaskState } from '../state.ts';
import { rungAt, type Rung } from '../types.ts';
import * as ui from '../ui.ts';

export interface FixContext {
  readonly engine: Engine;
  readonly ledger: Ledger;
  readonly state: TaskState;
  readonly cwd: string;
  readonly input: LineReader;
  readonly isTty: boolean;
  readonly autoApprove: boolean;
  /** Runs the project's tests, or null when none could be detected. */
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

export type FixOutcome =
  | { readonly kind: 'fixed'; readonly verified: boolean }
  | { readonly kind: 'stopped'; readonly why: string };

export async function runFix(
  bug: string,
  rung: Rung,
  ctx: FixContext,
  /** The index's answer for this task. Stable, unlike the conversation. */
  packContext = '',
): Promise<FixOutcome> {
  const { engine, ledger, state, cwd } = ctx;

  // Record what was already broken. Without this a single unrelated red test
  // makes an otherwise-correct fix unverifiable — verify() is all-or-nothing,
  // so the ladder would retry, escalate, and give up on a failure this task
  // did not cause.
  const preExisting = await preExistingFailures(ctx);

  // The same task against an unchanged repository has the same evidence, and
  // paying to gather it twice is what a retried fix used to do — see
  // TaskState.findArtifact.
  const fingerprint = await repoFingerprint(cwd);
  const reusable =
    fingerprint === null ? null : TaskState.findArtifact(state.repo, bug, fingerprint, 'evidence.md');
  if (reusable !== null) {
    process.stdout.write(pc.dim('  reusing the evidence from an earlier attempt\n'));
  }

  // 1. Evidence — read-only. Cannot edit even if it decides it knows the answer.
  // Skipped outright when a matching attempt already gathered it.
  const evidence = reusable !== null ? null : await runStage(
    engine,
    {
      name: 'evidence',
      prompt: EVIDENCE_STAGE(bug, packContext),
      // Retrieval, not reasoning: effort stays low regardless of the rung.
      rung: { tier: rung.tier === 'small' ? 'small' : 'mid', effort: 'low' },
      capabilities: ['read', 'search'],
      cwd,
      ...(ctx.indexed ? { indexed: true } : {}),
      ...(ctx.packChars !== undefined ? { packChars: ctx.packChars } : {}),
      allowWrites: false,
      outputSchema: jsonSchema(Evidence),
      ...(ctx.steer ? { steer: ctx.steer } : {}),
      ...(ctx.progress ? { progress: ctx.progress } : {}),
      onEvent: ui.renderEvent,
    },
    ledger,
  );

  // A stage cut short by its budget can still return something worth showing,
  // so an unparseable answer degrades to prose rather than ending the task.
  let evidenceText = reusable ?? '';
  let evidenceValue: Evidence | null = null;
  if (evidence) {
    ui.endTurn();
    const found = ui.shownEvidence(evidence.output);
    evidenceText = found.prompt;
    evidenceValue = found.value;
    if (fingerprint !== null) state.write('fingerprint.txt', fingerprint);
    state.write('evidence.md', evidenceText);
    if (found.value) ui.renderArtifact(found.display);
  }

  // 2. Repro — proposed by the model, run by the harness, only with consent.
  // The command is a field now, not something recovered from a heading.
  const repro = evidenceValue?.repro ? await maybeRunRepro(evidenceValue.repro, ctx) : null;
  if (repro) state.write('repro.txt', repro);

  // 3. Root cause — where thinking actually pays, so effort steps up.
  const rootCause = await runStage(
    engine,
    {
      name: 'root-cause',
      prompt: ROOT_CAUSE_STAGE(bug, evidenceText, repro ?? ''),
      rung: { tier: rung.tier, effort: rung.tier === 'small' ? undefined : 'high' },
      capabilities: ['read', 'search'],
      cwd,
      ...(ctx.indexed ? { indexed: true } : {}),
      allowWrites: false,
      outputSchema: jsonSchema(RootCause),
      ...(ctx.steer ? { steer: ctx.steer } : {}),
      ...(ctx.progress ? { progress: ctx.progress } : {}),
      onEvent: ui.renderEvent,
    },
    ledger,
  );
  ui.endTurn();

  const diagnosis = ui.shownRootCause(rootCause.output);
  state.write('rootcause.md', diagnosis.prompt);
  if (diagnosis.prompt.trim().length === 0) {
    return { kind: 'stopped', why: producedNothing('root-cause', rootCause.stopped) };
  }

  // 4. The gate. Nothing below this line runs without approval.
  const approved = await gateRootCause(diagnosis, bug, rung, ctx);
  if (approved.kind === 'stopped') return approved;

  // Whichever tests are already failing are what a lazy "fix" would be tempted
  // to weaken instead of the actual bug — locked on every attempt, including
  // the first, not just requested not to be touched in the prompt.
  const lockedPaths = failures.testFiles(failures.parse(`${preExisting ?? ''}\n${repro ?? ''}`));

  // 5 & 6. Fix, verify, and climb the ladder while the tests still fail.
  return await fixUntilVerified(approved.rootCause, approved.notes, preExisting, lockedPaths, rung, ctx);
}

/**
 * Applies the fix, then lets the test suite decide whether to try again, try
 * harder, or stop. The model never gets a say in whether its own work passed.
 */
async function fixUntilVerified(
  rootCause: string,
  notes: readonly string[],
  preExisting: string | null,
  lockedPaths: readonly string[],
  rung: Rung,
  ctx: FixContext,
): Promise<FixOutcome> {
  let ladder = startAt(rung);
  let extra = [...notes];
  let attempt = 0;
  let previous: failures.Failure[] = [];

  for (;;) {
    const current = rungAt(ladder.rung);
    const fix = await runStage(
      ctx.engine,
      {
        name: 'fix',
        prompt: FIX_STAGE(rootCause, extra),
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
        lockedPaths,
        attempt,
        // A minimal fix is by definition a few lines; rewriting whole files to
        // deliver it would generate every line that was already right.
        preferTargetedEdits: true,
        ...(ctx.steer ? { steer: ctx.steer } : {}),
        ...(ctx.progress ? { progress: ctx.progress } : {}),
        onEvent: ui.renderEvent,
      },
      ctx.ledger,
    );
    ui.endTurn();
    ctx.state.write('fix.md', fix.output);

    const outcome = await verify(ctx, preExisting);
    if (outcome.kind === 'fixed' && outcome.verified) return outcome;

    // Without a way to run tests there is nothing to escalate on; saying the
    // change is unverified is more honest than retrying against no evidence.
    if (!ctx.testCommand) return outcome;

    const step = afterFailure(ladder);
    if (step.kind === 'giveUp') {
      await reportGiveUp(step.why, ctx);
      return { kind: 'stopped', why: step.why };
    }

    process.stdout.write(pc.yellow(`  ${step.why}\n`));
    if (step.state.rung !== ladder.rung) ctx.ledger.noteEscalation();
    ladder = step.state;
    attempt += 1;

    // The failing output is the whole point of another attempt — but as a table
    // of assertions, not as the log it arrived in.
    const output = ctx.state.read('verify.txt') ?? '';
    const parsed = failures.parse(output);
    const table = failures.toPrompt(parsed, previous);
    previous = parsed;

    // The operator's corrections stay at the front of the list on every retry;
    // the failing output is appended as one more note rather than replacing
    // them, so a fix that satisfies the tests cannot quietly undo what was asked.
    extra = [
      ...notes,
      'The previous attempt did not pass.\n' +
        // A parser that recognised nothing must not be allowed to swallow the
        // evidence: fall back to what the runner actually said.
        (table === '' ? `Test output:\n${output}` : `Failing tests:\n${table}`),
    ];
  }
}

/** Leaves the user with the evidence and a way back. */
async function reportGiveUp(why: string, ctx: FixContext): Promise<void> {
  const files = await runner.changedFiles(ctx.cwd);
  process.stdout.write(pc.red(`  giving up — ${why}\n`));
  if (files.length > 0) {
    process.stdout.write(pc.dim(`  changed: ${files.join(', ')}\n`));
    process.stdout.write(pc.dim(`  revert with: git checkout -- ${files.join(' ')}\n`));
  }
}

/** Handles the approval loop, including revisions. */
async function gateRootCause(
  initial: ui.Shown<RootCause>,
  bug: string,
  rung: Rung,
  ctx: FixContext,
): Promise<
  | { kind: 'approved'; rootCause: string; notes: readonly string[] }
  | { kind: 'stopped'; why: string }
> {
  let cause = initial;
  // Every correction, in order: a revision shown only the newest was free to
  // undo an earlier one — see feedbackBlock in prompts.ts.
  const notes: string[] = [];
  // The proposal is already on screen after a question was answered; printing it
  // again just pushes the answer out of view.
  let shown = false;

  for (let revision = 0; ; revision += 1) {
    const decision = await askApproval(
      ctx.input,
      {
        // The analysis no longer streams past as prose — the stage answers in a
        // schema — so the gate is where it gets shown.
        title: 'Approve this root cause and fix?',
        ...(ctx.steer ? { steer: ctx.steer } : {}),
        ...(shown ? {} : { body: cause.display }),
        warnings: ctx.testCommand
          ? []
          : ['No test command detected — the fix cannot be verified automatically. Set one with /tests <command>.'],
      },
      ctx.isTty,
      ctx.autoApprove,
    );

    if (decision.kind === 'approved') return { kind: 'approved', rootCause: cause.prompt, notes };
    if (decision.kind === 'rejected') return { kind: 'stopped', why: 'you stopped it' };

    // A question is not a revision: answer it and ask again, keeping the
    // proposal intact and the revision budget untouched.
    if (decision.kind === 'discuss') {
      await runStage(
        ctx.engine,
        {
          name: 'discuss',
          prompt: DISCUSS_STAGE(cause.prompt, decision.question),
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
      revision -= 1;
      continue;
    }

    if (revision + 1 >= MAX_REVISIONS) {
      return { kind: 'stopped', why: rescopeHint('this bug') };
    }

    // Revise on a fresh stage: cheaper than a growing session, and immune to
    // the model defending its earlier answer.
    notes.push(decision.feedback);
    const revised = await runStage(
      ctx.engine,
      {
        name: 'root-cause',
        prompt:
          `${ROOT_CAUSE_STAGE(bug, cause.prompt, '')}\n\n` +
          `${feedbackBlock(notes)}\nRevise accordingly.`,
        rung: { tier: rung.tier, effort: rung.tier === 'small' ? undefined : 'high' },
        capabilities: ['read', 'search'],
        cwd: ctx.cwd,
        ...(ctx.indexed ? { indexed: true } : {}),
        allowWrites: false,
        outputSchema: jsonSchema(RootCause),
        ...(ctx.steer ? { steer: ctx.steer } : {}),
        ...(ctx.progress ? { progress: ctx.progress } : {}),
        onEvent: ui.renderEvent,
      },
      ctx.ledger,
    );
    ui.endTurn();

    cause = ui.shownRootCause(revised.output);
    ctx.state.write('rootcause.md', cause.prompt);
    // A revision produced something new, so it does need showing.
    shown = false;
  }
}

/**
 * Runs a proposed repro command, only with explicit consent.
 *
 * The command arrives as a schema field rather than being recovered from a
 * heading in prose, so what runs here is what the stage meant to propose.
 */
async function maybeRunRepro(proposed: string, ctx: FixContext): Promise<string | null> {
  const command = proposed.trim();
  if (command.length === 0) return null;

  const { concerns } = runner.screenProposedCommand(command);

  const decision = await askApproval(
    ctx.input,
    {
      title: 'Run this to reproduce?',
      ...(ctx.steer ? { steer: ctx.steer } : {}),
      body: command,
      warnings: concerns.map((c) => `This command ${c}.`),
    },
    ctx.isTty,
    // A proposed command is never auto-approved on its concerns alone.
    ctx.autoApprove && concerns.length === 0,
  );

  if (decision.kind !== 'approved') {
    process.stdout.write(pc.dim('  skipped\n'));
    return null;
  }

  const result = await runner.run(command, ctx.cwd);
  process.stdout.write(pc.dim(`  ${result.ok ? 'ran' : `exit ${result.code ?? '?'}`}\n`));
  return `$ ${command}\n${result.output}`;
}

/** Runs the tests and reports whether the fix actually worked. */
async function verify(ctx: FixContext, preExisting: string | null): Promise<FixOutcome> {
  if (!ctx.testCommand) {
    const files = await runner.changedFiles(ctx.cwd);
    process.stdout.write(
      pc.yellow(`\n  unverified — no test command. Changed: ${files.join(', ') || 'nothing'}\n`),
    );
    return { kind: 'fixed', verified: false };
  }

  process.stdout.write(pc.dim(`\n  running ${ctx.testCommand}\n`));
  const outcome = await runner.runTests(ctx.testCommand, ctx.cwd);
  ctx.state.write('verify.txt', outcome.output);

  if (outcome.passed) {
    process.stdout.write(pc.green('  tests pass\n'));
    return { kind: 'fixed', verified: true };
  }

  // A suite that was already red stays red. Report whether this fix made it
  // worse, rather than a failure the task did not cause.
  if (preExisting && runner.newFailures(preExisting, outcome.output).length === 0) {
    process.stdout.write(
      pc.green('  tests pass') +
        pc.yellow(' — the suite is still red from failures that pre-date this task\n'),
    );
    return { kind: 'fixed', verified: true };
  }

  process.stdout.write(pc.red('  tests still failing\n'));
  return { kind: 'fixed', verified: false };
}

/**
 * Runs the suite before anything is written, so an already-broken project can
 * be distinguished from breakage this task caused.
 *
 * Returns the failing output, or null when the suite was green (the normal
 * case). Cheap: one deterministic test run, no tokens.
 */
async function preExistingFailures(ctx: FixContext): Promise<string | null> {
  if (!ctx.testCommand) return null;

  const outcome = await runner.runTests(ctx.testCommand, ctx.cwd);
  if (outcome.passed) return null;

  process.stdout.write(
    pc.yellow('  note: the suite is already failing before this task starts\n'),
  );
  ctx.state.write('pre-existing.txt', outcome.output);
  return outcome.output;
}
