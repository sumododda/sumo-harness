/**
 * `plan` — investigate and propose, without touching anything.
 *
 * Two read-only stages, then an offer to build it. Splitting exploration from
 * planning matters: a single stage that does both tends to propose whatever it
 * happened to read first, whereas here the plan is written against a finished
 * survey of what already exists.
 *
 * Nothing here can write. Building is a separate, explicit step.
 */

import pc from 'picocolors';
import type { Fleet } from '../engine/fleet.ts';
import { assembled } from '../context/budget.ts';
import {
  askApproval,
  type GateDecision,
  MAX_REVISIONS,
  producedNothing,
  rescopeHint,
} from '../gate.ts';
import type { LineReader } from '../input.ts';
import type { Ledger } from '../ledger.ts';
import { DISCUSS_STAGE, exploreParts, FEATURE_PLAN_STAGE } from '../prompts.ts';
import { repoFingerprint } from '../hash.ts';
import * as runner from '../runner.ts';
import { declaresNoTests, Explore, jsonSchema, Plan } from '../schemas.ts';
import { runStage } from '../stage.ts';
import type { Progress } from '../progress.ts';
import type { Steering } from '../steer.ts';
import { TaskState } from '../state.ts';
import type { Rung } from '../types.ts';
import * as ui from '../ui.ts';

export interface PlanContext {
  readonly fleet: Fleet;
  readonly ledger: Ledger;
  readonly state: TaskState;
  readonly cwd: string;
  readonly input: LineReader;
  readonly isTty: boolean;
  readonly autoApprove: boolean;
  readonly indexed?: boolean;
  /** How much of the first stage's prompt came from the index, for the ledger. */
  readonly packChars?: number;
  /** Anything typed while this task runs, folded into the next stage. */
  readonly steer?: Steering;
  /** Announces which leg of the route each stage is. */
  readonly progress?: Progress;
}

export type PlanOutcome =
  /**
   * The user wants this built.
   *
   * Carries what the approval was actually given for, not just the fact of it:
   * the plan, the findings it was written against, and how many tests it asks
   * for. The feature workflow needs all three, and re-deriving them would mean
   * exploring and planning a second time — and asking for the same approval
   * again, thirty seconds after it was given.
   */
  | {
      readonly kind: 'build';
      readonly plan: string;
      readonly findings: string;
      readonly tests: number;
    }
  | { readonly kind: 'planned'; readonly plan: string };

export async function runPlan(
  task: string,
  rung: Rung,
  ctx: PlanContext,
  /** The index's answer for this task. Stable, unlike the conversation. */
  packContext = '',
): Promise<PlanOutcome> {
  const { fleet, ledger, state, cwd } = ctx;

  // A survey of an unchanged repository for a task already surveyed is the same
  // survey. The stage cache normally covers this, but it is keyed on the exact
  // prompt and can be cleared — and the case that matters most is a task that
  // failed late and is being retried, which is exactly when paying to explore
  // again is most galling.
  const fingerprint = await repoFingerprint(cwd);
  const reusable =
    fingerprint === null ? null : TaskState.findArtifact(state.repo, task, fingerprint, 'explore.md');
  if (reusable !== null) {
    process.stdout.write(pc.dim('  reusing the survey from an earlier attempt\n'));
  }

  // 1. Survey what exists. Retrieval, so effort stays low whatever the rung.
  const explore = reusable !== null ? null : await runStage(
    fleet,
    {
      name: 'explore',
      ...assembled(exploreParts(task, await runner.repoFiles(cwd), packContext)),
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
  ui.endTurn();

  const found = explore === null ? null : ui.shownExplore(explore.output);
  const exploreText = found ? found.prompt : (reusable ?? '');
  state.write('explore.md', exploreText);
  if (fingerprint !== null) state.write('fingerprint.txt', fingerprint);
  if (found?.value) ui.renderArtifact(found.display);

  // 2. Plan against that survey. This is where thinking earns its cost.
  const planned = await runStage(
    fleet,
    {
      name: 'plan',
      prompt: FEATURE_PLAN_STAGE(task, exploreText),
      rung: { tier: rung.tier, effort: rung.tier === 'small' ? undefined : 'high' },
      capabilities: ['read', 'search'],
      cwd,
      ...(ctx.indexed ? { indexed: true } : {}),
      allowWrites: false,
      outputSchema: jsonSchema(Plan),
      ...(ctx.steer ? { steer: ctx.steer } : {}),
      ...(ctx.progress ? { progress: ctx.progress } : {}),
      onEvent: ui.renderEvent,
    },
    ledger,
  );
  ui.endTurn();

  const proposal = ui.shownPlan(planned.output);
  state.write('plan.md', proposal.prompt);
  if (proposal.prompt.trim().length === 0) {
    process.stdout.write(pc.yellow(`  ${producedNothing('plan', planned.stopped)}\n`));
    return { kind: 'planned', plan: '' };
  }

  // 3. Offer to build it. Answering no simply leaves you with the plan.
  const decision = await askApproval(
    ctx.input,
    // The plan answered in a schema, so nothing streamed; show it here.
    { title: 'Build this now?', ...(ctx.steer ? { steer: ctx.steer } : {}), body: proposal.display },
    ctx.isTty,
    ctx.autoApprove,
  );

  // The rendered findings, not the raw answer: a re-plan reads this, and the
  // stage now replies in a schema rather than in prose.
  return await settle(proposal, task, exploreText, rung, ctx, decision);
}

/**
 * Carries the plan through questions and revisions until it is accepted or
 * abandoned.
 *
 * Collapsing these into one outcome was a real cost: saying "I don't want to use
 * that library" is direction, and discarding it meant re-planning from nothing
 * on the next turn — paying full price twice for one conversation.
 */
async function settle(
  initial: ui.Shown<Plan>,
  task: string,
  findings: string,
  rung: Rung,
  ctx: PlanContext,
  first: GateDecision,
): Promise<PlanOutcome> {
  let plan = initial;
  let decision = first;
  let revisions = 0;
  // Every correction, in the order they were made. Passing only the newest one
  // let each revision undo the last — see feedbackBlock.
  const notes: string[] = [];
  // An unparseable plan is not a claim that no tests are needed, so it counts
  // as one rather than routing the task down the no-tests path by accident.
  const testCount = (p: ui.Shown<Plan>): number =>
    p.value ? (declaresNoTests(p.value) ? 0 : p.value.tests.length) : 1;

  for (;;) {
    if (decision.kind === 'approved') {
      return { kind: 'build', plan: plan.prompt, findings, tests: testCount(plan) };
    }

    if (decision.kind === 'rejected') {
      process.stdout.write(pc.dim(`  plan saved to ${ctx.state.dir}/plan.md\n`));
      return { kind: 'planned', plan: plan.prompt };
    }

    if (decision.kind === 'discuss') {
      // A question leaves the plan exactly as it was.
      await runStage(
        ctx.fleet,
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
    } else {
      if (revisions >= MAX_REVISIONS) {
        process.stdout.write(pc.yellow(`  ${rescopeHint('this plan')}\n`));
        return { kind: 'planned', plan: plan.prompt };
      }
      revisions += 1;
      notes.push(decision.feedback);

      // Re-plan against the same findings, so exploration is not paid for twice.
      const revised = await runStage(
        ctx.fleet,
        {
          name: 'plan',
          prompt: FEATURE_PLAN_STAGE(task, findings, notes),
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

      plan = ui.shownPlan(revised.output);
      ctx.state.write('plan.md', plan.prompt);
    }

    decision = await askApproval(
      ctx.input,
      {
        title: 'Build this now?',
        ...(ctx.steer ? { steer: ctx.steer } : {}),
        body: decision.kind === 'discuss' ? undefined : plan.display,
      },
      ctx.isTty,
      ctx.autoApprove,
    );
  }
}
