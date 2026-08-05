/**
 * Conversation memory, owned by the harness rather than the provider.
 *
 * A chat session normally re-pays for its entire history on every turn. Here the
 * transcript lives in this process, and only a bounded recent slice is ever sent
 * — so a long session costs no more per turn than a short one.
 */

import type { Part } from './context/budget.ts';

const MAX_TURNS_SENT = 6;
const MAX_CHARS_PER_TURN = 400;

/**
 * How many facts ride along, most recent first to be dropped last.
 *
 * Bounded rather than removed, and the distinction is the whole point. *Less
 * Context, Better Agents* pruned history and cut stale-state errors from 47% to
 * 11% — but tripled premature terminations, 9 to 18, because an agent with no
 * record of what it had already done kept concluding it was finished. Adding a
 * summary of the earlier interactions back brought those down to 3. This list is
 * that summary; it is what makes a six-turn window safe to send. So it is capped,
 * not dropped.
 *
 * Most recent kept rather than oldest, because a fact here is a progress note —
 * "fixed off-by-one in cart.js:12" — and the recent ones describe where the work
 * actually stands.
 */
const MAX_FACTS_SENT = 10;

/**
 * A long turn, kept at both ends rather than truncated at one.
 *
 * This used to keep the first 400 characters and discard the rest, which threw
 * away the wrong end twice over. A stage is told to answer with no preamble and
 * to close with one line per file changed, so the conclusion — the part naming
 * what was actually done — is exactly what fell off. And it is the end of a span
 * that a model attends to best: Lost in the Middle finds material buried
 * mid-context costs upwards of 30% against the same material at either edge, so
 * head-only truncation was manufacturing a middle out of the strongest region.
 *
 * The halves sum to {@link MAX_CHARS_PER_TURN}, so this buys the ending back at
 * no extra tokens beyond the marker.
 */
const TURN_EDGE_CHARS = MAX_CHARS_PER_TURN / 2;
const ELISION = ' … ';

export interface Turn {
  readonly role: 'user' | 'sumo';
  readonly text: string;
}

export class Conversation {
  private readonly turns: Turn[] = [];
  /** Artifacts produced this session, referenced by later turns. */
  private readonly facts: string[] = [];

  add(role: Turn['role'], text: string): void {
    this.turns.push({ role, text: text.trim() });
  }

  /** Records a durable outcome, e.g. "fixed off-by-one in cart.js:12". */
  note(fact: string): void {
    this.facts.push(fact);
  }

  clear(): void {
    this.turns.length = 0;
    this.facts.length = 0;
  }

  get length(): number {
    return this.turns.length;
  }

  /**
   * What this session contributes to a prompt, as units the budget may drop.
   *
   * Two parts rather than one per fact and one per turn, which is a deliberate
   * choice of granularity. `fit` will shed parts one at a time if given them
   * that way, but both blocks carry a heading that would be left dangling over
   * nothing once the last entry beneath it went — and a heading introducing an
   * empty list is worse than no heading, because it reads as "there was nothing
   * earlier in this session" rather than as an omission. Both are already
   * bounded in their own right, so all-or-nothing costs little.
   *
   * The facts sitting first is why they had to be capped at all. This block is
   * prepended, so an unbounded list at the top of it pushes the recent exchange
   * and the index's pack steadily further from the edges — into the middle,
   * which is the position models read worst.
   */
  parts(): readonly Part[] {
    const out: Part[] = [];

    const facts = this.facts.slice(-MAX_FACTS_SENT);
    if (facts.length > 0) {
      out.push({
        region: 'facts',
        text: `Earlier in this session:\n${facts.map((f) => `- ${f}`).join('\n')}\n\n`,
      });
    }

    const recent = this.turns.slice(-MAX_TURNS_SENT);
    if (recent.length > 0) {
      const lines = recent.map((t) => `${t.role === 'user' ? 'User' : 'You'}: ${abridge(t.text)}`);
      out.push({ region: 'turns', text: `Recent exchange:\n${lines.join('\n')}\n\n` });
    }

    return out;
  }

  /**
   * The same material as one string, for the call paths that build their prompt
   * in advance rather than handing the harness its ingredients.
   *
   * Derived from {@link parts} rather than assembled separately, so the two can
   * never drift into describing different sessions.
   */
  contextBlock(): string {
    return this.parts()
      .map((p) => p.text)
      .join('');
  }
}

/** A turn cut to length from the middle, keeping both edges. See {@link TURN_EDGE_CHARS}. */
function abridge(text: string): string {
  if (text.length <= MAX_CHARS_PER_TURN) return text;
  return `${text.slice(0, TURN_EDGE_CHARS)}${ELISION}${text.slice(-TURN_EDGE_CHARS)}`;
}
