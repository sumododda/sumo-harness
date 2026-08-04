/**
 * Conversation memory, owned by the harness rather than the provider.
 *
 * A chat session normally re-pays for its entire history on every turn. Here the
 * transcript lives in this process, and only a bounded recent slice is ever sent
 * — so a long session costs no more per turn than a short one.
 */

const MAX_TURNS_SENT = 6;
const MAX_CHARS_PER_TURN = 400;

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
   * The context block prepended to a turn. Bounded in both directions: at most
   * a handful of turns, each truncated, so this never grows without limit.
   */
  contextBlock(): string {
    if (this.turns.length === 0 && this.facts.length === 0) return '';

    const parts: string[] = [];

    if (this.facts.length > 0) {
      parts.push(`Earlier in this session:\n${this.facts.map((f) => `- ${f}`).join('\n')}`);
    }

    const recent = this.turns.slice(-MAX_TURNS_SENT);
    if (recent.length > 0) {
      const lines = recent.map((t) => {
        const who = t.role === 'user' ? 'User' : 'You';
        const text =
          t.text.length > MAX_CHARS_PER_TURN
            ? `${t.text.slice(0, MAX_CHARS_PER_TURN)}…`
            : t.text;
        return `${who}: ${text}`;
      });
      parts.push(`Recent exchange:\n${lines.join('\n')}`);
    }

    return `${parts.join('\n\n')}\n\n`;
  }
}
