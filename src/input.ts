/**
 * The single way anything in sumo reads a line from the user.
 *
 * Sharing one reader is required, not merely tidy. A readline interface
 * delivers each line exactly once, to whoever happens to be listening: with two
 * consumers (a main loop and an approval gate) one of them silently starves.
 * Worse, a piped stdin emits every line at once — while the harness is busy
 * running a stage, with nothing listening — and those lines are gone.
 *
 * So lines are queued the moment they arrive and handed out on demand. That
 * makes piped sessions work exactly like typed ones, and lets a user type ahead
 * while a stage is still running.
 *
 * On a terminal the reader also owns how typing looks. `readline` is created
 * with no `output`, so it runs the line editor but draws nothing, and the live
 * region draws the buffer instead — see src/statusbar.ts for why. Without that,
 * `readline` echoed keystrokes wherever the cursor happened to be, which during
 * a streaming stage was the middle of the model's own output: typing to a
 * running task produced garbage, so in practice there was no way to say
 * anything to one.
 */

import type { Interface } from 'node:readline/promises';
import pc from 'picocolors';
import * as statusbar from './statusbar.ts';

export class LineReader {
  private readonly queue: string[] = [];
  private waiting: ((line: string | null) => void) | null = null;
  private ended = false;
  /** True when this reader draws the input line itself. */
  private readonly live: boolean;
  /** The prompt currently on screen, so a submitted line can be echoed under it. */
  private prompt = '';

  constructor(rl: Interface, live = false) {
    this.live = live;

    if (live) {
      // `keypress` fires for every edit — insertions, deletions, and cursor
      // moves alike — so mirroring the buffer here keeps the drawn line and the
      // editor's idea of it from ever disagreeing.
      process.stdin.on('keypress', () => {
        statusbar.setInput(rl.line, rl.cursor);
      });

      // In raw mode readline intercepts Ctrl-C, so this is the only handler
      // that runs. It clears what is half-typed rather than ending the session:
      // losing a session's ledger and conversation to a keystroke aimed at a
      // stray line is a bad trade. Pressed again with nothing to clear, it does
      // what everyone expects it to.
      let armed = false;
      rl.on('SIGINT', () => {
        if (rl.line.length > 0) {
          // Kill-line is how readline is told to discard its buffer; there is
          // no public setter for it.
          rl.write(null, { ctrl: true, name: 'u' });
          statusbar.setInput(rl.line, rl.cursor);
          armed = false;
          return;
        }

        if (armed) {
          statusbar.disable();
          process.stdout.write('\n');
          process.exit(130);
        }
        armed = true;
        process.stdout.write(pc.dim('\n  ctrl-c again to quit, or /exit\n'));
      });
    }

    rl.on('line', (line: string) => {
      const waiter = this.waiting;
      if (waiter) {
        this.commitAnswer(line);
        this.waiting = null;
        waiter(line);
      } else {
        this.queue.push(line);
        this.commitQueued(line);
      }
      if (this.live) statusbar.setInput('', 0);
    });

    rl.on('close', () => {
      this.ended = true;
      const waiter = this.waiting;
      if (waiter) {
        this.waiting = null;
        waiter(null);
      }
    });
  }

  /**
   * Puts a submitted answer into the scrollback.
   *
   * The live region is transient by design — it is erased before anything else
   * prints — so a line that was only ever drawn there would vanish the moment
   * the harness replied. What you said has to stay above what it said back.
   */
  private commitAnswer(line: string): void {
    if (this.live) {
      process.stdout.write(`${this.prompt}${line}\n`);
      return;
    }
    // A terminal echoes what you type; a pipe does not. Without this the prompt
    // sits with nothing after it and whatever prints next runs into it.
    if (!process.stdin.isTTY) process.stdout.write(`${line}\n`);
  }

  /**
   * Acknowledges a line typed while the harness was busy.
   *
   * Saying so at the moment it is sent is the difference between a harness that
   * takes messages during a task and one that appears to ignore them. Where it
   * goes next depends on the turn — a steer for a staged workflow, the next
   * message otherwise — and both happen at the same moment, so one sentence
   * covers them.
   */
  private commitQueued(line: string): void {
    if (!this.live || line.trim().length === 0) return;
    process.stdout.write(
      `${pc.cyan('  ↳ ')}${line}\n${pc.dim('    queued — picked up when this stage ends\n')}`,
    );
  }

  /**
   * Takes everything typed so far without waiting for more.
   *
   * This is how a running task notices that you said something. Typing while a
   * stage works used to leave the line sitting in the queue until the next
   * `ask`, which was usually an approval gate — so a passing thought became the
   * answer to a question you had not been shown yet.
   */
  drain(): string[] {
    return this.queue.splice(0, this.queue.length);
  }

  /** Whether anything is waiting to be read. */
  get pending(): boolean {
    return this.queue.length > 0;
  }

  /** Opens the input line for a running task, so typing is possible and visible. */
  openSteering(): void {
    if (this.live) statusbar.openInput(pc.dim('› '));
  }

  /** Closes the input line. */
  closeInput(): void {
    if (this.live) statusbar.openInput(null);
  }

  /** Reads one line. Resolves null once input has ended and the queue is dry. */
  ask(prompt: string): Promise<string | null> {
    this.prompt = prompt;

    const buffered = this.queue.shift();
    if (buffered !== undefined) {
      // Echo the prompt *and* the answer, so a transcript reads like a typed
      // session: a terminal echoes what you type, a pipe does not.
      process.stdout.write(`${prompt}${buffered}\n`);
      return Promise.resolve(buffered);
    }

    if (this.ended) return Promise.resolve(null);

    if (this.live) {
      statusbar.openInput(prompt);
    } else {
      process.stdout.write(prompt);
    }

    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
}
