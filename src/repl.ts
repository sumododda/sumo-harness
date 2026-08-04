/**
 * The interactive harness. `sumo` with no arguments lands here.
 *
 * You type normally; the harness picks the mode and the model for each turn.
 * Slash commands pin a mode when you want to override that choice.
 */

import { basename } from 'node:path';
import { createInterface } from 'node:readline/promises';
import pc from 'picocolors';
import * as cache from './cache.ts';
import { Conversation } from './conversation.ts';
import { getEngine } from './engine/index.ts';
import { hash, invalidate, repoFingerprint } from './hash.ts';
import { routeLocally } from './route/local.ts';
import {
  CLASSIFY_PROMPT,
  CLASSIFY_SCHEMA,
  classify,
  type Intent,
  intentFromClassifier,
  type Mode,
  shellRequest,
} from './intent.ts';
import { Ledger } from './ledger.ts';
import { estimateTokens, loadProfile, PROFILE_PATH, remember } from './profile.ts';
import { CHAT_STAGE, DO_STAGE, PLAN_STAGE, RESEARCH_STAGE } from './prompts.ts';
import { Progress, roadmap } from './progress.ts';
import { shouldRetrieve } from './retrieval.ts';
import * as routingLog from './routing-log.ts';
import * as statusbar from './statusbar.ts';
import { Steering } from './steer.ts';
import { runStage } from './stage.ts';
import { type CodeContext, openContext, serverStatus } from './context/index.ts';
import { LineReader } from './input.ts';
import { detectTestCommand, run, storedTestCommand, storeTestCommand } from './runner.ts';
import { type ApprovedPlan, runFeature } from './workflows/feature.ts';
import { runFix } from './workflows/fix.ts';
import { runPlan } from './workflows/plan.ts';
import { findRepo, hideToolingFromGit, TaskState, type TaskProgress } from './state.ts';
import type { Plan, RootCause } from './schemas.ts';
import { rungAt, type Rung, SumoError } from './types.ts';
import * as ui from './ui.ts';

/**
 * What's needed to re-enter a stopped task's approval gate directly: the
 * saved artifact, in the shape `gateRootCause`/`gatePlan` already take.
 *
 * `value` is always null on a resumed artifact — the file on disk is the
 * TOON `prompt` form, not the model's raw JSON, and the gate never reads
 * `.value` for its own decision. See `Shown` in ui.ts.
 */
type GateResume =
  | { readonly mode: 'fix'; readonly rootCause: ui.Shown<RootCause> }
  | { readonly mode: 'feature'; readonly plan: ui.Shown<Plan>; readonly tests: number };

/** Rebuilds a stopped task's gate artifact from disk, or null when it is incomplete. */
function gateResumeFrom(state: TaskState, progress: TaskProgress): GateResume | null {
  if (progress.mode === 'fix') {
    const prompt = state.read('rootcause.md');
    const display = state.read('rootcause.display.md');
    if (prompt === null || display === null) return null;
    return { mode: 'fix', rootCause: { value: null, prompt, display } };
  }
  if (progress.mode === 'feature') {
    const prompt = state.read('plan.md');
    const display = state.read('plan.display.md');
    const testsRaw = state.read('plan.tests.txt');
    const tests = testsRaw === null ? Number.NaN : Number.parseInt(testsRaw, 10);
    if (prompt === null || display === null || Number.isNaN(tests)) return null;
    return { mode: 'feature', plan: { value: null, prompt, display }, tests };
  }
  return null;
}

interface ReplState {
  /** A pinned mode, or 'auto' to let the harness choose per turn. */
  mode: Mode | 'auto';
  /** A pinned rung, or null to let the harness choose. */
  rung: Rung | null;
  /**
   * The last thing asked for, so a misroute can be corrected without retyping.
   *
   * Correcting one used to mean typing the whole request again under an explicit
   * mode — so the operator paid for the wrong turn, then paid to restate the
   * same sentence. The text is already known; only the mode was wrong.
   */
  lastRequest: string | null;
}

export async function repl(providerName?: string): Promise<number> {
  const repo = findRepo();
  // Do this before /index can create one, not only when a task starts.
  hideToolingFromGit(repo);
  const engine = getEngine(providerName);
  const ledger = new Ledger();
  const conversation = new Conversation();
  const state: ReplState = { mode: 'auto', rung: null, lastRequest: null };
  // A remembered answer wins: the user has already corrected us once.
  let testCommand = storedTestCommand(repo.root) ?? detectTestCommand(repo.root);

  // Opening the index is deterministic and free. `allowInit` stays off: building
  // one writes to the user's repo, so that stays an explicit `/index` request.
  let code = await openContext(repo.root);

  process.stdout.write(ui.banner(repo.root, engine.name, code.ready));

  // Printed in the flow, below whatever a stage last wrote, and taken back the
  // moment anything else needs the line. See src/statusbar.ts.
  // Both halves matter: the region needs a terminal to draw on, and the line
  // editor needs one to read keystrokes from. A piped stdin has neither.
  //
  // `isTTY` is declared `boolean` but is `undefined` — not `false` — on a pipe,
  // so the coercion is load-bearing however redundant the types make it look.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion
  const live = statusbar.enable(basename(repo.root)) && Boolean(process.stdin.isTTY);

  // With a live region, readline gets no `output`: it runs the line editor but
  // draws nothing, and the region draws the buffer where it cannot collide with
  // a streaming stage. Without one — a pipe, or `SUMO_NO_BAR=1` — readline
  // echoes as it always has.
  const rl = createInterface({
    input: process.stdin,
    ...(live ? { terminal: true } : { output: process.stdout }),
  });
  const input = new LineReader(rl, live);

  // Every read goes through `ask`, including the ones inside approval gates —
  // see src/input.ts for why sharing one path is required, not merely tidy.
  // `code` is re-assignable, so deps reads it through a getter rather than
  // capturing a stale value when /index or /lsp swaps the backend.
  const deps: TurnDeps = {
    engine, repo, ledger, conversation, state, input,
    get testCommand() {
      return testCommand;
    },
    get code() {
      return code;
    },
  };

  /**
   * Runs a turn with the input line still open.
   *
   * This is what makes a running task addressable. Nothing reads the keyboard
   * while a stage works, so anything typed is queued — but it also has to be
   * drawn somewhere, and the live region is the only place that survives a
   * stage streaming into the same terminal.
   */
  const working = async (run: () => Promise<void>): Promise<void> => {
    input.openSteering();
    try {
      await run();
    } finally {
      input.closeInput();
      statusbar.idle();
    }
  };

  try {
    for (;;) {
      statusbar.idle();

      process.stdout.write(ui.openTurn());
      const raw = await input.ask(ui.PROMPT);
      if (raw === null) break;
      input.closeInput();
      process.stdout.write(ui.closeTurn());

      const line = raw.trim();
      if (line.length === 0) continue;

      // Typed without a slash, these plainly mean leave — routing them to a
      // classifier would charge for the privilege of misunderstanding.
      if (/^(exit|quit|q|bye)$/i.test(line)) break;

      if (line.startsWith('/')) {
        // Commands that rebuild the context are handled here, where `code` lives.
        const rebuilt = await handleContextCommand(line, repo.root, code);
        if (rebuilt !== null) {
          code = rebuilt;
          continue;
        }

        const outcome = handleCommand(line, state, ledger, conversation, deps);
        if (outcome === 'exit') break;
        // `/fix the cart bug` pins the mode and runs it in one go.
        if (typeof outcome === 'object') {
          if ('setTestCommand' in outcome) testCommand = outcome.setTestCommand;
          else if ('runShell' in outcome) await runUserCommand(outcome.runShell, repo.root);
          else if ('resumeGate' in outcome) await working(() => handleResumeGate(outcome.resumeGate, deps));
          else await working(() => handleTurn(outcome.run, deps));
        }
        continue;
      }

      await working(() => handleTurn(line, deps));
    }
  } finally {
    // Hand the terminal back before anything else prints.
    statusbar.disable();
    rl.close();
    await code.dispose();
  }

  if (ledger.entries.length > 0) {
    process.stdout.write(`\n${ledger.render()}\n`);
  }
  return 0;
}

interface TurnDeps {
  readonly engine: ReturnType<typeof getEngine>;
  readonly repo: ReturnType<typeof findRepo>;
  readonly ledger: Ledger;
  readonly conversation: Conversation;
  readonly state: ReplState;
  readonly input: LineReader;
  /** How to run this project's tests, or null when none was detected. */
  readonly testCommand: string | null;
  /** The repo's code index; answers questions without spending tokens. */
  readonly code: CodeContext;
}

async function handleTurn(input: string, deps: TurnDeps): Promise<void> {
  const { engine, repo, ledger, conversation } = deps;

  // The tree may have moved since the last turn — by a previous stage, or by the
  // user in another window. Everything reused below is keyed on its content, so
  // this is where that content is re-read.
  invalidate(repo.root);

  // Shell work is not coding work. Saying so costs nothing; routing it to a
  // model buys a paid refusal, since stages deliberately have no shell.
  const shell = shellRequest(input);
  if (shell && !shell.git) {
    // Non-git shell work has no home here, and saying so costs nothing.
    process.stdout.write(
      pc.dim('  shell work — sumo edits code, it does not drive your terminal\n') +
        pc.dim('  run it in your shell, then ask me about the code\n\n'),
    );
    return;
  }

  deps.state.lastRequest = input;

  const intent = await decideIntent(input, deps);
  process.stdout.write(`${ui.modeLine(intent.mode, intent.rung, intent.why, intent.by)}\n`);

  // Recorded before the turn runs, so a route is on the record whether or not
  // the work that followed it succeeded — a turn that was routed wrongly and
  // then abandoned is exactly the one worth having written down.
  routingLog.record(repo.root, {
    text: input,
    mode: intent.mode,
    why: intent.why,
    by: intent.by,
  });

  conversation.add('user', input);
  const context = conversation.contextBlock();

  // These are staged workflows with approval gates, not single stages.
  if (intent.mode === 'fix' || intent.mode === 'feature' || intent.mode === 'plan') {
    await runWorkflowTurn(intent.mode, input, intent.rung, context, deps);
    return;
  }

  // Ask the index first. What it returns costs nothing and usually spares the
  // model several rounds of reading its way to the same files.
  const pack = await packFor(deps, input, intent);
  const spec = specFor(intent.mode, input, contextWithPack(context, pack), repo.root);

  try {
    const before = ledger.totalUsd;
    const mark = ledger.mark();
    const result = await runStage(
      engine,
      {
        ...spec,
        rung: intent.rung,
        onEvent: ui.renderEvent,
        packChars: pack.length,
        ...(pack ? { indexed: true } : {}),
      },
      ledger,
    );

    // Live streaming already printed the text; just close the block.
    ui.endTurn();
    process.stdout.write(`${ui.cost(ledger.totalUsd - before)}\n\n`);

    conversation.add('sumo', result.output);
    if (spec.allowWrites && result.output.length > 0) {
      conversation.note(`${intent.mode}: ${firstLine(result.output)}`);
      new TaskState(repo, TaskState.newId(intent.mode)).write('output.md', result.output);
    }

    // A single-stage turn has nothing to verify, but its tokens still count
    // towards what a session costs.
    ledger.finish(repo.root, mark, { mode: intent.mode, task: input, verified: false });
  } catch (cause) {
    if (cause instanceof SumoError) {
      process.stdout.write(`${ui.error(cause.message, cause.suggestions)}\n\n`);
    } else {
      throw cause;
    }
  }
}

/**
 * Picks a task back up at exactly the gate it stopped at.
 *
 * No intent to decide — the mode is already known, it is the one the task
 * stopped in — so this skips straight to `runWorkflowTurn` rather than going
 * through `handleTurn`'s classification.
 */
async function handleResumeGate(
  resume: { readonly state: TaskState; readonly task: string; readonly gate: GateResume },
  deps: TurnDeps,
): Promise<void> {
  deps.state.lastRequest = resume.task;
  deps.conversation.add('user', resume.task);
  const rung = deps.state.rung ?? rungAt(1);
  await runWorkflowTurn(resume.gate.mode, resume.task, rung, deps.conversation.contextBlock(), deps, resume);
}

/**
 * Handles the commands that replace the context backend. Returns the new
 * context, or null when the line was not one of these.
 */
async function handleContextCommand(
  line: string,
  root: string,
  current: CodeContext,
): Promise<CodeContext | null> {
  const [command = '', arg = ''] = line.slice(1).trim().split(/\s+/);

  if (command.toLowerCase() === 'index') {
    process.stdout.write(pc.dim('  indexing…\n'));
    await current.dispose();
    // Only an explicit request may write an index into the user's repo.
    const built = await openContext(root, { allowInit: true });
    process.stdout.write(
      built.ready
        ? pc.green('  index ready\n\n')
        : pc.yellow('  could not index this repo — falling back to reading files\n\n'),
    );
    return built;
  }

  if (command.toLowerCase() === 'lsp') {
    const on = arg.toLowerCase() !== 'off';
    const servers = serverStatus();

    // Nothing is installed automatically, so say plainly what is available and
    // what to run for the rest — a silently inert /lsp is worse than none.
    for (const server of servers) {
      process.stdout.write(
        server.installed
          ? pc.green(`  ✓ ${server.label}\n`)
          : pc.dim(`  · ${server.label} — not installed: ${server.install}\n`),
      );
    }

    if (on && !servers.some((s) => s.installed)) {
      process.stdout.write(
        pc.yellow('  no language servers found; the index still answers everything\n\n'),
      );
      return current;
    }

    await current.dispose();
    const next = await openContext(root, { lsp: on });
    process.stdout.write(
      pc.dim(`  precise references ${on ? 'on' : 'off'}${next.ready ? '' : ' (no index)'}\n\n`),
    );
    return next;
  }

  return null;
}

/**
 * Runs a command the user typed themselves. No model is involved, so this is
 * exactly as trusted as their own shell — and costs nothing.
 */
async function runUserCommand(command: string, cwd: string): Promise<void> {
  const result = await run(command, cwd);
  const text = result.output.trim();
  if (text.length > 0) process.stdout.write(`${text}\n`);
  if (!result.ok) process.stdout.write(pc.yellow(`  exit ${result.code ?? '?'}\n`));
  process.stdout.write('\n');
}

/** Drives a staged workflow and reports how it ended. */
async function runWorkflowTurn(
  mode: 'fix' | 'feature' | 'plan',
  task: string,
  rung: Rung,
  context: string,
  deps: TurnDeps,
  /**
   * Set by `/resume` when the previous attempt stopped exactly at its approval
   * gate: continues in that task's own directory and re-enters the gate
   * directly, rather than starting a new task from evidence/explore.
   */
  resume?: { readonly state: TaskState; readonly gate: GateResume },
): Promise<void> {
  const { engine, repo, ledger, conversation, input, testCommand } = deps;
  const before = ledger.totalUsd;
  // The session ledger spans every turn, so this task is a range within it.
  const mark = ledger.mark();
  const state = resume?.state ?? new TaskState(repo, TaskState.newId(mode));
  state.saveProgress({ mode, task, stage: resume ? 'resumed' : 'started', finished: false });

  // Collects anything typed while this task runs. Nothing is read from the
  // keyboard until a gate asks, so without this those lines would sit in the
  // queue and the next gate would answer itself with one of them.
  const steer = new Steering(input);

  // The route, once, before anything runs. A staged workflow has a fixed shape
  // and there is no reason to make someone infer it from a stream of tool calls.
  process.stdout.write(roadmap(mode));
  const progress = new Progress(mode);

  const ctx = {
    engine,
    ledger,
    state,
    cwd: repo.root,
    input,
    steer,
    progress,
    // A REPL session always has an input stream to answer with, whether that
    // is a keyboard or a pipe.
    isTty: true,
    autoApprove: process.env['SUMO_YES'] === '1',
    testCommand,
  };

  try {
    // Nothing above the gate needs the index's answer a second time.
    const pack = resume ? '' : await packFor(deps, task, { mode, rung });
    // Deliberately not `contextWithPack`: see packBlock.
    const withPack = packBlock(pack);
    const staged = { ...ctx, indexed: pack.length > 0, packChars: pack.length };

    let approved: ApprovedPlan | undefined;

    if (mode === 'plan') {
      const planned = await runPlan(task, rung, staged, withPack);
      conversation.add('sumo', planned.plan);
      if (planned.kind === 'planned') {
        // Declining to build is a finished plan, not an interrupted one —
        // otherwise /resume would offer to redo work that is already done.
        state.saveProgress({ mode, task, stage: 'planned', finished: true });
        ledger.finish(repo.root, mark, { mode, task, verified: false });
        process.stdout.write(`${ui.cost(ledger.totalUsd - before)}\n\n`);
        return;
      }
      // Approved: build exactly what was agreed to, rather than planning it
      // again and asking again.
      approved = { plan: planned.plan, findings: planned.findings, tests: planned.tests };
      process.stdout.write(pc.dim('  building it\n'));
    }

    const outcome =
      mode === 'fix'
        ? await runFix(
            task,
            rung,
            staged,
            withPack,
            resume && resume.gate.mode === 'fix' ? { rootCause: resume.gate.rootCause } : undefined,
          )
        : await runFeature(
            task,
            rung,
            staged,
            withPack,
            approved,
            resume && resume.gate.mode === 'feature'
              ? { plan: resume.gate.plan, tests: resume.gate.tests }
              : undefined,
          );

    // handleTurn already recorded the user's message.
    if (outcome.kind === 'stopped') {
      process.stdout.write(pc.yellow(`  stopped — ${outcome.why}\n`));
      conversation.add('sumo', `${mode} stopped: ${outcome.why}`);
    } else {
      const verified = outcome.verified ? 'verified by tests' : 'applied but unverified';
      conversation.note(`${mode} ${verified}: ${task}`);
      conversation.add('sumo', `${mode} ${verified}`);
    }

    // One line per task, so cost per *verified* task can be read back later
    // rather than reconstructed from memory.
    ledger.finish(repo.root, mark, {
      mode,
      task,
      verified: outcome.kind !== 'stopped' && outcome.verified,
      ...(outcome.kind === 'stopped' ? { stopped: outcome.why } : {}),
    });

    state.saveProgress({
      mode,
      task,
      stage: outcome.kind === 'stopped' ? 'stopped' : 'verified',
      branch: 'branch' in outcome ? outcome.branch : null,
      // A task that stopped did not finish. This was recorded as finished
      // either way, so `/resume` would show a rejected plan and then decline to
      // pick it up — and rejecting a plan is precisely when you want to go
      // again with different framing. The request was then only recoverable by
      // retyping it.
      //
      // Declining to *build* in `plan` mode is different and stays finished:
      // there the plan was the deliverable, and it was delivered.
      finished: outcome.kind !== 'stopped',
      ...(outcome.kind === 'stopped' ? { note: outcome.why } : {}),
      // Set only for the exact stop this brief exists to shortcut: rejected at
      // the gate, or the revision limit hit there. The saved artifact this
      // points at is written by the workflow itself, beside its usual output.
      ...(outcome.kind === 'stopped' && outcome.at === 'gate' ? { resumable: 'gate' as const } : {}),
    });

    if (steer.applied.length > 0) {
      // What you said mid-task changed the work, so it belongs in the summary
      // rather than only in the scrollback.
      process.stdout.write(
        pc.dim(`  steered by: ${steer.applied.map((s) => `"${s}"`).join(', ')}\n`),
      );
    }

    if ('branch' in outcome && outcome.branch) {
      process.stdout.write(pc.dim(`  on branch ${pc.cyan(outcome.branch)}\n`));
    }
    process.stdout.write(`${ui.cost(ledger.totalUsd - before)}\n`);
    process.stderr.write(pc.dim(`  artifacts: ${state.dir}\n\n`));
  } catch (cause) {
    if (cause instanceof SumoError) {
      process.stdout.write(`${ui.error(cause.message, cause.suggestions)}\n\n`);
    } else {
      throw cause;
    }
  }
}

/** Rules first; one cheap classification only when they cannot decide. */
async function decideIntent(input: string, deps: TurnDeps): Promise<Intent> {
  const { engine, repo, ledger, state } = deps;

  const sticky = state.mode === 'auto' ? undefined : state.mode;
  const ruled = classify(input, sticky);
  if (ruled) return state.rung ? { ...ruled, rung: state.rung, why: 'pinned' } : ruled;

  // The rules had no answer. Before paying for one, ask the local model — an
  // embedding table on disk, no network and no provider call. It answers only
  // when one mode is clearly ahead of the rest and otherwise says nothing, so
  // the paid classifier below still handles everything genuinely ambiguous.
  if (!sticky) {
    const local = routeLocally(input);
    if (local) {
      const intent = intentFromClassifier(local.label, local.complexity, 'local');
      return state.rung ? { ...intent, rung: state.rung, why: 'pinned' } : intent;
    }
  }

  // Ambiguous even to the model. One turn, no tools, cheapest model.
  try {
    const result = await runStage(
      engine,
      {
        name: 'route',
        prompt: CLASSIFY_PROMPT(input),
        rung: rungAt(0),
        capabilities: [],
        cwd: repo.root,
        // Headroom: the model sometimes emits a sentence before the structured
        // answer, and a router that runs out of turns costs money for nothing.
        maxTurns: 3,
        maxBudgetUsd: 0.02,
        outputSchema: CLASSIFY_SCHEMA,
      },
      ledger,
    );
    const parsed = JSON.parse(result.output) as { mode: Mode; complexity: string };
    const intent = intentFromClassifier(parsed.mode, parsed.complexity);
    return state.rung ? { ...intent, rung: state.rung, why: 'pinned' } : intent;
  } catch {
    // A failed classification must never block the turn.
    // The classifier failed outright. Say so rather than dressing it as a
    // decision — an unroutable turn is worth spotting in the log.
    return { mode: 'chat', rung: state.rung ?? rungAt(0), why: 'nothing matched', by: 'default' };
  }
}

/** Maps a mode to the stage that implements it. */
function specFor(mode: Mode, input: string, context: string, cwd: string) {
  const base = { cwd, rung: rungAt(0), maxTurns: 24 };

  switch (mode) {
    case 'do':
      return {
        ...base,
        name: 'do',
        prompt: DO_STAGE(input, context),
        // `git` is a narrow, screened tool — branch and history only. See
        // src/git-tool.ts for exactly what it refuses.
        capabilities: ['read', 'search', 'edit', 'git'] as const,
        allowWrites: true,
      };
    case 'plan':
    case 'feature':
    case 'fix':
      // Until the staged workflows land, these investigate and propose without
      // touching anything — never silently downgraded to a blind edit.
      return {
        ...base,
        name: mode,
        prompt: PLAN_STAGE(input, context),
        capabilities: ['read', 'search'] as const,
        allowWrites: false,
      };
    case 'chat':
      return {
        ...base,
        name: 'chat',
        prompt: CHAT_STAGE(input, context),
        capabilities: ['read', 'search'] as const,
        allowWrites: false,
      };
    case 'research':
      return {
        ...base,
        name: 'research',
        prompt: RESEARCH_STAGE(input, context),
        // `read` and `search` stay: a question about a library is usually also
        // a question about how this repo already uses it.
        capabilities: ['read', 'search', 'web'] as const,
        allowWrites: false,
      };
  }
}

/**
 * Handles a slash command. Returns 'exit' to end the session, or `{run}` when
 * the command carried a task to execute immediately.
 */
type CommandOutcome =
  | 'exit'
  | 'handled'
  | { readonly run: string }
  | { readonly setTestCommand: string }
  | { readonly runShell: string }
  | {
      readonly resumeGate: { readonly state: TaskState; readonly task: string; readonly gate: GateResume };
    };

function handleCommand(
  line: string,
  state: ReplState,
  ledger: Ledger,
  conversation: Conversation,
  deps: TurnDeps,
): CommandOutcome {
  const [command = '', ...rest] = line.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim();

  switch (command.toLowerCase()) {
    case 'exit':
    case 'quit':
    case 'q':
      return 'exit';

    case 'help':
    case '?':
      process.stdout.write(`${ui.HELP}\n`);
      return 'handled';

    case 'chat':
    case 'do':
    case 'fix':
    case 'feature':
    case 'plan':
    case 'research':
      state.mode = command.toLowerCase() as Mode;
      if (arg.length > 0) return { run: arg };
      process.stdout.write(pc.dim(`  mode pinned to ${state.mode}\n\n`));
      return 'handled';

    case 'auto':
      state.mode = 'auto';
      process.stdout.write(pc.dim('  routing automatically\n\n'));
      return 'handled';

    case 'again': {
      // The mode is checked first: a bad one is a mistake in what was just
      // typed, and reporting the empty history ahead of it buried the actual
      // error behind an unrelated one.
      const wanted = arg.toLowerCase().replace(/^\//, '');
      if (!MODES.includes(wanted as Mode)) {
        process.stdout.write(
          `${ui.error(`"${arg}" is not a mode`, [`Use one of: ${MODES.join(', ')}`])}\n\n`,
        );
        return 'handled';
      }
      if (state.lastRequest === null) {
        process.stdout.write(
          `${ui.error('Nothing to re-run yet', ['Ask for something first, then /again <mode>'])}\n\n`,
        );
        return 'handled';
      }
      state.mode = wanted as Mode;
      process.stdout.write(pc.dim(`  again as ${wanted}: ${state.lastRequest}\n`));
      // Re-run verbatim. The routing log pairs it with the original and records
      // the correction, which is the only ground truth the harness ever gets
      // about a route it got wrong.
      return { run: state.lastRequest };
    }

    case 'rung': {
      if (arg.length === 0) {
        process.stdout.write(
          pc.dim(`  rung: ${state.rung ? describeRungSafe(state.rung) : 'automatic'}\n\n`),
        );
        return 'handled';
      }
      if (arg === 'auto') {
        state.rung = null;
        process.stdout.write(pc.dim('  rung: automatic\n\n'));
        return 'handled';
      }
      const n = Number.parseInt(arg, 10);
      if (Number.isNaN(n)) {
        process.stdout.write(`${ui.error(`"${arg}" is not a rung`, ['Use 0-4, or "auto".'])}\n\n`);
        return 'handled';
      }
      state.rung = rungAt(n);
      process.stdout.write(pc.dim(`  rung pinned to ${describeRungSafe(state.rung)}\n\n`));
      return 'handled';
    }

    case 'resume':
    case 'last': {
      const previous = TaskState.latest(deps.repo);
      const progress = previous?.loadProgress();
      if (!previous || !progress) {
        process.stdout.write(pc.dim('  no previous task in this repo\n\n'));
        return 'handled';
      }
      process.stdout.write(
        `  ${pc.bold(progress.mode)} — ${progress.task}\n` +
          pc.dim(`  ${progress.finished ? progress.stage : `interrupted at ${progress.stage}`}` +
            `${progress.branch ? ` · ${progress.branch}` : ''}\n`) +
          (progress.note ? pc.dim(`  ${progress.note}\n`) : '') +
          pc.dim(`  artifacts: ${previous.dir}\n\n`),
      );
      if (progress.finished) return 'handled';

      // It stopped exactly at its approval gate: re-show the same artifact for
      // a fresh decision instead of paying to reach the gate again. Falls
      // through to the full re-run below when the saved artifact is missing —
      // an older task directory, or one written before this existed.
      const gate = progress.resumable === 'gate' ? gateResumeFrom(previous, progress) : null;
      if (gate) {
        process.stdout.write(
          pc.dim(
            `  picking back up at the ${gate.mode === 'fix' ? 'root cause' : 'plan'} gate — nothing re-surveyed\n`,
          ),
        );
        return { resumeGate: { state: previous, task: progress.task, gate } };
      }

      // Re-running the task is the resume: stages are cheap to redo and the
      // artifacts are already on disk for reference.
      return { run: progress.task };
    }

    case 'git': {
      if (arg.length === 0) {
        process.stdout.write(`${ui.error('Nothing to run', ['/git status', '/git checkout main'])}\n\n`);
        return 'handled';
      }
      return { runShell: `git ${arg}` };
    }

    case 'tests':
    case 'test': {
      if (arg.length === 0) {
        process.stdout.write(
          deps.testCommand
            ? pc.dim(`  tests: ${deps.testCommand}\n\n`)
            : `${ui.error('No test command for this repo', ['/tests npm run check'])}\n\n`,
        );
        return 'handled';
      }
      storeTestCommand(deps.repo.root, arg);
      process.stdout.write(pc.green(`  tests: ${arg}\n`) + pc.dim('  remembered for this repo\n\n'));
      return { setTestCommand: arg };
    }

    case 'cost':
      process.stdout.write(`${ledger.render()}\n\n`);
      return 'handled';

    case 'routing':
      process.stdout.write(`${renderRouting(deps.repo.root)}\n\n`);
      return 'handled';

    case 'cache': {
      if (arg.toLowerCase() === 'clear') {
        const removed = cache.clear(deps.repo.root);
        process.stdout.write(pc.dim(`  cleared ${removed} cached ${plural(removed, 'answer')}\n\n`));
        return 'handled';
      }

      const { entries, bytes } = cache.stats(deps.repo.root);
      const { reads, hits } = cache.sessionStats();
      process.stdout.write(
        pc.dim(`  ${entries} cached ${plural(entries, 'answer')} · ${(bytes / 1024).toFixed(0)} KB\n`) +
          pc.dim(
            reads > 0
              ? `  this session: ${hits}/${reads} reused\n`
              : '  this session: nothing reused yet\n',
          ) +
          pc.dim('  /cache clear empties it\n\n'),
      );
      return 'handled';
    }

    case 'clear':
      conversation.clear();
      process.stdout.write(pc.dim('  conversation cleared\n\n'));
      return 'handled';

    case 'profile': {
      const text = loadProfile();
      process.stdout.write(`${text}\n${pc.dim(`\n${PROFILE_PATH} · ~${estimateTokens(text)} tokens`)}\n\n`);
      return 'handled';
    }

    case 'remember':
      if (arg.length === 0) {
        process.stdout.write(`${ui.error('Nothing to remember', ['/remember prefer const over let'])}\n\n`);
        return 'handled';
      }
      remember(arg);
      process.stdout.write(pc.green(`  remembered\n\n`));
      return 'handled';

    default:
      process.stdout.write(
        `${ui.error(`Unknown command /${command}`, ['/help lists everything'])}\n\n`,
      );
      return 'handled';
  }
}

/** Turns shown by `/routing`. Enough to see a pattern, few enough to scan. */
const RECENT_TURNS = 8;

/** One line of a request, short enough to sit in a column. */
function clip(text: string, width: number): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length <= width ? line : `${line.slice(0, width - 1)}…`;
}

/**
 * What the harness has been deciding, and how.
 *
 * The corrections line is the reason this exists. Everything else here is
 * arithmetic; that line is the harness reporting the routes it gets wrong, in
 * the operator's own words, which nothing else in the harness can tell anyone.
 */
function renderRouting(root: string): string {
  const records = routingLog.read(root);
  if (records.length === 0) {
    return pc.dim('  nothing routed yet — this fills up as you work');
  }

  const summary = routingLog.summarize(records);
  const share = (n: number) => `${Math.round((n / summary.turns) * 100)}%`;
  const lines = [`  ${pc.bold(String(summary.turns))} turns routed`];

  // Ordered by how much a decision is worth as evidence, not by frequency.
  for (const source of ['you', 'rules', 'classifier', 'default'] as const) {
    const count = summary.by[source];
    if (count > 0) {
      lines.push(pc.dim(`    ${source.padEnd(11)} ${String(count).padStart(4)}  ${share(count)}`));
    }
  }

  const modes = Object.entries(summary.modes)
    .sort(([, a], [, b]) => b - a)
    .map(([mode, count]) => `${mode} ${count}`)
    .join(' · ');
  lines.push(pc.dim(`  modes: ${modes}`));

  if (summary.corrections.length > 0) {
    const changes = summary.corrections.map((c) => `${c.change} (${c.count})`).join(', ');
    lines.push(pc.yellow(`  corrected: ${changes}`));
  } else {
    lines.push(pc.dim('  no corrections — re-run a turn with /fix or /do to record one'));
  }

  // The turns themselves, not just what they add up to. A count says routing is
  // 60% rules; only the rows say which request that was, and whether it was the
  // right call — which is the question anyone opening this actually has.
  const recent = records.slice(-RECENT_TURNS);
  if (recent.length > 0) {
    lines.push('');
    lines.push(pc.dim(`  last ${recent.length}`));
    const modeWidth = Math.max(...recent.map((r) => r.mode.length));
    const byWidth = Math.max(...recent.map((r) => r.by.length));
    for (const row of recent) {
      // Padded before colouring: an escape sequence occupies bytes but no
      // columns, so padding a coloured string skews every row that has one.
      const by = row.by.padEnd(byWidth);
      const decider = row.by === 'classifier' ? pc.yellow(by) : pc.dim(by);
      const corrected = row.was ? pc.yellow(` (was ${row.was})`) : '';
      lines.push(
        `    ${pc.bold(row.mode.padEnd(modeWidth))} ${decider}  ` +
          `${pc.dim(clip(row.text, 52))}${corrected}`,
      );
    }
  }

  lines.push('');
  lines.push(pc.dim(`  ${routingLog.path(root)}`));

  return lines.join('\n');
}

/** The modes `/again` accepts. Kept beside the command that validates against it. */
const MODES: readonly Mode[] = ['chat', 'do', 'fix', 'feature', 'plan', 'research'];

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

function describeRungSafe(rung: Rung): string {
  return rung.effort ? `${rung.tier}/${rung.effort}` : rung.tier;
}

/**
 * The index's answer for a question, memoised on the repository's content.
 *
 * Building a pack is deterministic given the code it was built from, so asking
 * the same question of an unchanged tree is work worth doing once — including
 * across sessions, which is why this lands on disk rather than in a Map.
 */
async function packFor(
  deps: TurnDeps,
  question: string,
  intent?: { readonly mode: Mode; readonly rung: Rung },
): Promise<string> {
  if (!deps.code.ready) return '';

  if (intent) {
    const decision = shouldRetrieve(intent.mode, intent.rung, question, deps.repo.root);
    if (!decision.retrieve) {
      // Say so rather than silently not doing it: a skipped lookup that turns
      // out to have been needed should be traceable to a visible decision.
      process.stdout.write(pc.dim(`  no index lookup — ${decision.why}\n`));
      return '';
    }
  }

  const fingerprint = await repoFingerprint(deps.repo.root);
  if (fingerprint === null) return await deps.code.pack(question);

  const { value } = await cache.memo(
    deps.repo.root,
    hash('pack', question, fingerprint),
    () => deps.code.pack(question),
  );
  return value;
}

/** Prepends the index's answer so the model starts with the relevant code. */
function contextWithPack(conversation: string, pack: string): string {
  if (!pack) return conversation;
  return `${conversation}${packBlock(pack)}`;
}

/**
 * The index's answer alone, without the conversation.
 *
 * Staged workflows are given this rather than the combined block. The pack is
 * derived from the task and the repository, so it repeats when they do; the
 * conversation does not, and mixing them made a survey stage's prompt different
 * on every attempt — which is why retrying a task never hit the cache.
 */
function packBlock(pack: string): string {
  if (!pack) return '';
  return `Relevant code, from this repository's index:\n${pack}\n\n`;
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.slice(0, 120) ?? '';
}
