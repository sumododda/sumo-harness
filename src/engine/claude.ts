/**
 * Claude provider, built on the Claude Agent SDK.
 *
 * This is the only file in the project allowed to import the SDK or name a
 * `claude-*` model. Everything above it works in tiers.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import type { HookJSONOutput, Options, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import * as features from '../features.ts';
import { type AvailableModel, markUnusable } from './availability.ts';
import { modelsFor } from './catalog.ts';
import { runGit, screenGit } from '../git-tool.ts';
import type { Capability, Engine, StageRequest } from './types.ts';
import { type StageResult, SumoError, type Tier } from '../types.ts';

const MODELS: Record<Tier, string> = {
  small: 'claude-haiku-4-5',
  mid: 'claude-sonnet-5',
  large: 'claude-opus-5',
};

/**
 * Which built-in tools each capability unlocks. `tools` removes everything not
 * listed from the model's context entirely, so an unlisted tool costs no tokens
 * and cannot be called at all — stronger and cheaper than refusing it later.
 *
 * Bash is deliberately absent from every capability: the harness runs commands.
 */
const TOOLS: Record<Capability, readonly string[]> = {
  read: ['Read'],
  search: ['Glob', 'Grep'],
  edit: ['Edit', 'Write'],
  // Provided as an in-process MCP tool rather than a built-in, so it carries no
  // subprocess and the harness screens every invocation.
  git: [],
  // Server-side tools. Granted per stage rather than globally, because a stage
  // that can reach the network is a stage whose answer is no longer reproducible
  // from the repo alone.
  //
  // Fetch only. The search half is the fallback below: `websearch.ts` runs the
  // search itself so that it means the same thing on every provider and its
  // results are in the prompt before the first turn.
  web: ['WebFetch'],
};

/**
 * The provider's own search, granted only when the harness could not run one.
 *
 * Kept out of {@link TOOLS} so that the common path — the harness searched, the
 * results are already in the prompt — does not carry a tool the stage has no
 * reason to call. A tool that is present gets used, and a second search would
 * return a different five pages from the ones the citations were promised
 * against.
 */
const HOSTED_SEARCH = 'WebSearch';

/**
 * `read`/`search`/`edit`, granted to every stage once `stableToolList` is on,
 * so the tool-definitions block — part of the exact prefix a provider's own
 * cache matches on — stops changing between a task's read-only and writable
 * stages. `buildGate`'s `PreToolUse` hook is unchanged and is still the only
 * thing that refuses `Edit`/`Write` on a read-only stage; this only decides
 * what appears in the model's context, trading that layer of defence away for
 * cache stability, behind a flag that can turn it straight back on.
 *
 * `git` and `web` are deliberately left out of the stable set and stay
 * capability-driven. They are already granted to one stage per task rather
 * than every stage for reasons that have nothing to do with caching — `git`
 * only ever reaches the repo through the screened MCP tool below, and `web`
 * is the one capability whose answer cannot be re-derived from the repo (see
 * `RESEARCH_STAGE` in prompts.ts). Adding them everywhere would widen what
 * every stage can reach by default, which is a bigger and less obviously safe
 * change than this brief is measuring.
 */
const STABLE_CAPABILITIES: readonly Capability[] = ['read', 'search', 'edit'];

/**
 * The SDK tool names granted for a stage's capabilities.
 *
 * `searched` says the harness already put search results in the prompt, in which
 * case the provider's own search is withheld and only fetch remains — see
 * {@link HOSTED_SEARCH}.
 */
export function toolsFor(capabilities: readonly Capability[], searched = false): string[] {
  // A stage that asks for nothing gets nothing, stable list or not. The two
  // that do this — the router and the escalation judge — answer from their own
  // prompt and have no use for the repository, so the stable set has no prefix
  // to keep stable for them: they are one call each, not part of a task's run
  // of stages.
  //
  // Left implicit, this was expensive. `capabilities: []` still handed both
  // `read`, `search` and `edit`, and the router used them: asked to classify
  // "subtotal throws on empty input" it opened the repository, went looking for
  // `subtotal`, took six turns, spent its entire budget and returned narration
  // instead of an answer. Routing every turn through that cost 13× what routing
  // costs now, on a question whose whole input is one sentence.
  if (capabilities.length === 0) return [];

  const granted = features.get().stableToolList
    ? [...new Set([...STABLE_CAPABILITIES, ...capabilities])]
    : capabilities;
  const names = granted.flatMap((c) => TOOLS[c]);
  if (granted.includes('web') && !searched) names.push(HOSTED_SEARCH);
  return [...new Set(names)];
}

/**
 * Whether this machine looks like it has an Anthropic account.
 *
 * A key in the environment, or a `claude` CLI that has been logged in. The CLI
 * keeps its token in the system keychain on macOS, so there is no credential
 * file to look for and no way to check without asking the keychain — which
 * prompts. Its config directory is the honest proxy: it exists once the CLI has
 * run, which is exactly when there is a login to borrow.
 *
 * Cheap and synchronous by contract — this decides what goes in the default
 * fleet, before any work starts, so it reads the environment and the filesystem
 * and never spawns anything.
 */
export function credentialed(): boolean {
  if (process.env['ANTHROPIC_API_KEY']) return true;
  const home = homedir();
  return existsSync(join(home, '.claude.json')) || existsSync(join(home, '.claude'));
}

/**
 * How long the roster probe may take before it is treated as unanswerable.
 *
 * It spawns the CLI, so it is not instant — measured at about half a second on a
 * warm machine. The ceiling exists so that a CLI which starts and then hangs
 * costs a slow first stage rather than a session that never begins.
 */
const PROBE_TIMEOUT_MS = 20_000;

/** A `[1m]`-style variant marker. The same model, offered at a different window. */
const VARIANT_SUFFIX = /\[[^\]]*\]$/;

/**
 * A prompt that never arrives.
 *
 * `supportedModels()` is a control request to a running CLI, so one has to be
 * started to ask it — but starting it with a real prompt would run a real turn
 * and bill for it. Streaming input that never yields gets a CLI that connects,
 * answers the control request, and is closed again without a single token.
 */
async function* idle(): AsyncGenerator<never> {
  await new Promise(() => {
    // Never resolves. The generator is disposed by `Query.return`.
  });
  yield undefined as never;
}

/**
 * Whether a model the CLI offers and a model the catalogue lists are the same one.
 *
 * Neither side spells them identically. The CLI answers with whatever its alias
 * resolves to, which is sometimes dated (`claude-haiku-4-5-20251001`) where the
 * catalogue's canonical entry is not (`claude-haiku-4-5`) — and sometimes the
 * other way round once a dated alias is published. Comparing for equality would
 * drop a perfectly reachable model, and dropping one is not a quiet failure: it
 * empties a tier and routing falls to whatever is left, which at the large tier
 * meant a model at twice the price.
 *
 * The match breaks on a `-` boundary rather than being a bare prefix, so
 * `claude-opus-4` cannot claim to be `claude-opus-4-6`.
 */
export function sameModel(listed: string, catalogued: string): boolean {
  return (
    listed === catalogued ||
    listed.startsWith(`${catalogued}-`) ||
    catalogued.startsWith(`${listed}-`)
  );
}

export class ClaudeEngine implements Engine {
  readonly name = 'claude';
  /** models.dev files these under the vendor's name, not the model family's. */
  readonly catalogName = 'anthropic';
  /** Anthropic prices a request in money, so this provider's numbers are dollars. */
  readonly costUnit = 'usd' as const;
  /** The SDK constrains a final answer with `outputFormat: json_schema`. */
  readonly supportsOutputSchema = true;

  modelFor(tier: Tier): string {
    return MODELS[tier];
  }

  /** Haiku exposes no effort control; the mid and large tiers do. */
  supportsEffort(tier: Tier): boolean {
    return tier !== 'small';
  }

  /**
   * Counts tokens with the provider's own tokenizer.
   *
   * Used only by `sumo bench`, to check claims about an encoding against the
   * thing that actually bills for it. The endpoint is free but does need
   * credentials, so callers must handle it throwing.
   */
  async countTokens(text: string): Promise<number> {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic();
    const result = await client.messages.countTokens({
      model: MODELS.mid,
      messages: [{ role: 'user', content: text }],
    });
    return result.input_tokens;
  }

  /**
   * What this login may actually call.
   *
   * Asked of the CLI rather than of the REST API, because the CLI login is the
   * credential most people run this on and it is the one an organisation policy
   * or a plan change acts on. A bare `models.list` would need
   * `ANTHROPIC_API_KEY`, which those people do not have, so the probe would
   * never run for them and the roster would go unchecked for exactly the
   * accounts most likely to have one imposed on them.
   *
   * Throws rather than returning an empty roster when it cannot ask. The two
   * mean opposite things — "I do not know" against "you may call nothing" — and
   * `usable()` reads a throw as the first, keeping the last good answer or
   * trusting the catalogue. Returning `[]` would read as the second and leave
   * every tier empty.
   */
  async availableModels(): Promise<readonly AvailableModel[]> {
    const listed = await this.offeredModelIds();
    const reachable = modelsFor(this.catalogName).filter((m) =>
      listed.some((id) => sameModel(id, m.id)),
    );

    // The CLI answered, and answered with nothing this catalogue knows. That is
    // a roster no routing decision can be made from, so it is reported the same
    // way as not having been able to ask.
    if (reachable.length === 0) {
      throw new SumoError(
        'The Claude CLI offered no model this catalogue knows.',
        'unknown_roster',
        [`It offered: ${listed.join(', ') || 'nothing'}`],
      );
    }

    return reachable.map((m) => ({ id: m.id, state: 'enabled' as const }));
  }

  /** The ids the CLI offers, aliases resolved and variant markers stripped. */
  private async offeredModelIds(): Promise<readonly string[]> {
    const q = query({ prompt: idle(), options: { settingSources: [], allowedTools: [] } });
    const timer = new Promise<never>((_, reject) => {
      // Unreferenced so a probe still running cannot by itself hold the process
      // open once everything else is done.
      setTimeout(() => reject(new Error('the Claude CLI did not answer')), PROBE_TIMEOUT_MS).unref();
    });

    try {
      const models = await Promise.race([q.supportedModels(), timer]);
      return [...new Set(models.map((m) => (m.resolvedModel ?? m.value).replace(VARIANT_SUFFIX, '')))];
    } finally {
      await q.return(undefined);
    }
  }

  async runStage(req: StageRequest): Promise<StageResult> {
    // Routing knows things this engine does not — what the account can reach,
    // what the stage needs — so its choice wins where it made one.
    const model = req.model ?? this.modelFor(req.rung.tier);
    const effort = this.supportsEffort(req.rung.tier) ? req.rung.effort : undefined;

    const tools = toolsFor(req.capabilities, req.searched ?? false);

    // Recorded by the gate hook, so a refusal is provable after the fact.
    const denials: string[] = [];

    const wantsGit = req.capabilities.includes('git');
    const mcpServers = wantsGit
      ? { sumo: createSdkMcpServer({ name: 'sumo', tools: [gitTool(req.cwd, denials)] }) }
      : undefined;

    // MCP tools are addressed as mcp__<server>__<tool>, and must be listed for
    // auto-approval like any other — omitting it leaves the model holding a
    // tool that `dontAsk` then refuses, which reads to it as a broken harness.
    const approved = wantsGit ? [...tools, 'mcp__sumo__git'] : tools;

    const options: Options = {
      model,
      ...(effort ? { effort } : {}),
      systemPrompt: req.systemPrompt,
      // Load no filesystem config: no CLAUDE.md, no settings, no skills tax.
      settingSources: [],
      cwd: req.cwd,
      // `tools` is the real restriction — unlisted tools are absent from context.
      tools,
      // Auto-approve so a headless run never blocks on a prompt. The gate below
      // is a PreToolUse hook rather than `canUseTool` because permission modes
      // and allow-rules can both short-circuit that callback before it runs —
      // the hook is consulted for every call regardless.
      allowedTools: approved,
      permissionMode: 'dontAsk',
      maxTurns: req.maxTurns,
      // The harness's ceiling is in this engine's unit, which for Anthropic is
      // dollars — so it maps straight onto the SDK's own dollar-denominated cap.
      ...(req.maxBudget !== undefined ? { maxBudgetUsd: req.maxBudget } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      ...(req.outputSchema
        ? { outputFormat: { type: 'json_schema' as const, schema: req.outputSchema } }
        : {}),
      ...(req.gate
        ? { hooks: { PreToolUse: [{ hooks: [toHook(req.gate, denials, req.onEvent)] }] } }
        : {}),
    };

    let text = '';

    try {
      for await (const message of query({ prompt: req.prompt, options })) {
        if (message.type === 'assistant') {
          for (const block of message.message.content) {
            if (block.type === 'text') {
              text += block.text;
              req.onEvent?.({ kind: 'text', text: block.text });
            } else if (block.type === 'thinking') {
              req.onEvent?.({ kind: 'thinking' });
            } else if (block.type === 'tool_use') {
              req.onEvent?.({
                kind: 'tool',
                tool: block.name,
                detail: describeToolUse(block.input as Record<string, unknown>, req.cwd),
              });
            }
          }
        } else if (message.type === 'result') {
          // The SDK records its own refusals (e.g. paths outside cwd) separately
          // from the harness gate's, and both count as enforcement.
          for (const denial of message.permission_denials ?? []) {
            denials.push(denial.tool_name);
          }

          const usage = message.usage ?? {};
          const stopped =
            message.subtype === 'success'
              ? undefined
              : message.subtype === 'error_max_budget_usd'
                ? 'budget'
                : message.subtype === 'error_max_turns'
                  ? 'turns'
                  : 'error';

          return {
            stage: req.stage,
            // Structured stages get the validated result; prose stages get the text.
            output:
              message.subtype === 'success' && typeof message.result === 'string'
                ? message.result
                : text,
            cost: message.total_cost_usd ?? 0,
            costUnit: this.costUnit,
            turns: message.num_turns ?? 0,
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            cacheReadTokens: usage.cache_read_input_tokens ?? 0,
            rung: req.rung,
            model,
            provider: this.name,
            sessionId: message.session_id,
            ...(stopped ? { stopped } : {}),
            denials,
          };
        }
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // A model that refuses at call time outranks any earlier probe: an
      // organisation can withdraw one, or a plan's limit can be reached, between
      // the roster being read and the model being used. Recorded for this run
      // only, so routing stops choosing it without waiting out the probe's day.
      if (/quota|rate.?limit|policy|entitle|forbidden|not enabled|permission/i.test(message)) {
        markUnusable(this.name, model);
      }
      throw new SumoError(`Stage "${req.stage}" failed: ${message}`, 'stage_failed', [
        'Check that ANTHROPIC_API_KEY is set, or run `claude` once to authenticate.',
      ]);
    }

    throw new SumoError(
      `Stage "${req.stage}" ended without a result message.`,
      'stage_no_result',
      ['This usually means the SDK subprocess died. Re-run the command.'],
    );
  }
}

/**
 * The git tool. Every invocation is screened here, so the model can change
 * branch and read history but cannot publish, discard, or rewrite work.
 */
function gitTool(cwd: string, denials: string[]) {
  return tool(
    'git',
    'Run a read-only or branch-switching git command in the working directory. ' +
      'Allowed: status, branch, checkout, switch, log, diff, show, rev-parse, ' +
      'ls-files, describe, blame, stash (list and show only). checkout and ' +
      'switch may change branch but may not name files, because restoring a ' +
      'file discards its uncommitted changes. Commands that push, fetch, force, ' +
      'delete, or discard work are refused — ask the operator for those.',
    { args: z.string().describe('Arguments after "git", e.g. "checkout main"') },
    async ({ args }) => {
      const verdict = screenGit(args);
      if (!verdict.allowed) {
        denials.push('git');
        return {
          content: [{ type: 'text' as const, text: verdict.reason ?? 'refused' }],
          isError: true,
        };
      }

      const result = await runGit(args, cwd);
      return { content: [{ type: 'text' as const, text: result.output }] };
    },
  );
}

/** One short line describing what a tool call is about to do. */
function describeToolUse(input: Record<string, unknown>, cwd: string): string {
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const value = input[key];
    if (typeof value === 'string') {
      return value.startsWith(cwd) ? value.slice(cwd.length + 1) : value;
    }
  }
  const pattern = input['pattern'];
  if (typeof pattern === 'string') return pattern;
  const command = input['command'];
  if (typeof command === 'string') return command;
  return '';
}

/**
 * Adapts the provider-neutral gate to a PreToolUse hook. A denial reason is
 * returned to the model so it can correct course instead of retrying blindly.
 */
function toHook(
  gate: NonNullable<StageRequest['gate']>,
  denials: string[],
  onEvent?: StageRequest['onEvent'],
) {
  return async (input: unknown): Promise<HookJSONOutput> => {
    const pre = input as PreToolUseHookInput;
    if (pre.hook_event_name !== 'PreToolUse') return {};

    const toolInput = (pre.tool_input ?? {}) as Record<string, unknown>;
    const reason = gate(pre.tool_name, toolInput);
    if (reason === null) return {};

    denials.push(pre.tool_name);
    onEvent?.({ kind: 'denied', tool: pre.tool_name, reason });
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    };
  };
}
