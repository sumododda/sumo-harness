/**
 * GitHub Copilot provider, built on the Copilot SDK.
 *
 * This is the only file allowed to import that SDK. Like the Claude engine it
 * sits behind {@link Engine}, so nothing above it learns that a second provider
 * exists — but the two SDKs are not symmetric, and three differences are worked
 * around here rather than leaked upward:
 *
 *   - **No turn limit.** The SDK has no `maxTurns`. Turns are counted from
 *     `assistant.turn_end` and the session is aborted on the one past the
 *     ceiling, which is the harness's real bound on a stage.
 *   - **No schema output.** There is no `json_schema` response mode. A stage
 *     that must answer in a schema is given a tool carrying that schema and
 *     told to call it, which is stricter than asking for JSON in prose: the
 *     arguments are validated by the runtime before the handler ever runs.
 *   - **No dollars.** Usage is reported against a premium-request allowance,
 *     so {@link costUnit} is credits and the ledger keeps it apart from money.
 *
 * Authentication needs no code: the SDK reads `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`
 * or `GITHUB_TOKEN`, and falls back to whatever `copilot` CLI login is on the
 * machine. There is no device flow to implement here.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CopilotClient, defineTool } from '@github/copilot-sdk';
import type { ModelInfo, PermissionRequest, PermissionRequestResult } from '@github/copilot-sdk';
import { runGit, screenGit } from '../git-tool.ts';
import type { AvailableModel } from './availability.ts';
import { markUnusable } from './availability.ts';
import type { Capability, Engine, StageRequest } from './types.ts';
import { type StageResult, SumoError, type Tier } from '../types.ts';

/**
 * Fallbacks for when the catalogue has nothing to say.
 *
 * Routing normally names the model, having checked it is reachable on this
 * account and suits the stage — see `fleet.ts`. These exist only for the case
 * where it could not, and are deliberately the most ordinary choice at each
 * tier rather than the best: a guess should be unsurprising, not ambitious.
 */
const FALLBACK: Record<Tier, string> = {
  small: 'gpt-5-mini',
  mid: 'claude-sonnet-5',
  large: 'claude-opus-5',
};

/** The name the model must call to answer a schema-constrained stage. */
const SUBMIT_TOOL = 'submit_result';

/**
 * Which built-in tools each capability unlocks.
 *
 * Names taken from a live runtime rather than from documentation, which lists
 * none — the tool set is a runtime property of the CLI version. Getting one
 * wrong fails silently and expensively: an unknown name simply matches nothing,
 * so the stage runs with fewer tools than it was promised and only misbehaves
 * later, when it cannot read the file it was told to look at.
 *
 * Restricting this is the single biggest saving on this provider. The default
 * tool set costs about 5,100 input tokens on every model call — measured at
 * 7,150 tokens for a six-word prompt against 2,043 with the list emptied — and
 * a stage pays that on every turn, not once.
 *
 * The whole `bash` family is deliberately absent, as are `skill`, `sql`, `task`
 * and the agent tools: the harness runs commands, and a stage that can spawn
 * its own sub-agents is one whose cost and permissions the harness no longer
 * controls.
 */
const TOOLS: Record<Capability, readonly string[]> = {
  read: ['view'],
  search: ['grep', 'glob'],
  edit: ['edit', 'create'],
  // Screened through the custom tool below, never a built-in.
  git: [],
  // Fetch only. The search half is the fallback below: `websearch.ts` runs the
  // search itself so that it means the same thing on every provider.
  web: ['web_fetch'],
};

/**
 * The provider's own search, granted only when the harness could not run one.
 *
 * This provider is why the harness runs its own. `web_search` is a hosted server
 * tool here, the same shape as Anthropic's `WebSearch` — Copilot's own research
 * agent grants it — but it sits behind a `copilot_cli_native_web_search` runtime
 * flag, so whether it exists is a property of the account rather than of the
 * code. Granting `web_fetch` alone, as this did, left `/research` able to
 * retrieve a URL it already had and unable to find one: the mode that exists to
 * leave the machine could not, on this provider only, and said nothing about it.
 */
const HOSTED_SEARCH = 'web_search';

/**
 * The built-in tools granted for a stage's capabilities.
 *
 * `searched` says the harness already put search results in the prompt, in which
 * case the provider's own search is withheld and only fetch remains — see
 * {@link HOSTED_SEARCH}.
 */
export function toolsFor(capabilities: readonly Capability[], searched = false): string[] {
  const names = capabilities.flatMap((c) => TOOLS[c]);
  if (capabilities.includes('web') && !searched) names.push(HOSTED_SEARCH);
  return [...new Set(names)];
}

/**
 * One client for the process, started on first use.
 *
 * The SDK spawns the Copilot CLI and talks JSON-RPC to it, so a client per
 * stage would pay a process launch for every step of every task. Sessions are
 * cheap and are still created and disposed per stage; only the runtime is
 * shared.
 */
let shared: CopilotClient | null = null;
let starting: Promise<CopilotClient> | null = null;

async function client(): Promise<CopilotClient> {
  if (shared) return shared;
  starting ??= (async () => {
    const made = new CopilotClient({ logLevel: 'error' });
    await made.start();
    // The runtime is a child process, so it dies with the harness anyway —
    // this only makes the common exit tidy rather than abrupt, and is
    // registered here so no caller has to remember to do it.
    process.once('beforeExit', () => void made.stop());
    shared = made;
    return made;
  })();
  return starting;
}

/**
 * Whether this machine looks like it has a Copilot account.
 *
 * One of the tokens the SDK reads, or a Copilot CLI that has run here.
 *
 * A `gh` login is deliberately not evidence. `gh auth status` says the machine
 * can reach GitHub, which is a different question from whether the account
 * carries a Copilot entitlement — and reading it as a yes would put this
 * provider in the default fleet of every machine with `gh` installed, where it
 * would win a stage and then fail it.
 *
 * The cost of being too strict is small and recoverable: a subscriber who has
 * never run the CLI passes `--provider github-copilot` once, which skips this
 * check entirely.
 */
export function credentialed(): boolean {
  const token =
    process.env['COPILOT_GITHUB_TOKEN'] ?? process.env['GH_TOKEN'] ?? process.env['GITHUB_TOKEN'];
  return Boolean(token) || existsSync(join(homedir(), '.copilot'));
}

export class CopilotEngine implements Engine {
  readonly name = 'github-copilot';
  /**
   * Copilot bills against a premium-request allowance, not in money.
   *
   * The SDK does report per-token prices, and they agree with public pricing to
   * the penny — but what a request actually *spends* is allowance, and a number
   * printed with a `$` in front would describe the wrong quantity.
   */
  readonly costUnit = 'credits' as const;
  /**
   * No `json_schema` response mode exists in the SDK.
   *
   * False rather than true-with-a-workaround, because the flag answers "can
   * this provider guarantee a schema-valid final answer" and the tool below is
   * a strong convention, not a guarantee — a model can decline to call it. The
   * router reads this when a stage cannot proceed without one.
   */
  readonly supportsOutputSchema = false;
  /**
   * But it does arrange one — see {@link SUBMIT_TOOL}. The arguments are
   * validated by the runtime before the handler runs, so an answer that arrives
   * is schema-valid; what cannot be promised is that one arrives at all.
   */
  readonly attemptsOutputSchema = true;


  modelFor(tier: Tier): string {
    return FALLBACK[tier];
  }

  /**
   * Whether the tier's fallback model takes an effort setting.
   *
   * Only consulted for the fallback: when routing named a model it also checked
   * the effort against that model's own list, which is per-model rather than
   * per-tier — on this provider `claude-haiku-4.5` accepts none and
   * `claude-opus-4.6` accepts four.
   */
  supportsEffort(tier: Tier): boolean {
    return tier !== 'small';
  }

  /**
   * What this account may actually call.
   *
   * A model with no policy object is reported enabled, not unconfigured. Copilot
   * attaches a policy only where consent is needed — on a live subscription 3 of
   * 17 models carried none — and reading absence as "not enabled" would withdraw
   * most of a working roster.
   */
  async availableModels(): Promise<readonly AvailableModel[]> {
    const models = await (await client()).listModels();
    return models.map((m: ModelInfo) => ({
      id: m.id,
      state: m.policy?.state ?? ('enabled' as const),
    }));
  }

  async runStage(req: StageRequest): Promise<StageResult> {
    const model = req.model ?? this.modelFor(req.rung.tier);
    const denials: string[] = [];
    const usage = { input: 0, output: 0, cacheRead: 0, cost: 0 };
    let turns = 0;
    let text = '';
    /** Set when the schema tool is called; the stage's real answer. */
    let submitted: unknown;
    let stopped: StageResult['stopped'];

    const session = await (await client()).createSession({
      model,
      ...(req.rung.effort ? { reasoningEffort: req.rung.effort } : {}),
      // The harness owns the system prompt entirely — no Copilot persona, no
      // repository instruction files, nothing it did not put there itself.
      systemMessage: { mode: 'replace', content: req.systemPrompt },
      workingDirectory: req.cwd,
      streaming: true,
      // Bash is never granted, so nothing should be discovering `.mcp.json` or
      // skill directories on our behalf either.
      enableConfigDiscovery: false,
      // The real restriction, and the one that costs nothing to enforce: an
      // unlisted built-in is absent from the model's context entirely rather
      // than refused after the fact.
      availableTools: [...toolsFor(req.capabilities, req.searched ?? false), ...customNames(req)],
      tools: [
        ...(req.capabilities.includes('git') ? [gitTool(req.cwd, denials)] : []),
        ...(req.outputSchema ? [submitTool(req.outputSchema, (v) => (submitted = v))] : []),
      ],
      onPermissionRequest: (request) => decide(request, req, denials),
    });

    const done = new Promise<void>((resolve) => {
      session.on('session.idle', () => resolve());
    });

    session.on('assistant.message_delta', (e) => {
      const chunk = (e.data as { deltaContent?: string }).deltaContent ?? '';
      text += chunk;
      req.onEvent?.({ kind: 'text', text: chunk });
    });
    session.on('assistant.reasoning_delta', () => req.onEvent?.({ kind: 'thinking' }));
    session.on('tool.execution_start', (e) => {
      const data = e.data as { toolName?: string; arguments?: Record<string, unknown> };
      req.onEvent?.({
        kind: 'tool',
        tool: data.toolName ?? 'tool',
        detail: describe(data.arguments ?? {}, req.cwd),
      });
    });
    session.on('assistant.usage', (e) => {
      // One event per model call, including sub-agents', so these accumulate
      // rather than overwrite — a stage's cost is every call it caused.
      const u = e.data as {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cost?: number;
      };
      usage.input += u.inputTokens ?? 0;
      usage.output += u.outputTokens ?? 0;
      usage.cacheRead += u.cacheReadTokens ?? 0;
      usage.cost += u.cost ?? 0;
    });

    // The SDK has no turn ceiling, so the harness enforces its own. Aborting on
    // the turn *past* the limit rather than at it means the limit is a number of
    // completed turns, matching what `maxTurns` means to every other provider.
    session.on('assistant.turn_end', () => {
      turns += 1;
      if (turns >= req.maxTurns) {
        stopped = 'turns';
        void session.abort();
      }
    });

    try {
      await session.send({ prompt: withSubmitInstruction(req) });
      await done;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // A model that refuses at call time outranks any earlier probe: the
      // allowance can run out between being asked and being used.
      if (/quota|policy|entitle|forbidden|not enabled/i.test(message)) {
        markUnusable(this.name, model);
      }
      throw new SumoError(`Stage "${req.stage}" failed: ${message}`, 'stage_failed', [
        'Check `gh auth status`, or that this account still has premium requests.',
      ]);
    } finally {
      await session.disconnect();
    }

    if (req.outputSchema && submitted === undefined) {
      // Nothing to salvage: the stage's whole product was the structured answer.
      stopped = 'error';
    }

    return {
      stage: req.stage,
      output: submitted === undefined ? text : JSON.stringify(submitted),
      cost: usage.cost,
      costUnit: this.costUnit,
      turns,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      rung: req.rung,
      model,
      provider: this.name,
      sessionId: session.sessionId,
      ...(stopped ? { stopped } : {}),
      denials,
    };
  }
}

/**
 * Adapts the provider-neutral gate to Copilot's permission handler.
 *
 * Decided on the request's `kind` rather than on a tool name. Kinds are a small
 * closed set the SDK documents — shell, write, read, mcp, custom-tool, url — and
 * tool names are runtime strings that vary with the CLI version. Gating on the
 * stable thing means a renamed tool cannot silently open a hole.
 *
 * Shell is refused outright and unconditionally: the harness runs commands, and
 * no capability in this harness grants a model a terminal.
 */
function decide(
  request: PermissionRequest,
  req: StageRequest,
  denials: string[],
): PermissionRequestResult {
  const kind = (request as { kind?: string }).kind ?? '';

  if (kind === 'shell') {
    denials.push('shell');
    req.onEvent?.({ kind: 'denied', tool: 'shell', reason: 'the harness runs commands' });
    return { kind: 'reject', feedback: 'Shell is not available. Propose the command instead.' };
  }

  if (kind === 'url' && !req.capabilities.includes('web')) {
    denials.push('url');
    return { kind: 'reject', feedback: 'This stage may not reach the network.' };
  }

  if (kind === 'write' || kind === 'read') {
    const [tool, input]: [string, Record<string, unknown>] =
      kind === 'write' ? writeGateArgs(request) : ['Read', readGateArgs(request)];
    const reason = req.gate?.(tool, input);
    if (reason !== null && reason !== undefined) {
      denials.push(kind);
      req.onEvent?.({ kind: 'denied', tool: kind, reason });
      return { kind: 'reject', feedback: reason };
    }
  }

  return { kind: 'approve-once' };
}

function readGateArgs(request: PermissionRequest): Record<string, unknown> {
  const file = (request as { fileName?: string }).fileName;
  return file ? { file_path: file } : {};
}

/**
 * A Copilot write request, in the shape the provider-neutral gate expects.
 *
 * Both halves of this were wrong, and each broke something different.
 *
 * Everything used to arrive as `Write`. The gate's `preferTargetedEdits` rule
 * refuses a `Write` to a file that already exists and tells the model to use
 * `Edit` instead — advice that could not be taken, because there was no way for
 * an edit to reach the gate as one. Every targeted edit to an existing file was
 * refused, on the one provider, with a reason that read like a solution. The
 * same mislabelling made the edit/write tally — which exists to measure exactly
 * the difference between the two — count every edit as a whole-file rewrite.
 *
 * And no content was passed at all, so `findSecret` was handed an empty string
 * on every call: the screen that refuses a write containing something
 * key-shaped could not fire on this provider. A gate that cannot see what is
 * being written is not a gate.
 *
 * The SDK distinguishes the two cases for us. `newFileContents` is populated
 * only when the whole file is being written; a targeted edit carries a unified
 * `diff` and nothing else. That maps exactly onto the two tools the gate knows,
 * and onto the two fields `writtenContent` reads for each.
 */
export function writeGateArgs(request: PermissionRequest): [string, Record<string, unknown>] {
  const w = request as { fileName?: string; diff?: string; newFileContents?: string };
  const path = w.fileName ? { file_path: w.fileName } : {};

  if (w.newFileContents !== undefined) {
    return ['Write', { ...path, content: w.newFileContents }];
  }
  return ['Edit', { ...path, new_string: addedLines(w.diff ?? '') }];
}

/**
 * The lines a unified diff adds, which is the whole of what a targeted edit
 * puts on disk.
 *
 * Screening the raw diff instead would scan removed lines too, so deleting a
 * line that already contained a key would be refused as though it were adding
 * one — the one edit most worth allowing.
 */
function addedLines(diff: string): string {
  return diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
}

/**
 * The tool a schema-constrained stage must call to answer.
 *
 * The schema becomes the tool's parameters, so the runtime validates the answer
 * before this handler sees it — the same guarantee `json_schema` output gives,
 * arrived at from the other direction.
 */
function submitTool(schema: Record<string, unknown>, keep: (value: unknown) => void) {
  return defineTool(SUBMIT_TOOL, {
    description:
      'Submit the final answer for this stage. Call this exactly once, when the ' +
      'work is done. The answer is only recorded through this tool.',
    parameters: schema,
    // The answer itself is not an action needing consent, and prompting for it
    // would stall a headless run on the one call that must happen.
    skipPermission: true,
    handler: (args: unknown) => {
      keep(args);
      return 'recorded';
    },
  });
}

/** Says how to answer, when answering means calling a tool. */
function withSubmitInstruction(req: StageRequest): string {
  if (!req.outputSchema) return req.prompt;
  return `${req.prompt}\n\nWhen you have finished, call ${SUBMIT_TOOL} with your answer. Text replies are not recorded.`;
}

/** Names of the tools this stage contributes itself, for the allowlist. */
function customNames(req: StageRequest): string[] {
  return [
    ...(req.capabilities.includes('git') ? ['git'] : []),
    ...(req.outputSchema ? [SUBMIT_TOOL] : []),
  ];
}

/** The git tool, screened exactly as the Claude engine screens it. */
function gitTool(cwd: string, denials: string[]) {
  return defineTool('git', {
    description:
      'Run a read-only or branch-switching git command in the working directory. ' +
      'Allowed: status, branch, checkout, switch, log, diff, show, rev-parse, ' +
      'ls-files, describe, blame, stash (list and show only). Commands that push, ' +
      'fetch, force, delete, or discard work are refused.',
    parameters: {
      type: 'object',
      properties: { args: { type: 'string', description: 'Arguments after "git"' } },
      required: ['args'],
    },
    handler: async (input: unknown) => {
      const args = (input as { args?: string }).args ?? '';
      const verdict = screenGit(args);
      if (!verdict.allowed) {
        denials.push('git');
        return verdict.reason ?? 'refused';
      }
      return (await runGit(args, cwd)).output;
    },
  });
}

/** One short line describing what a tool call is about to do. */
function describe(input: Record<string, unknown>, cwd: string): string {
  for (const key of ['file_path', 'path', 'fileName', 'filePath']) {
    const value = input[key];
    if (typeof value === 'string') {
      return value.startsWith(cwd) ? value.slice(cwd.length + 1) : value;
    }
  }
  const pattern = input['pattern'] ?? input['query'] ?? input['args'];
  return typeof pattern === 'string' ? pattern : '';
}
