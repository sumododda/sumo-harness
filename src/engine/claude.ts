/**
 * Claude provider, built on the Claude Agent SDK.
 *
 * This is the only file in the project allowed to import the SDK or name a
 * `claude-*` model. Everything above it works in tiers.
 */

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import type { HookJSONOutput, Options, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import * as features from '../features.ts';
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
  // Server-side tools: the search runs on the provider, so there is no local
  // index, no key, and nothing to keep up to date. Granted per stage rather
  // than globally, because a stage that can reach the network is a stage whose
  // answer is no longer reproducible from the repo alone.
  web: ['WebSearch', 'WebFetch'],
};

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

/** The SDK tool names granted for a stage's capabilities. */
export function toolsFor(capabilities: readonly Capability[]): string[] {
  const granted = features.get().stableToolList
    ? [...new Set([...STABLE_CAPABILITIES, ...capabilities])]
    : capabilities;
  return [...new Set(granted.flatMap((c) => TOOLS[c]))];
}

export class ClaudeEngine implements Engine {
  readonly name = 'claude';

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

  async runStage(req: StageRequest): Promise<StageResult> {
    const model = this.modelFor(req.rung.tier);
    const effort = this.supportsEffort(req.rung.tier) ? req.rung.effort : undefined;

    const tools = toolsFor(req.capabilities);

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
      ...(req.maxBudgetUsd !== undefined ? { maxBudgetUsd: req.maxBudgetUsd } : {}),
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
            costUsd: message.total_cost_usd ?? 0,
            turns: message.num_turns ?? 0,
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            cacheReadTokens: usage.cache_read_input_tokens ?? 0,
            rung: req.rung,
            model,
            sessionId: message.session_id,
            ...(stopped ? { stopped } : {}),
            denials,
          };
        }
      }
    } catch (cause) {
      throw new SumoError(
        `Stage "${req.stage}" failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        'stage_failed',
        ['Check that ANTHROPIC_API_KEY is set, or run `claude` once to authenticate.'],
      );
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
