/**
 * The stage runner: one unit of model work, with its permissions, budget, and
 * accounting all decided by the harness before the model is invoked.
 *
 * Workflows compose stages; only this module talks to an Engine.
 */

import pc from 'picocolors';
import * as cache from './cache.ts';
import { workOf } from './engine/aptitude.ts';
import type { Capability } from './engine/index.ts';
import { Fleet } from './engine/fleet.ts';
import type { EventSink } from './engine/types.ts';
import { budgetFor, fit, type Part } from './context/budget.ts';
import type { Progress } from './progress.ts';
import type { Steering } from './steer.ts';
import * as features from './features.ts';
import { buildGate } from './gate-tools.ts';
import { hash, repoFingerprint } from './hash.ts';
import type { Ledger } from './ledger.ts';
import { estimateTokens, estimateTokensFromChars } from './profile.ts';
import { systemPrompt } from './prompts.ts';
import { money } from './ui.ts';
import { describeRung, type Rung, type StageResult } from './types.ts';

export interface StageSpec {
  readonly name: string;
  readonly prompt: string;
  /**
   * The prompt's ingredients, when the caller wants it assembled against the
   * routed model's budget rather than built in advance.
   *
   * Assembly has to happen after routing or the budget is unknowable: a stage
   * that lands on a small model would otherwise receive a prompt sized for a
   * large one, which is precisely the case where it hurts most — ACON finds
   * compressing the context helps small models by up to 46%, because they are
   * the ones that get distracted by the surplus.
   *
   * Additive. `prompt` stays required and keeps working exactly as before; when
   * `parts` is present it is what actually runs.
   */
  readonly parts?: readonly Part[];
  readonly rung: Rung;
  /**
   * A system prompt to use instead of the harness's own.
   *
   * For stages that are not coding stages. The default describes a coding agent
   * working in a repository, which is the right frame for every stage that
   * touches code and an expensive one for a stage that only reads its own
   * prompt — see {@link CLASSIFIER_ROLE}. Already part of the cache key, so an
   * override cannot replay an answer produced under the default.
   */
  readonly system?: string;
  readonly capabilities: readonly Capability[];
  /**
   * True when the harness already searched the web for this stage and put the
   * results in the prompt. Withholds the provider's own search — see
   * {@link StageRequest.searched}.
   */
  readonly searched?: boolean;
  readonly cwd: string;
  /** Absent means read-only: the gate refuses every write. */
  readonly allowWrites?: boolean;
  /** Files that must not change even in a writable stage. */
  readonly lockedPaths?: readonly string[];
  readonly maxTurns?: number;
  readonly maxBudget?: number;
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

/**
 * The window assumed when routing lands on a model the catalogue cannot
 * describe — a Copilot plan offering only `auto`, say.
 *
 * Set to the smallest window any catalogued model actually has rather than to a
 * cautious guess, because the window is only ever a cap here and every ceiling
 * in `context/budget.ts` is an order of magnitude below half of this. So this
 * number does not decide anything; it simply declines to invent a *lower* limit
 * for an unknown model than the known ones have, which would starve a blind
 * provider's stages on no evidence at all.
 */
const FALLBACK_WINDOW = 128_000;

/**
 * There is no default spending cap on a stage, deliberately.
 *
 * There was one, of a dollar, and it did the opposite of what a cap is for. A
 * stage that answers in a schema produces nothing until it produces the whole
 * thing, so being cut off part-way did not buy a cheaper answer — it bought a
 * dollar of reading and thinking, discarded, and a retry that began again from
 * nothing. The cap turned an expensive stage into an expensive stage that also
 * failed.
 *
 * What bounds a stage is {@link DEFAULT_TURNS}: a limit on how much it may do,
 * which is something it can finish inside. A caller that genuinely wants a
 * ceiling still passes `maxBudget` — `sumo do --budget` does, and so does
 * the routing classifier, where two cents is the whole point of the call.
 */

export async function runStage(
  fleet: Fleet,
  spec: StageSpec,
  ledger: Ledger,
): Promise<StageResult> {
  const allowWrites = spec.allowWrites ?? false;

  // Resolved here for the same reason steering and progress are: a stage begins
  // in exactly one place, so this is the only place that can guarantee every
  // stage was routed, and routed against what it actually needs rather than
  // against what its workflow assumed it would need.
  const { engine, model: routedModel, why: routedWhy } = await fleet.for({
    tier: spec.rung.tier,
    stage: spec.name,
    needsSchema: spec.outputSchema !== undefined,
    capabilities: spec.capabilities,
    ...(spec.rung.effort ? { effort: spec.rung.effort } : {}),
  });

  // Named only when there was a choice to make. A one-provider fleet has no
  // decision worth reporting, and saying "only provider" on every line would
  // bury the case where routing actually did something.
  const route = fleet.providers.length > 1 ? ` · ${engine.name}: ${routedWhy}` : '';

  if (spec.progress) {
    spec.progress.begin(spec.name);
    if (route) process.stderr.write(pc.dim(` ${route.slice(3)}\n`));
  } else if (!spec.onEvent) {
    // Quiet runs still say which stage is working, just without the route.
    process.stderr.write(
      pc.dim(
        `→ ${spec.name} (${describeRung(spec.rung)}${allowWrites ? '' : ', read-only'})${route}\n`,
      ),
    );
  }

  // Assembled here rather than by the caller, because this is the first point at
  // which the budget is knowable — the model was chosen four lines ago.
  const budget = budgetFor(workOf(spec.name), routedModel?.contextWindow ?? FALLBACK_WINDOW);
  const assembled = spec.parts ? fit(spec.parts, budget) : null;
  if (assembled && assembled.dropped.length > 0) {
    // Said out loud, always. A prompt quietly shortened is indistinguishable
    // from one that was never that long, which is the failure this whole
    // mechanism exists to prevent rather than to commit more neatly.
    process.stderr.write(pc.dim(`  context over budget — dropped ${assembled.dropped.join(', ')}\n`));
  }

  // Picked up before the key is built, so a steered stage is a different
  // question and can never be answered from the cache by an unsteered one.
  const steered = spec.steer?.takeAsPrompt() ?? '';
  const base = assembled?.text ?? spec.prompt;
  const prompt = steered ? `${base}\n${steered}` : base;

  const system = spec.system ?? systemPrompt(spec.cwd, allowWrites);
  const composition = {
    system: estimateTokens(system),
    prompt: estimateTokens(prompt),
    pack: estimateTokensFromChars(spec.packChars ?? 0),
  };

  const key = await cacheKeyFor(
    engine,
    spec,
    prompt,
    system,
    routedModel?.id ?? engine.modelFor(spec.rung.tier),
  );
  if (key) {
    const hit = cache.read<StageResult>(spec.cwd, key);
    if (hit) {
      const replayed: StageResult = {
        ...hit,
        cost: 0,
        cached: true,
        saved: hit.cost,
        composition,
        ...(spec.attempt !== undefined ? { attempt: spec.attempt } : {}),
      };
      // Nothing streamed, so replay the answer through the same sink the live
      // path uses. Otherwise a cache hit would look like the harness hung.
      if (replayed.output.length > 0) {
        spec.onEvent?.({ kind: 'text', text: replayed.output });
      }
      ledger.add(replayed);
      spec.progress?.done('', 0, replayed.costUnit, true);
      return replayed;
    }
  }

  const tally = { edit: 0, write: 0 };

  const raw = await engine.runStage({
    stage: spec.name,
    prompt,
    systemPrompt: system,
    rung: spec.rung,
    ...(routedModel ? { model: routedModel.id } : {}),
    capabilities: spec.capabilities,
    ...(spec.searched ? { searched: true } : {}),
    cwd: spec.cwd,
    maxTurns: spec.maxTurns ?? DEFAULT_TURNS,
    ...(spec.maxBudget !== undefined ? { maxBudget: spec.maxBudget } : {}),
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
    // Recorded whenever the stage was *allowed* to write, including when it
    // wrote nothing. Omitting a zero was how a stage that changed no files came
    // to be reported by its own summary alone: a Copilot `/do` explored the
    // repository, never called an edit tool, and answered "README.md —
    // documented the new flags". Nothing on screen disagreed, because the only
    // thing that could have was left off for being zero. A writable stage that
    // wrote nothing is exactly the case worth printing.
    ...(allowWrites ? { writeTools: tally } : {}),
    ...(spec.attempt !== undefined ? { attempt: spec.attempt } : {}),
  };

  ledger.add(result);
  spec.progress?.done(summarize(result), result.cost, result.costUnit);

  // Only a stage that ran to completion is worth replaying. A truncated one
  // would be reused forever at the length its budget happened to allow.
  if (key && result.stopped === undefined) {
    const { sessionId: _sessionId, ...storable } = result;
    cache.write(spec.cwd, key, storable);
  }

  if (result.stopped === 'budget') {
    const ceiling = spec.maxBudget === undefined ? '' : `${money(spec.maxBudget, engine.costUnit)} `;
    process.stderr.write(pc.yellow(`  stage hit its ${ceiling}budget\n`));
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
    else parts.push(pc.yellow('no files changed'));
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
  engine: import('./engine/types.ts').Engine,
  spec: StageSpec,
  /** The prompt as actually sent, steers included. */
  prompt: string,
  /** The system prompt as actually sent — passed rather than rebuilt, so the
   * key can never describe a different prompt from the one the stage ran. */
  system: string,
  /**
   * The model routing chose, when it chose one.
   *
   * Passed rather than re-derived from the engine, because routing can land on
   * a different model from the engine's default — an organisation disabling one
   * is enough — and a key naming the default would let an answer from one model
   * be replayed as though it came from another.
   */
  model: string,
): Promise<string | null> {
  if (!cache.isEnabled()) return null;
  if (spec.allowWrites === true) return null;
  if (spec.capabilities.includes('git')) return null;

  const fingerprint = await repoFingerprint(spec.cwd);
  if (fingerprint === null) return null;

  return hash({
    engine: engine.name,
    model,
    effort: engine.supportsEffort(spec.rung.tier) ? (spec.rung.effort ?? null) : null,
    system,
    capabilities: [...spec.capabilities].sort(),
    prompt,
    schema: spec.outputSchema ?? null,
    lockedPaths: [...(spec.lockedPaths ?? [])].sort(),
    indexed: spec.indexed ?? false,
    // Both can truncate a result, so a run under a larger budget is a different
    // question from the same prompt under a smaller one. `null` is its own
    // value here: uncapped and capped-at-some-number are not the same question.
    maxTurns: spec.maxTurns ?? DEFAULT_TURNS,
    maxBudget: spec.maxBudget ?? null,
    fingerprint,
  });
}
