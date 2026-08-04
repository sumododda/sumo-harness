/**
 * The approval gate: where the harness stops and hands the decision to you.
 *
 * Gates are the reason a staged workflow is not just a prompt asking nicely.
 * Nothing downstream of a gate runs until it returns `approved`.
 */

import pc from 'picocolors';
import type { LineReader } from './input.ts';
import * as statusbar from './statusbar.ts';
import type { Steering } from './steer.ts';

export type GateDecision =
  | { readonly kind: 'approved' }
  | { readonly kind: 'rejected' }
  /** A question about the proposal — answer it, then ask again. */
  | { readonly kind: 'discuss'; readonly question: string }
  | { readonly kind: 'revise'; readonly feedback: string };

/**
 * Distinguishes "explain this to me" from "change this".
 *
 * The rule is a question mark, and nothing else. That is deliberately less
 * clever than reading the phrasing: an earlier version guessed from sentence
 * shape and got roughly a third of real answers wrong, always in the same
 * direction — "do it in one file", "have a look at rank.ts first" and "can you
 * use a Map instead" were all read as questions, answered, and the proposal left
 * untouched. Being told what to change and having nothing change is the worst
 * failure a gate can have.
 *
 * A visible rule you control beats an invisible one that is usually right. The
 * grammar is printed above every prompt, so what will happen is knowable before
 * the key is pressed.
 */
function isQuestion(text: string): boolean {
  return text.endsWith('?');
}

const YES = new Set(['y', 'yes', 'ok', 'okay', 'sure', 'go', 'go ahead']);
const NO = new Set(['n', 'no', 'stop', 'q', 'quit', 'abort', 'cancel']);

/** Empty answers in a row before the gate gives up waiting. */
const MAX_EMPTY = 3;

export interface GateOptions {
  /** Heading shown above the artifact, e.g. "Root cause". */
  readonly title: string;
  /**
   * Anything typed while the stage before this gate was running.
   *
   * Without this, those lines sat in the input queue and the gate read the first
   * one as its answer — so a passing thought became a decision the operator was
   * never shown. They are a revision, not a verdict.
   */
  readonly steer?: Steering;
  /**
   * The proposal, when it has not already been shown. Omit it for content the
   * user just watched stream past — reprinting it verbatim is only noise.
   */
  readonly body?: string;
  /** Extra blocks shown before the question, e.g. a diff or a repro command. */
  readonly attachments?: readonly { readonly label: string; readonly text: string }[];
  /** Warnings that must be read before approving. */
  readonly warnings?: readonly string[];
}

/**
 * Presents a proposal and waits. Typed text is treated as revision feedback,
 * so the natural reaction to a wrong plan — explaining what is wrong — does the
 * right thing without needing a command.
 */
export async function askApproval(
  input: LineReader,
  opts: GateOptions,
  isTty: boolean,
  autoApprove: boolean,
): Promise<GateDecision> {
  // A gate is the one place the harness genuinely stops. Nothing is running, so
  // a spinner and a clock next to the question would be counting a wait rather
  // than reporting work — and would sit blinking beside what is being typed.
  statusbar.idle();

  // A stage that ends early — a budget, a turn limit, a provider error — answers
  // with nothing, and the gate would then print its question with a blank space
  // where the proposal should be and wait for a yes. Answering one sends the
  // blank straight into the stage that acts on it.
  //
  // Callers check this too, because they can say which stage failed and why.
  // The check is repeated here because it is the invariant that matters: a gate
  // asks the operator to take responsibility for a specific proposal, and there
  // is no such thing as taking responsibility for nothing.
  if (opts.body !== undefined && opts.body.trim().length === 0) {
    process.stdout.write(pc.yellow('\n  the stage before this gate produced nothing to approve\n'));
    return { kind: 'rejected' };
  }

  process.stdout.write(`\n${pc.bold(pc.cyan(opts.title))}\n`);
  if (opts.body !== undefined) process.stdout.write(`${indent(opts.body)}\n`);

  for (const attachment of opts.attachments ?? []) {
    process.stdout.write(`\n${pc.dim(attachment.label)}\n${indent(attachment.text)}\n`);
  }

  for (const warning of opts.warnings ?? []) {
    process.stdout.write(`${pc.yellow(`  ⚠ ${warning}`)}\n`);
  }

  if (autoApprove) {
    process.stdout.write(pc.dim('\n  auto-approved\n'));
    return { kind: 'approved' };
  }

  // No input source at all: fail closed rather than proceeding unattended.
  if (!isTty) {
    process.stdout.write(
      pc.yellow('\n  nothing to ask — stopping. Pass --yes to approve automatically.\n'),
    );
    return { kind: 'rejected' };
  }

  // Collected before anything is read, so a line typed during the previous
  // stage is treated as an instruction rather than as this gate's answer.
  const pending = opts.steer?.take() ?? [];
  if (pending.length > 0) {
    process.stdout.write(
      pc.cyan(`\n  taking that into account rather than asking — revising\n`),
    );
    return { kind: 'revise', feedback: pending.join('\n') };
  }

  // A gate is the one point where the harness needs a person and will wait
  // indefinitely without one. Nothing announced that, so a gate reached while
  // the operator was doing something else simply sat there — one sat open for
  // twenty-five minutes because there was no way to know it had opened.
  //
  // BEL is the terminal's own notification: it raises the tab in every
  // multiplexer and terminal worth using, and does nothing at all where it is
  // unwanted. Written only to a real terminal, since it is a control character
  // and a transcript should not carry one.
  if (process.stdout.isTTY) process.stdout.write('\x07');

  process.stdout.write(`\n${GRAMMAR}\n`);

  for (let empty = 0; ; ) {
    const raw = await input.ask(pc.bold('› '));

    // Input ended mid-question. Silence is not consent.
    if (raw === null) {
      process.stdout.write(pc.yellow('\n  input ended — stopping.\n'));
      return { kind: 'rejected' };
    }

    const answer = raw.trim();

    // Enter is not an answer, and must never be a destructive one. This used to
    // reject, which meant a stray keypress threw away the whole task.
    if (answer.length === 0) {
      empty += 1;
      if (empty >= MAX_EMPTY) {
        process.stdout.write(pc.yellow('  nothing entered — stopping.\n'));
        return { kind: 'rejected' };
      }
      process.stdout.write(`${GRAMMAR}\n`);
      continue;
    }

    const lowered = answer.toLowerCase();
    if (YES.has(lowered)) return { kind: 'approved' };
    if (NO.has(lowered)) return { kind: 'rejected' };

    // A bare "?" is someone asking about the prompt, not about the proposal.
    if (answer === '?' || lowered === 'help') {
      process.stdout.write(`${HELP}\n`);
      continue;
    }

    return isQuestion(answer)
      ? { kind: 'discuss', question: answer }
      : { kind: 'revise', feedback: answer };
  }
}

/** Printed above the prompt, so the rule is never something to remember. */
const GRAMMAR =
  `  ${pc.bold('y')} go ahead    ${pc.bold('n')} stop    ` +
  pc.dim(`${pc.bold('…?')} ask about it    ${pc.bold('…')} say what to change`);

const HELP = [
  '',
  `  ${pc.bold('y')}                  approve and continue`,
  `  ${pc.bold('n')}                  stop here; nothing further runs`,
  `  ${pc.dim('anything ending in')} ${pc.bold('?')}  answered without touching the proposal`,
  `  ${pc.dim('anything else')}      treated as a change to make`,
  '',
].join('\n');

function indent(text: string): string {
  return text
    .trimEnd()
    .split('\n')
    // Indenting a blank line only adds trailing whitespace.
    .map((l) => (l.length > 0 ? `  ${l}` : l))
    .join('\n');
}

/**
 * Caps how many times a proposal is rewritten before handing it back.
 *
 * Questions do not count against this — only actual revisions do.
 */
export const MAX_REVISIONS = 3;

export function rescopeHint(mode: string): string {
  return `${MAX_REVISIONS} revisions and still not right — ${mode} is likely under-specified. The proposal is saved; try narrowing it to one file or one behaviour.`;
}

/**
 * Why there is nothing to approve, said in terms of what actually went wrong.
 *
 * `stopped` carries the reason the stage ended early, and it is the whole
 * difference between "try again" and "this task needs a smaller scope": a
 * budget stop and a provider error want opposite responses from the operator.
 */
export function producedNothing(stage: string, stopped?: string): string {
  const because = stopped === undefined ? '' : ` (stopped: ${stopped})`;
  return `the ${stage} stage produced no answer${because} — nothing to approve, so nothing was changed`;
}
