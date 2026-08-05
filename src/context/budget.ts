/**
 * How much prompt a stage may be built from.
 *
 * An absolute ceiling rather than a share of the model's context window, which
 * is the counter-intuitive part and the part that carries the evidence. FLenQA
 * holds a task fixed and pads its input: mean accuracy falls 0.92 → 0.68 by
 * 3,000 tokens, with the decline already visible around 500. That is a fact
 * about how much text a model can attend to, not about how much it will accept —
 * so a budget expressed as a fraction of an advertised window would grant a
 * million-token model two hundred thousand tokens of prompt and call it
 * headroom. The window appears here only as a cap that should never bind.
 *
 * The other half of the design is that going over budget drops *whole* units,
 * lowest value first, and says which. A half-rendered table is worse than an
 * absent one, because the model reads it as complete; and a drop nobody
 * announced is worse still. ConstraintRot measured that second failure directly
 * — a policy constraint that survived a summary was violated 0% of the time and
 * one that was dropped 38%, with nothing at the moment of dropping to tell the
 * two runs apart.
 */

import type { Work } from '../engine/aptitude.ts';
import { estimateTokensFromChars } from '../profile.ts';

/** The kinds of material a prompt is built from, in the order they are assembled. */
export type Region = 'facts' | 'turns' | 'pack' | 'task' | 'instructions';

/**
 * One droppable unit of a prompt.
 *
 * The caller chooses the granularity by how finely it splits: one `facts` part
 * per fact means facts are shed one at a time, a single part holding all of them
 * means they go together. Nothing here ever cuts inside a part.
 */
export interface Part {
  readonly region: Region;
  readonly text: string;
}

/**
 * Assembly order, and the reason it is fixed here rather than left to callers.
 *
 * Lost in the Middle finds material buried mid-context costs upwards of 30%
 * against the same material at either edge, and FLenQA agrees the strong
 * positions are the beginning and the end. The task and its instructions are the
 * part that must not be missed, so they take the end — `instructions` last, as
 * an invariant a caller cannot get wrong by passing its parts in a different
 * order.
 */
const ORDER: readonly Region[] = ['facts', 'turns', 'pack', 'task', 'instructions'];

/**
 * The ceiling for each kind of work, in estimated tokens.
 *
 * **Starting points, not derived constants.** They are placed by what each stage
 * is for, and the thing that corrects them is `sumo bench` over the fixtures —
 * judged on task success and cost, not on token count, because HELMET's finding
 * is that recall-style scores do not predict downstream performance. If success
 * falls, these numbers are wrong; the shape of the design is not.
 *
 * Keyed on {@link Work} rather than a taxonomy of its own, deliberately. That is
 * already the axis model selection reasons about in `engine/aptitude.ts`, and
 * one definition is what keeps "which model runs this" and "how much may it be
 * told" from drifting into disagreeing about what a stage is.
 */
const CEILING: Record<Work, number> = {
  classify: 1_000, // the question and nothing else; this stage exists to be cheap
  survey: 12_000, // explore/evidence — breadth is the product
  reason: 8_000, // root-cause/plan/judge — precision over breadth
  edit: 6_000, // fix/implement — the plan and the failures, nothing more
  research: 4_000, // the answer is on the web, not in the prompt
};

/**
 * A backstop for a hypothetically tiny window, not a policy.
 *
 * On the current catalogue the smallest window is 128,000 tokens, so this never
 * binds and the ceiling above is always what applies. It exists so that a model
 * whose window is genuinely smaller than its ceiling cannot be handed a prompt
 * it must refuse.
 */
const WINDOW_SHARE = 0.5;

/** The ceiling for one stage, in estimated tokens. */
export function budgetFor(work: Work, window: number): number {
  return Math.min(CEILING[work], Math.floor(window * WINDOW_SHARE));
}

/**
 * Parts assembled into a prompt, in region order and with nothing dropped.
 *
 * Joined with nothing between them: a part carries its own trailing whitespace,
 * so this is byte-identical to the string a caller would have concatenated by
 * hand. That is what lets a call path be converted to parts without invalidating
 * a single cached stage.
 *
 * Shared with {@link fit} rather than reimplemented beside it, so a caller
 * holding the unbudgeted rendering and the harness holding the budgeted one can
 * never disagree about anything except what was dropped.
 */
export function render(parts: readonly Part[]): string {
  return ORDER.flatMap((region) => parts.filter((p) => p.region === region))
    .map((p) => p.text)
    .join('');
}

/**
 * A stage's prompt as both its ingredients and its finished text.
 *
 * Spread straight into a stage spec, which needs both: `parts` for the harness
 * to fit once it knows the model, and `prompt` because that field is required
 * and every unconverted caller still supplies one. Deriving the second from the
 * first is what stops a spec from describing two different questions — and doing
 * it in an expression rather than a statement is what lets a call site adopt this
 * without hoisting anything out of the object literal it already sits in, which
 * on the workflow stages would mean running a git command for a stage that is
 * about to be skipped.
 */
export function assembled(parts: readonly Part[]): {
  readonly parts: readonly Part[];
  readonly prompt: string;
} {
  return { parts, prompt: render(parts) };
}

/**
 * Fits parts to the budget, dropping whole low-priority units.
 *
 * Priority runs least-valuable first: facts, then turns, then the pack. Within
 * facts and turns the oldest go first, because the recent ones describe where
 * the work stands. Within the pack the *trailing* ones go first, because the
 * index already ranked it and the tail is what it ranked lowest.
 *
 * `task` and `instructions` are never dropped. When they alone exceed the
 * budget, this returns them over budget rather than mutilating the request —
 * a stage asked half a question fails in a way nobody can read, where an
 * expensive stage merely costs money. The overage is visible either way, in the
 * `composition` the stage runner records.
 */
export function fit(
  parts: readonly Part[],
  budget: number,
): { readonly text: string; readonly dropped: readonly Region[] } {
  const ordered = ORDER.flatMap((region) => parts.filter((p) => p.region === region));

  const at = (region: Region): number[] =>
    ordered.flatMap((p, i) => (p.region === region ? [i] : []));
  const queue = [...at('facts'), ...at('turns'), ...at('pack').reverse()];

  const removed = new Set<number>();
  const dropped: Region[] = [];
  let chars = ordered.reduce((n, p) => n + p.text.length, 0);

  for (const i of queue) {
    if (estimateTokensFromChars(chars) <= budget) break;
    const part = ordered[i]!;
    removed.add(i);
    chars -= part.text.length;
    if (!dropped.includes(part.region)) dropped.push(part.region);
  }

  return { text: render(ordered.filter((_, i) => !removed.has(i))), dropped };
}
