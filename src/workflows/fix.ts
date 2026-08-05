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

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import pc from 'picocolors';
import type { Engine } from '../engine/index.ts';
import { afterFailure, startAt } from '../escalate.ts';
import * as failures from '../failures.ts';
import * as features from '../features.ts';
import { askApproval, MAX_REVISIONS, producedNothing, rescopeHint } from '../gate.ts';
import { findSecret, isCredentialPath, isInside } from '../gate-tools.ts';
import { repoFingerprint } from '../hash.ts';
import type { LineReader } from '../input.ts';
import type { Ledger } from '../ledger.ts';
import {
  DISCUSS_STAGE,
  ESCALATION_JUDGE_STAGE,
  EVIDENCE_STAGE,
  feedbackBlock,
  FIX_STAGE,
  ROOT_CAUSE_STAGE,
} from '../prompts.ts';
import * as runner from '../runner.ts';
import { EscalationVerdict, Evidence, jsonSchema, parse as parseSchema, RootCause } from '../schemas.ts';
import { runStage } from '../stage.ts';
import type { Progress } from '../progress.ts';
import type { Steering } from '../steer.ts';
import { TaskState } from '../state.ts';
import { rungAt, type Rung, type StageResult } from '../types.ts';
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
  | { readonly kind: 'stopped'; readonly why: string; readonly at?: 'gate' };

export async function runFix(
  bug: string,
  rung: Rung,
  ctx: FixContext,
  /** The index's answer for this task. Stable, unlike the conversation. */
  packContext = '',
  /**
   * Re-enters the approval gate directly with a previously saved diagnosis,
   * skipping evidence and root-cause entirely — how `/resume` picks a task back
   * up at exactly the gate it stopped at, rather than paying to reach it again.
   */
  resumeFrom?: { readonly rootCause: ui.Shown<RootCause> },
): Promise<FixOutcome> {
  const { engine, ledger, state, cwd } = ctx;

  // What this task's own stages are allowed to revert on a failed retry is
  // "everything that wasn't already dirty" — recorded before anything runs,
  // so unrelated in-flight work is never mistaken for a failed attempt's mess.
  // Recorded fresh on a resumed run too: resuming happens in a new process,
  // possibly after the operator has touched other files in the meantime.
  const alreadyChanged = new Set(await runner.changedFiles(cwd));

  // Record what was already broken. Without this a single unrelated red test
  // makes an otherwise-correct fix unverifiable — verify() is all-or-nothing,
  // so the ladder would retry, escalate, and give up on a failure this task
  // did not cause. Re-run on resume too, for the same reason `alreadyChanged`
  // is: the baseline is a fact about the tree right now, not about whenever
  // evidence first ran.
  const preExisting = await preExistingFailures(ctx);

  if (resumeFrom) {
    const approved = await gateRootCause(resumeFrom.rootCause, bug, rung, ctx);
    if (approved.kind === 'stopped') return approved;

    // Locked test files still matter on a resumed fix — a currently-failing
    // test is still a test a lazy fix could be tempted to weaken, whether this
    // run reached the gate today or three days ago. Rebuilt from `preExisting`
    // and whatever repro output the original run persisted; `reproTestFile` is
    // deliberately `null` here — a confirmed repro test from the original
    // evidence pass isn't itself persisted anywhere resume can recover it from,
    // so a resumed fix loses candidate sampling but keeps every safety
    // mechanism that doesn't depend on it.
    const repro = ctx.state.read('repro.txt');
    const lockedPaths = failures.testFiles(failures.parse(`${preExisting ?? ''}\n${repro ?? ''}`));

    return await fixUntilVerified(
      approved.rootCause,
      approved.notes,
      preExisting,
      lockedPaths,
      alreadyChanged,
      null,
      rung,
      ctx,
    );
  }

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

  // 2b. A reproduction TEST — a stronger signal than a shell command, and the
  // basis for candidate sampling below. `evidenceValue` is only populated on
  // the live evidence path above: a reused evidence.md is rendered text, not
  // the structured Evidence object this field lives on, so a reused pass
  // carries no reproTest — treated exactly like none having been proposed,
  // the same as the reused path already does for `repro`.
  const reproTestFile = evidenceValue?.reproTest
    ? await maybeWriteReproTest(evidenceValue.reproTest, ctx)
    : null;

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
  state.write('rootcause.display.md', diagnosis.display);
  if (diagnosis.prompt.trim().length === 0) {
    return { kind: 'stopped', why: producedNothing('root-cause', rootCause.stopped) };
  }

  // 4. The gate. Nothing below this line runs without approval.
  const approved = await gateRootCause(diagnosis, bug, rung, ctx);
  if (approved.kind === 'stopped') return approved;

  // Whichever tests are already failing are what a lazy "fix" would be tempted
  // to weaken instead of the actual bug — locked on every attempt, including
  // the first, not just requested not to be touched in the prompt.
  const baseLocked = failures.testFiles(failures.parse(`${preExisting ?? ''}\n${repro ?? ''}`));
  // A confirmed-failing repro test is now a currently-failing test like any
  // other in that set, and belongs in it for the same reason: a lazy fix must
  // not be able to weaken it either.
  const lockedPaths =
    reproTestFile && !baseLocked.includes(reproTestFile) ? [...baseLocked, reproTestFile] : baseLocked;

  // 5 & 6. Fix, verify, and climb the ladder while the tests still fail.
  return await fixUntilVerified(
    approved.rootCause,
    approved.notes,
    preExisting,
    lockedPaths,
    alreadyChanged,
    reproTestFile,
    rung,
    ctx,
  );
}

/**
 * Runs one `fix`-stage attempt. Extracted so an ordinary attempt and a
 * sampled candidate are, byte for byte, the same call — the only difference
 * candidate sampling is allowed to make is how many times this runs.
 */
async function runFixAttempt(
  rootCause: string,
  extra: readonly string[],
  rung: Rung,
  attempt: number,
  lockedPaths: readonly string[],
  ctx: FixContext,
): Promise<StageResult> {
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
      rung,
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
  return fix;
}

/**
 * Restores everything this task's own stages have touched since it started —
 * except the operator's own in-flight edits (`alreadyChanged`) and the locked
 * test files (`lockedPaths`), which now includes a confirmed repro test the
 * harness wrote on purpose. Shared by the ordinary between-rung retry below
 * and the between-candidate revert in `fixUntilVerified`, so there is exactly
 * one place that decides what a "clean tree" excludes — reusing the same
 * `runner.revertChanges` mechanism `cleanRetries` already added rather than a
 * second revert path.
 */
async function revertTaskChanges(
  cwd: string,
  alreadyChanged: ReadonlySet<string>,
  lockedPaths: readonly string[],
): Promise<void> {
  const nowChanged = new Set(await runner.changedFiles(cwd));
  const toRevert = [...nowChanged].filter((f) => !alreadyChanged.has(f) && !lockedPaths.includes(f));
  await runner.revertChanges(cwd, toRevert);
}

/**
 * A cheap, fail-safe read of whether a failed attempt is a near miss or a
 * sign the current approach/model can't do this.
 *
 * Modelled on repl.ts's own route classifier: no tools, capped turns and
 * budget, cheapest tier. Every way this can go wrong — the stage throws, hits
 * its turn or budget cap, or answers something that doesn't parse — falls
 * back to `nearMiss`, today's exact behaviour, so a judge failure can never
 * block, slow, or change the outcome beyond this one extra cheap call. Never
 * retried: one call, whatever it answers.
 */
async function judgeEscalation(
  rootCause: string,
  output: string,
  previous: failures.Failure[],
  ctx: FixContext,
): Promise<'nearMiss' | 'capabilityFailure'> {
  const table = failures.toPrompt(failures.parse(output), previous);
  try {
    const result = await runStage(
      ctx.engine,
      {
        name: 'judge',
        prompt: ESCALATION_JUDGE_STAGE(rootCause, table === '' ? output : table),
        rung: { tier: 'small' },
        capabilities: [],
        cwd: ctx.cwd,
        maxTurns: 3,
        maxBudgetUsd: 0.02,
        outputSchema: jsonSchema(EscalationVerdict),
      },
      ctx.ledger,
    );
    return parseSchema(EscalationVerdict, result.output)?.verdict ?? 'nearMiss';
  } catch {
    return 'nearMiss';
  }
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
  alreadyChanged: ReadonlySet<string>,
  reproTestFile: string | null,
  rung: Rung,
  ctx: FixContext,
): Promise<FixOutcome> {
  let ladder = startAt(rung);
  let extra = [...notes];
  let attempt = 0;
  let previous: failures.Failure[] = [];

  // Sampling needs a precise, harness-confirmed signal to score a candidate
  // against — without a repro test, "did this work" has no answer sharper
  // than the whole suite, and trying two independent guesses against that
  // would just pay twice to ask the one all-or-nothing question the ladder
  // already asks once.
  const sampleCandidates = reproTestFile !== null && features.get().candidateSampling;

  for (;;) {
    const current = rungAt(ladder.rung);
    const fix = await runFixAttempt(rootCause, extra, current, attempt, lockedPaths, ctx);
    ctx.state.write('fix.md', fix.output);
    let outcome = await verify(ctx, preExisting, lockedPaths);

    // A second, independent candidate at the SAME rung — not a retry armed
    // with the first candidate's failure. That kind of feedback is what the
    // ladder's own retry already provides one rung later; giving it here too
    // would blur what each mechanism is measuring, so candidate 2 gets the
    // identical rootCause/extra candidate 1 got. Reusing verify() for both is
    // what keeps "did a candidate work" a single definition rather than two
    // that can quietly drift apart — it already encodes the exact rule this
    // needs (the repro test passes, and no new failure was introduced) via
    // `lockedPaths`, since `reproTestFile` is folded into it above.
    if (sampleCandidates && !(outcome.kind === 'fixed' && outcome.verified)) {
      process.stdout.write(
        pc.dim('  first candidate did not resolve it — trying a second, independent candidate\n'),
      );
      ctx.ledger.noteCandidate();

      // Candidate 2 has to start from exactly what candidate 1 started from,
      // not from whatever candidate 1 left behind, or it is candidate 1 with
      // more edits on top rather than an independent attempt. Unconditional,
      // unlike the cleanRetries-gated revert below: that one is an
      // optimisation between ladder retries, and this one is what makes "two
      // candidates" mean two candidates at all.
      await revertTaskChanges(ctx.cwd, alreadyChanged, lockedPaths);

      const second = await runFixAttempt(rootCause, extra, current, attempt, lockedPaths, ctx);
      ctx.state.write('fix.md', second.output);
      outcome = await verify(ctx, preExisting, lockedPaths);
    }

    if (outcome.kind === 'fixed' && outcome.verified) return outcome;

    // Without a way to run tests there is nothing to escalate on; saying the
    // change is unverified is more honest than retrying against no evidence.
    if (!ctx.testCommand) return outcome;

    // A cheap second opinion on whether this specific failure is worth a
    // same-rung retry at all, before paying for one. Entirely optional to the
    // ladder below: omitted, `afterFailure` behaves exactly as it did before
    // this existed.
    const verdict =
      features.get().escalationJudge && ctx.testCommand
        ? await judgeEscalation(rootCause, ctx.state.read('verify.txt') ?? '', previous, ctx)
        : undefined;

    // One rung, one call to the ladder — whether this attempt tried one
    // candidate or two. Sampling changes what happens above this line, never
    // how many attempts the ladder's own retry budget sees; two candidates
    // that both fail are one failed attempt, exactly as a single failed fix
    // is today.
    const step = afterFailure(ladder, verdict);
    if (step.kind === 'giveUp') {
      await reportGiveUp(step.why, ctx);
      return { kind: 'stopped', why: step.why };
    }

    process.stdout.write(pc.yellow(`  ${step.why}\n`));
    if (step.state.rung !== ladder.rung) ctx.ledger.noteEscalation();
    ladder = step.state;
    attempt += 1;

    // The failing output is the whole point of another attempt — but as a table
    // of assertions, not as the log it arrived in. When two candidates ran,
    // `verify.txt` holds the second (most recent) one's output, matching the
    // existing "previous attempt" pattern below.
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

    // The next prompt describes a clean task, but the disk still holds
    // whatever the failed attempt wrote — revert exactly that, so the next
    // attempt actually starts from the tree the prompt claims it does.
    if (features.get().cleanRetries) {
      await revertTaskChanges(ctx.cwd, alreadyChanged, lockedPaths);
    }
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
  | { kind: 'stopped'; why: string; at?: 'gate' }
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
    if (decision.kind === 'rejected') {
      // A revision that produced nothing auto-rejects with an empty artifact —
      // that is not a proposal worth re-showing, so it does not count as a gate
      // stop even though the rejection came from this same gate.
      return {
        kind: 'stopped',
        why: 'you stopped it',
        ...(cause.prompt.trim().length > 0 ? { at: 'gate' as const } : {}),
      };
    }

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
      return { kind: 'stopped', why: rescopeHint('this bug'), at: 'gate' };
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
    ctx.state.write('rootcause.display.md', cause.display);
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

/**
 * Applies the same checks `buildGate` applies to every model-proposed write.
 *
 * A repro test's content reaches disk directly from a schema field — there is
 * no Edit or Write tool call in between for the gate to intercept — so this is
 * the one write path in the harness that isn't screened by `buildGate` at
 * all, and it has to run the identical checks itself or it would be the one
 * write path with none of them. Reuses gate-tools.ts's own `isInside`,
 * `isCredentialPath` and `findSecret` rather than re-implementing their
 * regexes, so the two can never quietly drift apart.
 */
function screenReproTest(file: string, content: string, cwd: string): string | null {
  if (!isInside(cwd, file)) return `${file} is outside the working directory`;
  if (isCredentialPath(file)) return `${file} looks like a credential file`;
  const secret = findSecret(content);
  if (secret) return `looks like it contains ${secret.label}`;
  return null;
}

/**
 * Writes a proposed reproduction test, only with explicit consent, and only
 * once the harness has confirmed it actually fails — a repro that doesn't
 * reproduce is worse than none, the same principle `feature.ts`'s
 * `proveFailing` applies to a newly-written test.
 *
 * Every way this can fail to produce a usable file — refused by the screen,
 * declined, no way to run it, or it simply doesn't fail — degrades to "no
 * repro test", exactly as if the evidence stage had proposed none. It must
 * never stop the task, the same precedent the shell repro command already
 * sets.
 *
 * A file that doesn't reproduce is left on disk rather than deleted: it is
 * real content the operator already approved writing, and it may still be a
 * valid test — it just isn't evidence of this bug. Deleting content a stage
 * (or here, the harness) wrote is not something this codebase does elsewhere;
 * `feature.ts`'s own `proveFailing` stops the task on a green suite rather
 * than removing the tests that failed to prove it.
 */
async function maybeWriteReproTest(
  proposed: { file: string; content: string },
  ctx: FixContext,
): Promise<string | null> {
  const raw = proposed.file.trim();
  if (raw.length === 0) return null;

  // Normalised to cwd-relative so it matches the form `failures.testFiles`
  // and `lockedPaths` already use, whether the model gave a relative path or
  // one that is absolute-beneath-cwd — both are valid per the system prompt.
  const abs = isAbsolute(raw) ? raw : resolve(ctx.cwd, raw);
  const file = relative(ctx.cwd, abs);

  const refusal = screenReproTest(file, proposed.content, ctx.cwd);
  if (refusal) {
    process.stdout.write(pc.yellow(`  repro test refused — ${refusal}\n`));
    return null;
  }

  const decision = await askApproval(
    ctx.input,
    {
      title: 'Write this test to reproduce it?',
      ...(ctx.steer ? { steer: ctx.steer } : {}),
      body: `${file}\n\n${proposed.content}`,
    },
    ctx.isTty,
    ctx.autoApprove,
  );

  if (decision.kind !== 'approved') {
    process.stdout.write(pc.dim('  skipped\n'));
    return null;
  }

  if (!ctx.testCommand) {
    process.stdout.write(pc.yellow('  no test command — cannot confirm it fails, skipping\n'));
    return null;
  }

  mkdirSync(dirname(resolve(ctx.cwd, file)), { recursive: true });
  writeFileSync(resolve(ctx.cwd, file), proposed.content, 'utf8');

  process.stdout.write(pc.dim(`  running ${ctx.testCommand} — expecting the new test to fail\n`));
  const outcome = await runner.runTests(ctx.testCommand, ctx.cwd);
  const failing = failures.testFiles(failures.parse(outcome.output));

  if (outcome.passed || !failing.includes(file)) {
    process.stdout.write(pc.yellow('  the proposed test did not fail — discarding it as a repro\n'));
    return null;
  }

  process.stdout.write(pc.green(`  confirmed failing: ${file}\n`));
  return file;
}

/** Runs the tests and reports whether the fix actually worked. */
async function verify(
  ctx: FixContext,
  preExisting: string | null,
  lockedPaths: readonly string[],
): Promise<FixOutcome> {
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

  // A suite that was already red stays red — but only outside the files this
  // fix is actually about. `lockedPaths` is the bug's own test, when it has
  // one: if the bug already had a failing regression test, that failure is
  // ALSO "pre-existing" by this same before/after diff, and forgiving it here
  // would let a fix that touched nothing report itself verified. Only a
  // failure outside a locked file is the unrelated noise this check exists to
  // excuse; a failure inside one is the thing the fix was for.
  const locked = new Set(lockedPaths);
  const stillFailing = failures.testFiles(failures.parse(outcome.output));
  const touchesLockedFile = stillFailing.some((file) => locked.has(file));

  // "No new failures" is only a signal when `preExisting` actually named at
  // least one — a suite whose failure text matches no known format (a bare
  // "still broken", say) diffs as empty against anything, itself included, so
  // forgiveness would fire on every red run regardless of whether the suite
  // had genuinely improved. No recognised failure to compare against means no
  // basis for forgiving anything.
  const preExistingHadRecognisedFailure = preExisting !== null && runner.failureLines(preExisting).size > 0;

  if (
    preExistingHadRecognisedFailure &&
    !touchesLockedFile &&
    runner.newFailures(preExisting, outcome.output).length === 0
  ) {
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
