/**
 * Where a task is, and what is coming next.
 *
 * A workflow used to render as an undifferentiated stream of tool calls: forty
 * lines of `glob` and `read` with no indication that they belonged to two
 * separate stages, that the first had finished, or that an approval was waiting
 * at the end. The work was legible only to someone who already knew the
 * pipeline by heart.
 *
 * Every staged workflow has a fixed shape, known before it starts, so it can
 * simply be stated: print the route once, then say which leg is running. None
 * of this costs a token — it is all harness-side knowledge the user never had
 * access to.
 */

import pc from 'picocolors';
import * as statusbar from './statusbar.ts';
import type { CostUnit } from './types.ts';
import { money } from './ui.ts';

export interface Step {
  /** Matches the stage name used in the ledger. */
  readonly name: string;
  /** What this step is for, in a few words. */
  readonly blurb: string;
  /** True when the harness stops here and waits for the operator. */
  readonly gate?: boolean;
}

/**
 * The route each workflow takes.
 *
 * Retries and revisions can repeat a leg, so this is the shape rather than a
 * guaranteed sequence — which is exactly what someone watching wants to know.
 */
export const ROUTES: Record<string, readonly Step[]> = {
  plan: [
    { name: 'explore', blurb: 'survey what already exists' },
    { name: 'plan', blurb: 'write the proposal' },
    { name: 'approval', blurb: 'your call', gate: true },
    { name: 'build', blurb: 'hand off to feature' },
  ],
  fix: [
    { name: 'evidence', blurb: 'gather evidence, read-only' },
    { name: 'root-cause', blurb: 'name the cause, citing evidence' },
    { name: 'approval', blurb: 'your call', gate: true },
    { name: 'fix', blurb: 'apply the minimal change' },
    { name: 'verify', blurb: 'run the tests' },
  ],
  feature: [
    { name: 'explore', blurb: 'survey what already exists' },
    { name: 'plan', blurb: 'write the proposal' },
    { name: 'approval', blurb: 'your call', gate: true },
    { name: 'write-tests', blurb: 'tests first, and prove they fail' },
    { name: 'implement', blurb: 'make them pass, tests locked' },
    { name: 'verify', blurb: 'run the tests' },
  ],
};

/**
 * The route on one line, printed when a task starts.
 *
 * Colours are applied per step rather than around the whole line: nesting one
 * dim inside another closes the first reset early and leaves an escape sequence
 * dangling at the end.
 */
export function roadmap(mode: string): string {
  const steps = ROUTES[mode];
  if (!steps) return '';
  const route = steps
    .map((s) => (s.gate ? pc.cyan(s.name) : pc.dim(s.name)))
    .join(pc.dim(' → '));
  return `  ${route}\n`;
}

/**
 * Tracks which leg of the route is running.
 *
 * Positions are looked up by stage name rather than counted, because a retry or
 * a revision re-runs a stage the route already lists — counting would drift
 * past the end after the first escalation.
 */
export class Progress {
  private readonly steps: readonly Step[];
  private startedAt = 0;
  private current: Step | undefined;

  constructor(mode: string) {
    this.steps = ROUTES[mode] ?? [];
  }

  /** Announces a stage and starts its clock. */
  begin(name: string): void {
    const index = this.steps.findIndex((s) => s.name === name);
    this.current = index >= 0 ? this.steps[index] : { name, blurb: '' };
    this.startedAt = Date.now();

    const position = index >= 0 ? `${index + 1}/${this.steps.length}` : '·';
    const blurb = this.current?.blurb ? pc.dim(` — ${this.current.blurb}`) : '';
    process.stdout.write(`\n${pc.cyan('▸')} ${pc.bold(name)} ${pc.dim(position)}${blurb}\n`);
    statusbar.activity(index >= 0 ? `${name} ${position}` : name);
  }

  /**
   * Closes the current stage with what it produced and what it cost.
   *
   * `summary` is the stage's own words for what it found — "4 files, 2 reusable
   * helpers" — which is the part that tells you whether to keep going.
   */
  done(summary: string, cost: number, unit: CostUnit, cached = false): void {
    const finished = this.current;
    if (!finished) return;

    const seconds = Math.max(0, Math.round((Date.now() - this.startedAt) / 1000));
    const price = cached ? 'reused' : money(cost, unit);
    process.stdout.write(
      `  ${pc.green('✓')} ${summary ? `${summary}  ` : ''}${pc.dim(`${seconds}s · ${price}`)}\n`,
    );
    // Said here rather than left to each workflow, so "what now" is answered
    // every time rather than only where someone remembered to answer it.
    process.stdout.write(this.upNext(finished.name));
    this.current = undefined;

    // A gate is the one place the harness genuinely stops, so the bar should
    // say so rather than leave a clock ticking on work that is not happening.
    const next = this.upNext(finished.name);
    statusbar.activity(next.includes('waits for you') ? 'waiting for you' : 'thinking');
  }

  /**
   * What happens after the step just finished. Empty at the end of the route.
   *
   * A hint, not a contract: a failed verification sends the route back to an
   * earlier leg, and the header printed when that leg starts is the truth.
   */
  upNext(name: string): string {
    const index = this.steps.findIndex((s) => s.name === name);
    const next = index >= 0 ? this.steps[index + 1] : undefined;
    if (!next) return '';
    return pc.dim(`  next: ${next.name}${next.gate ? ' — waits for you' : ''}\n`);
  }
}
