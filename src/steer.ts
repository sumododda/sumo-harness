/**
 * Steering: what you type while a task is already running.
 *
 * The old behaviour was to leave those lines in the input queue until something
 * asked for one — which was almost always an approval gate, so a passing thought
 * ("also cover the empty-feed case") silently became the answer to a question
 * that had not been shown yet, and re-planned the work.
 *
 * The rule now is that a message sent during a task never stops it and never
 * answers anything. It is collected, shown back so it is never silently
 * swallowed, and folded into the next stage's instructions. The task keeps
 * going and takes the new request with it.
 *
 * Stage boundaries are the only place this can happen. A stage is one call to a
 * provider; there is no way to reach into the middle of one. That is a real
 * limit and worth stating plainly — a steer sent during a long stage applies to
 * the *next* one, not the one currently running.
 */

import pc from 'picocolors';
import type { LineReader } from './input.ts';

export class Steering {
  private readonly input: LineReader;
  /** Everything collected so far this task, for the end-of-task summary. */
  private readonly history: string[] = [];

  constructor(input: LineReader) {
    this.input = input;
  }

  /**
   * Collects anything typed since the last call.
   *
   * Slash commands are dropped: they address the session, not the task, and
   * folding "/cost" into a prompt as an instruction would be nonsense. Saying so
   * is better than silently obeying or silently discarding.
   */
  take(): string[] {
    const lines = this.input.drain().map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length === 0) return [];

    const steers: string[] = [];
    for (const line of lines) {
      if (line.startsWith('/')) {
        process.stdout.write(
          pc.dim(`  ignored while a task is running: ${line.split(/\s+/)[0]}\n`),
        );
        continue;
      }
      steers.push(line);
    }

    for (const steer of steers) {
      this.history.push(steer);
      process.stdout.write(pc.cyan(`  ↳ steering: ${steer}\n`));
    }
    return steers;
  }

  /**
   * The same thing, rendered for a prompt. Empty when nothing was typed.
   *
   * Marked as arriving mid-task so the model treats it as an addition to the
   * instruction it already has, rather than a replacement for it.
   */
  takeAsPrompt(): string {
    const steers = this.take();
    if (steers.length === 0) return '';
    return `\nThe operator added this while the task was running — apply it as well as everything above:\n${steers
      .map((s) => `- ${s}`)
      .join('\n')}\n`;
  }

  /** What was steered over the whole task, for the closing summary. */
  get applied(): readonly string[] {
    return this.history;
  }
}
