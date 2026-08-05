/**
 * The arrow-key editor behind `sumo models` and `/models`.
 *
 * Switching models one command at a time is fine for changing your mind about
 * one of them and miserable for setting up a roster: every `sumo models off X`
 * re-probes, re-renders, and makes you find the next id by eye. This is the
 * same decision made in one pass — move, toggle, save.
 *
 * Nothing is written until you save. That is the point of it rather than a
 * detail: a draft you can abandon means toggling something to see what it does
 * is free, where a command that takes effect immediately makes every keystroke
 * a commitment.
 *
 * Written against raw stdin rather than a prompt library because the harness
 * already owns this ground — `statusbar.ts` draws and erases its own block, and
 * `input.ts` runs a line editor with the drawing taken away from it — and one
 * more dependency to draw a list of checkboxes is a poor trade in a project
 * whose whole argument is about what things cost.
 */

import { emitKeypressEvents } from 'node:readline';
import pc from 'picocolors';
import { lastProbe, whyUnusable } from './engine/availability.ts';
import { candidates, undominated } from './engine/catalog.ts';
import type { ModelSpec } from './engine/catalog.ts';
import { disabledModels, turnOff, turnOn } from './engine/preferences.ts';
import type { Engine } from './engine/types.ts';
import type { Tier } from './types.ts';

const TIERS: readonly Tier[] = ['small', 'mid', 'large'];

/**
 * One line in the list: a heading, a blank, or a model that can be toggled.
 *
 * Every entry renders to exactly one terminal line, including the blanks, which
 * is what keeps redrawing correct. A heading that drew its own leading newline
 * would make one entry two lines, and the cursor-up that erases the block
 * counts entries — so the list would creep down the screen, leaving a copy of
 * itself behind on every keystroke.
 */
interface Line {
  readonly kind: 'provider' | 'tier' | 'model' | 'blank';
  readonly text: string;
  /** Set on model lines. */
  readonly key?: string;
  readonly model?: ModelSpec;
  /** Why it cannot be used at all, from the account rather than from you. */
  readonly blocked?: string | null;
  readonly dominated?: boolean;
}

export interface PickerHooks {
  /** Stops whatever else is reading stdin — the REPL's readline, in practice. */
  readonly pause?: () => void;
  readonly resume?: () => void;
}

function traits(m: ModelSpec): string {
  const parts: string[] = [];
  if (m.structuredOutput === true) parts.push('schema');
  if (m.efforts.length > 0) parts.push(`effort:${m.efforts.length}`);
  return parts.join(' ');
}

/**
 * The list, flattened.
 *
 * Dominance is computed against what the *draft* leaves on, so turning off the
 * model that was winning a tier immediately shows which one takes over — which
 * is the question anyone editing this list is actually asking.
 */
function build(engines: readonly Engine[], root: string, off: ReadonlySet<string>): Line[] {
  const lines: Line[] = [];

  for (const engine of engines) {
    const catalogued = engine.catalogName ?? engine.name;
    const probe = lastProbe(root, engine.name);
    if (lines.length > 0) lines.push({ kind: 'blank', text: '' });
    lines.push({ kind: 'provider', text: engine.name });

    for (const tier of TIERS) {
      const pool = candidates(catalogued, tier);
      if (pool.length === 0) continue;

      const live = pool.filter(
        (m) => whyUnusable(engine.name, m.id, probe) === null && !off.has(`${engine.name}:${m.id}`),
      );
      const kept = new Set(undominated(live).map((m) => m.id));

      lines.push({ kind: 'tier', text: tier });
      for (const model of pool) {
        lines.push({
          kind: 'model',
          text: model.id,
          key: `${engine.name}:${model.id}`,
          model,
          blocked: whyUnusable(engine.name, model.id, probe),
          dominated: kept.size > 0 && !kept.has(model.id),
        });
      }
    }
  }

  return lines;
}

function truncate(text: string, plainLength: number, width: number): string {
  if (plainLength <= width) return text;
  // Colour is only ever applied to whole segments here, so trimming the tail of
  // an already-styled string cannot cut an escape in half — the styled parts
  // are all to the left of the part that gets dropped.
  return `${text.slice(0, Math.max(0, width - 1))}…`;
}

function renderLine(line: Line, focused: boolean, off: ReadonlySet<string>, width: number): string {
  if (line.kind === 'blank') return '';
  if (line.kind === 'provider') return pc.bold(line.text);
  if (line.kind === 'tier') return pc.dim(`  ${line.text}`);

  const model = line.model;
  if (!model) return '';

  const unavailable = Boolean(line.blocked);
  const isOff = off.has(line.key ?? '');
  const box = unavailable ? '[-]' : isOff ? '[ ]' : '[x]';
  const cursor = focused ? '›' : ' ';
  const price = `$${String(model.outputPerMtok)}/M`.padStart(8);
  const note = unavailable
    ? ` · ${line.blocked ?? ''}`
    : line.dominated
      ? ' · beaten at this tier'
      : '';
  const id = model.id.padEnd(26);

  // Built once as plain text so its width is known, then styled segment by
  // segment. Measuring a string that already carries escapes counts characters
  // the terminal never draws, which is how a column ends up short by exactly
  // the length of a colour code.
  const plain = `  ${cursor} ${box} ${id} ${price}  ${traits(model)}${note}`;
  const styled =
    `  ${focused ? pc.cyan(cursor) : cursor} ` +
    (unavailable ? pc.dim(box) : isOff ? pc.dim(box) : pc.green(box)) +
    ` ${unavailable || isOff ? pc.dim(id) : focused ? pc.bold(id) : id}` +
    ` ${pc.dim(price)}  ${pc.dim(traits(model))}${pc.dim(note)}`;

  return truncate(styled, plain.length, width);
}

/**
 * Everything the editor knows, with no terminal attached.
 *
 * Split out because the interesting behaviour — where the cursor lands when it
 * skips an unavailable model, what a toggle does to the draft, which changes a
 * save produces — is decidable without a screen, and testing it through one
 * would mean driving arrow keys through a pty to assert on ANSI. The IO shell
 * below is then small enough to read: keys in, `draw()` out.
 */
export class PickerState {
  lines: Line[];
  focus: number;
  readonly initial: ReadonlySet<string>;
  readonly draft: Set<string>;

  // Declared rather than taken as parameter properties: `erasableSyntaxOnly` is
  // on, because Node strips these types rather than compiling them, and a
  // constructor parameter that declares a field is syntax with a runtime effect.
  private readonly engines: readonly Engine[];
  private readonly root: string;

  constructor(engines: readonly Engine[], root: string, disabled: ReadonlySet<string>) {
    this.engines = engines;
    this.root = root;
    this.initial = new Set(disabled);
    this.draft = new Set(disabled);
    this.lines = build(engines, root, this.draft);
    const first = this.lines.findIndex((l) => l.kind === 'model' && !l.blocked);
    this.focus = first === -1 ? 0 : first;
  }

  selectable(index: number): boolean {
    const line = this.lines[index];
    return line?.kind === 'model' && !line.blocked;
  }

  /** Moves to the next selectable row, or stays put at either end. */
  move(delta: number): void {
    let next = this.focus;
    for (let i = 0; i < this.lines.length; i += 1) {
      next += delta;
      if (next < 0 || next >= this.lines.length) return;
      if (this.selectable(next)) {
        this.focus = next;
        return;
      }
    }
  }

  toggle(): void {
    const line = this.lines[this.focus];
    if (!line?.key || line.blocked) return;
    if (this.draft.has(line.key)) this.draft.delete(line.key);
    else this.draft.add(line.key);
    // Dominance depends on what is left on, so the list is rebuilt rather than
    // patched — the marker that moves is the whole reason to look at this.
    this.lines = build(this.engines, this.root, this.draft);
  }

  /** How many toggles differ from what is on disk. */
  get pending(): number {
    let n = 0;
    for (const key of this.draft) if (!this.initial.has(key)) n += 1;
    for (const key of this.initial) if (!this.draft.has(key)) n += 1;
    return n;
  }

  /** Writes the draft, and reports what actually moved. */
  save(): { turnedOff: string[]; turnedOn: string[] } {
    const turnedOff: string[] = [];
    const turnedOn: string[] = [];
    for (const key of this.draft) {
      if (this.initial.has(key)) continue;
      const [provider = '', ...rest] = key.split(':');
      if (turnOff(provider, rest.join(':'))) turnedOff.push(key);
    }
    for (const key of this.initial) {
      if (this.draft.has(key)) continue;
      const [provider = '', ...rest] = key.split(':');
      if (turnOn(provider, rest.join(':'))) turnedOn.push(key);
    }
    return { turnedOff, turnedOn };
  }
}

/**
 * Runs the editor. Resolves to what was written, or null when abandoned.
 *
 * Returns the changes rather than printing them so the caller decides how a
 * save reads — the CLI follows it with the resulting routing, the REPL keeps it
 * to two lines.
 */
export async function pickModels(
  engines: readonly Engine[],
  root: string,
  hooks: PickerHooks = {},
): Promise<{ turnedOff: string[]; turnedOn: string[] } | null> {
  const state = new PickerState(engines, root, disabledModels());

  const out = process.stdout;
  // `||` rather than `??`: a terminal that does not know its own size reports
  // zero, not undefined, and `0 ?? 80` is zero. That made `width()` negative,
  // which truncated every row to a single ellipsis — a list of models rendered
  // as a column of dots. The floors mean a hostile size degrades to a cramped
  // list rather than an empty one.
  const width = (): number => Math.max(40, (out.columns || 80) - 1);
  /** Rows of list, leaving room for the key hints, the overflow note, and the prompt. */
  const viewport = (): number => Math.max(6, (out.rows || 24) - 4);

  let top = 0;
  let painted = 0;

  function erase(): void {
    if (painted === 0) return;
    out.write(`\x1b[${String(painted)}A\x1b[0J`);
    painted = 0;
  }

  function draw(): void {
    erase();

    const height = viewport();
    // Keep the focused row inside the window, scrolling only as far as it must.
    if (state.focus < top) top = state.focus;
    if (state.focus >= top + height) top = state.focus - height + 1;

    const body: string[] = [];
    body.push(
      pc.dim('  ↑↓ move   space toggle   enter save   esc cancel') +
        (state.pending > 0 ? pc.yellow(`   ${String(state.pending)} pending`) : ''),
    );

    const end = Math.min(state.lines.length, top + height);
    for (let i = top; i < end; i += 1) {
      body.push(renderLine(state.lines[i]!, i === state.focus, state.draft, width()));
    }

    const hidden = state.lines.length - end;
    body.push(hidden > 0 ? pc.dim(`  … ${String(hidden)} more`) : '');

    // One array entry per terminal line, so the count that erases the block is
    // the count that drew it.
    out.write(`${body.join('\n')}\n`);
    painted = body.length;
  }

  const wasRaw = process.stdin.isRaw ?? false;
  hooks.pause?.();
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  // Whatever is already sitting in the terminal buffer is not an answer to a
  // question that has not been drawn yet. The Enter that ran `sumo models` is
  // still there, and read as a keystroke it saves an empty draft and quits
  // before the list is ever seen — the editor appears not to open at all.
  // Read before the keypress decoder is attached, so the bytes are discarded
  // rather than delivered.
  while (process.stdin.read() !== null) {
    // discard
  }

  emitKeypressEvents(process.stdin);
  process.stdin.resume();
  out.write('\x1b[?25l');

  return await new Promise((resolve) => {
    const finish = (result: { turnedOff: string[]; turnedOn: string[] } | null): void => {
      process.stdin.off('keypress', onKey);
      erase();
      out.write('\x1b[?25h');
      if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw);
      // Resuming stdin holds the event loop open, so a `sumo models` that has
      // finished its work still never exits — it prints its summary and hangs
      // with the shell prompt never coming back. Handing it back to a caller
      // that wants it is `hooks.resume`'s job; nobody else keeps it.
      process.stdin.pause();
      hooks.resume?.();
      resolve(result);
    };

    const onKey = (_str: string, key: { name?: string; ctrl?: boolean }): void => {
      if (key.ctrl && key.name === 'c') {
        finish(null);
        return;
      }

      switch (key.name) {
        case 'up':
        case 'k':
          state.move(-1);
          break;
        case 'down':
        case 'j':
          state.move(1);
          break;
        case 'space':
          state.toggle();
          break;
        case 'return':
        case 'enter':
          finish(state.save());
          return;
        case 'escape':
        case 'q':
          finish(null);
          return;
        default:
          return;
      }
      draw();
    };

    process.stdin.on('keypress', onKey);
    draw();
  });
}
