/**
 * The stage runner: one unit of model work, with its permissions, budget, and
 * accounting all decided by the harness before the model is invoked.
 *
 * Workflows compose stages; only this module talks to an Engine.
 */

import pc from 'picocolors';
import * as cache from './cache.ts';
import type { Capability, Engine } from './engine/index.ts';
import type { EventSink } from './engine/types.ts';
import type { Progress } from './progress.ts';
import type { Steering } from './steer.ts';
import * as features from './features.ts';
import { buildGate } from './gate-tools.ts';
import { hash, repoFingerprint } from './hash.ts';
import type { Ledger } from './ledger.ts';
import { estimateTokens, estimateTokensFromChars } from './profile.ts';
import { systemPrompt } from './prompts.ts';
import { describeRung, type Rung, type StageResult } from './types.ts';

export interface StageSpec {
  readonly name: string;
  readonly prompt: string;
  readonly rung: Rung;
  readonly capabilities: readonly Capability[];
  readonly cwd: string;
  /** Absent means read-only: the gate refuses every write. */
  readonly allowWrites?: boolean;
  /** Files that must not change even in a writable stage. */
  readonly lockedPaths?: readonly string[];
  readonly maxTurns?: number;
  readonly maxBudgetUsd?: number;
  readonly outputSchema?: Record<string, unknown>;
  /** Receives live activity. Omit to run quietly. */
  readonly onEvent?: EventSink;
  /**
   * True when an index supplied this stage's context, which lets the gate
   * throttle broad searching the injected pack has already answered.
   */
  readonly indexed?: boolean;
  /**
   * How much of `prompt` came from the code index. Recorded so the pack's share
   * of the bill is visible, and so gating retrieval can be judged on numbers.
   */
  readonly packChars?: number;
  /** Which attempt this is within a workflow. 0 is the first try. */
  readonly attempt?: number;
  /**
   * Prefer targeted edits over whole-file rewrites.
   *
   * Set by workflows on a writable stage. The harness drops it automatically
   * after a failed attempt — see {@link GateOptions.preferTargetedEdits} — so
   * the cheap format is tried first and never becomes a reason to fail.
   */
  readonly preferTargetedEdits?: boolean;
  /**
   * Anything the operator typed while the task was running.
   *
   * Collected here rather than in each workflow so every stage boundary picks
   * steers up automatically — there is exactly one place a stage begins, and
   * this is it.
   */
  readonly steer?: Steering;
  /**
   * Announces this stage and reports what it cost when it ends.
   *
   * Lives here for the same reason steering does: a stage begins in exactly one
   * place, so a workflow cannot forget to say where it has got to.
   */
  readonly progress?: Progress;
}

const DEFAULT_TURNS = 20;
const DEFAULT_BUDGET_USD = 1.0;

export async function runStage(
  engine: Engine,
  spec: StageSpec,
  ledger: Ledger,
): Promise<StageResult> {
  const allowWrites = spec.allowWrites ?? false;

  if (spec.progress) {
    spec.progress.begin(spec.name);
  } else if (!spec.onEvent) {
    // Quiet runs still say which stage is working, just without the route.
    process.stderr.write(
      pc.dim(
        `→ ${spec.name} (${describeRung(spec.rung)}${allowWrites ? '' : ', read-only'})\n`,
      ),
    );
  }

  // Picked up before the key is built, so a steered stage is a different
  // question and can never be answered from the cache by an unsteered one.
  const steered = spec.steer?.takeAsPrompt() ?? '';
  const prompt = steered ? `${spec.prompt}\n${steered}` : spec.prompt;

  const system = systemPrompt(spec.cwd, allowWrites);
  const composition = {
    system: estimateTokens(system),
    prompt: estimateTokens(prompt),
    pack: estimateTokensFromChars(spec.packChars ?? 0),
  };

  const key = await cacheKeyFor(engine, spec, prompt, system);
  if (key) {
    const hit = cache.read<StageResult>(spec.cwd, key);
    if (hit) {
      const replayed: StageResult = {
        ...hit,
        costUsd: 0,
        cached: true,
        savedUsd: hit.costUsd,
        composition,
        ...(spec.attempt !== undefined ? { attempt: spec.attempt } : {}),
      };
      // Nothing streamed, so replay the answer through the same sink the live
      // path uses. Otherwise a cache hit would look like the harness hung.
      if (replayed.output.length > 0) {
        spec.onEvent?.({ kind: 'text', text: replayed.output });
      }
      ledger.add(replayed);
      spec.progress?.done('', 0, true);
      return replayed;
    }
  }

  const tally = { edit: 0, write: 0 };

  const raw = await engine.runStage({
    stage: spec.name,
    prompt,
    systemPrompt: system,
    rung: spec.rung,
    capabilities: spec.capabilities,
    cwd: spec.cwd,
    maxTurns: spec.maxTurns ?? DEFAULT_TURNS,
    maxBudgetUsd: spec.maxBudgetUsd ?? DEFAULT_BUDGET_USD,
    gate: buildGate({
      root: spec.cwd,
      allowWrites,
      tally,
      ...(spec.lockedPaths ? { lockedPaths: spec.lockedPaths } : {}),
      ...(spec.indexed ? { indexed: true } : {}),
      // Only ever a first-attempt preference: once an attempt has failed, the
      // format is no longer the thing worth economising on.
      ...(spec.preferTargetedEdits && features.get().targetedEdits && (spec.attempt ?? 0) === 0
        ? { preferTargetedEdits: true }
        : {}),
    }),
    ...(spec.outputSchema ? { outputSchema: spec.outputSchema } : {}),
    ...(spec.onEvent ? { onEvent: spec.onEvent } : {}),
  });

  const result: StageResult = {
    ...raw,
    composition,
    ...(tally.edit + tally.write > 0 ? { writeTools: tally } : {}),
    ...(spec.attempt !== undefined ? { attempt: spec.attempt } : {}),
  };

  ledger.add(result);
  spec.progress?.done(summarize(result), result.costUsd);

  // Only a stage that ran to completion is worth replaying. A truncated one
  // would be reused forever at the length its budget happened to allow.
  if (key && result.stopped === undefined) {
    const { sessionId: _sessionId, ...storable } = result;
    cache.write(spec.cwd, key, storable);
  }

  if (result.stopped === 'budget') {
    process.stderr.write(
      pc.yellow(`  stage hit its $${spec.maxBudgetUsd ?? DEFAULT_BUDGET_USD} budget\n`),
    );
  } else if (result.stopped === 'turns') {
    process.stderr.write(pc.yellow(`  stage hit its turn limit\n`));
  }

  return result;
}

/**
 * A few words on what a stage actually did, for its closing line.
 *
 * Deliberately about work rather than tokens: how many files it edited is the
 * thing worth glancing at, and the ledger already has the arithmetic.
 */
function summarize(result: StageResult): string {
  const parts: string[] = [];

  if (result.writeTools) {
    const { edit, write } = result.writeTools;
    const total = edit + write;
    if (total > 0) parts.push(`${total} edit${total === 1 ? '' : 's'}`);
  }
  if (result.denials.length > 0) {
    parts.push(pc.yellow(`${result.denials.length} refused`));
  }
  if (result.stopped) parts.push(pc.yellow(`stopped: ${result.stopped}`));

  return parts.join(' · ');
}

/**
 * The cache key for a stage, or null when this stage must not be reused.
 *
 * Two kinds of stage are excluded outright, both because their real product is
 * a change on disk rather than the text they return:
 *
 *   - writable stages — replaying "edited cart.js" without editing cart.js is
 *     silent corruption, not a saving;
 *   - git-capable stages — `checkout`, `switch`, and `stash` all move the tree,
 *     so a read-only tool set is not the same as having no effect.
 *
 * Everything else that can change the answer goes into the key. A missing
 * fingerprint (no git repo, or a tree too dirty to hash cheaply) also disables
 * reuse: without knowing what the code is, no answer about it can be trusted.
 */
async function cacheKeyFor(
  engine: Engine,
  spec: StageSpec,
  /** The prompt as actually sent, steers included. */
  prompt: string,
  /** The system prompt as actually sent — passed rather than rebuilt, so the
   * key can never describe a different prompt from the one the stage ran. */
  system: string,
): Promise<string | null> {
  if (!cache.isEnabled()) return null;
  if (spec.allowWrites === true) return null;
  if (spec.capabilities.includes('git')) return null;

  const fingerprint = await repoFingerprint(spec.cwd);
  if (fingerprint === null) return null;

  return hash({
    engine: engine.name,
    model: engine.modelFor(spec.rung.tier),
    effort: engine.supportsEffort(spec.rung.tier) ? (spec.rung.effort ?? null) : null,
    system,
    capabilities: [...spec.capabilities].sort(),
    prompt,
    schema: spec.outputSchema ?? null,
    lockedPaths: [...(spec.lockedPaths ?? [])].sort(),
    indexed: spec.indexed ?? false,
    // Both can truncate a result, so a run under a larger budget is a different
    // question from the same prompt under a smaller one.
    maxTurns: spec.maxTurns ?? DEFAULT_TURNS,
    maxBudgetUsd: spec.maxBudgetUsd ?? DEFAULT_BUDGET_USD,
    fingerprint,
  });
}
