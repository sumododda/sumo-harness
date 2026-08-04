/** Terminal rendering. Kept apart so the REPL logic stays readable. */

import pc from 'picocolors';
import type { z } from 'zod';
import type { StageEvent } from './engine/types.ts';
import type { DecidedBy } from './routing-log.ts';
import {
  Evidence,
  Explore,
  parse,
  Plan,
  renderEvidence,
  renderExplore,
  renderPlan,
  renderRootCause,
  RootCause,
} from './schemas.ts';
import { rule } from './statusbar.ts';
import { describeRung, type Rung } from './types.ts';

export const PROMPT = pc.cyan('› ');

/**
 * Opens the frame around what the user is about to type.
 *
 * A session is a sequence of turns, and without a boundary it reads as one
 * column of text in which the question and its answer look alike. A rule above
 * the prompt and another below the answer is enough to tell them apart at a
 * glance, and — unlike a pinned bar — it is printed once and never redrawn, so
 * there is nothing to flicker.
 */
export function openTurn(): string {
  return `${pc.dim(rule())}\n`;
}

/** Closes the frame, once the line has been read. */
export function closeTurn(): string {
  return `${pc.dim(rule())}\n`;
}

export function banner(cwd: string, provider: string, indexed: boolean): string {
  return [
    `${pc.bold('sumo')} ${pc.dim('· token-frugal harness')}`,
    pc.dim(`${cwd}  ·  ${provider}  ·  ${indexed ? 'indexed' : 'no index (/index to build)'}`),
    pc.dim('/help for commands, /exit to quit'),
    '',
  ].join('\n');
}

/**
 * The one line that says what the harness decided, and who decided it.
 *
 * `by` earns its place: `question` and `classified moderate` read alike, but one
 * is a rule that matched for free and the other is a guess that was paid for. A
 * route that turns out wrong is the most expensive mistake the harness makes,
 * and the first thing worth knowing about one is which of the two produced it.
 * Without it the only way to tell was to already know the rule names by heart.
 */
export function modeLine(mode: string, rung: Rung, why: string, by: DecidedBy): string {
  // The paid decider is the one worth noticing, so it is the one not dimmed
  // into the rest of the line.
  const decider = by === 'classifier' ? pc.yellow(`by ${by}`) : pc.dim(`by ${by}`);
  return `${pc.dim(`  ${mode} · ${describeRung(rung)} · ${why} · `)}${decider}`;
}

/** Tracks whether streamed text left the cursor mid-line. */
let midLine = false;

/** Ends the current line if streamed text left one open. */
function closeLine(): void {
  if (midLine) {
    process.stdout.write('\n');
    midLine = false;
  }
}

/** Streams live activity. Text is printed as it arrives; tools are one dim line. */
export function renderEvent(event: StageEvent): void {
  switch (event.kind) {
    case 'text':
      process.stdout.write(event.text);
      midLine = !event.text.endsWith('\n');
      break;
    case 'tool':
      closeLine();
      process.stdout.write(
        pc.dim(`  ${event.tool.toLowerCase()}${event.detail ? ` ${event.detail}` : ''}\n`),
      );
      break;
    case 'denied':
      closeLine();
      process.stdout.write(pc.yellow(`  ✗ ${event.tool.toLowerCase()} — ${event.reason}\n`));
      break;
    case 'thinking':
      break;
  }
}

/** Called when a turn finishes, so the next prompt starts on a fresh line. */
export function endTurn(): void {
  closeLine();
}

/**
 * Prints a stage's finished artifact.
 *
 * Stages that answer in a schema have nothing to stream — the result arrives in
 * one piece at the end — so without this the user would watch a stage read
 * files and then say nothing at all.
 */
export function renderArtifact(text: string): void {
  closeLine();
  const body = text.trim();
  if (body.length === 0) return;
  process.stdout.write(
    `${body
      .split('\n')
      // Indenting a blank line only adds trailing whitespace.
      .map((l) => (l.length > 0 ? `  ${l}` : l))
      .join('\n')}\n`,
  );
}

export function cost(usd: number): string {
  return pc.dim(`  $${usd.toFixed(4)}`);
}

/**
 * The same stage answers as `schemas.ts` renders, laid out for a person.
 *
 * Those renderers encode their tables as TOON, and that is right for what they
 * are for: the text they return is fed back into the next stage's prompt, and
 * TOON pays for a field name once per table instead of once per row. It is the
 * wrong thing to put in front of a person. A plan reached the screen as
 * `steps[2]{file,action,detail}:` followed by comma-joined rows breaking
 * mid-word at the terminal edge — a wire format, read by the one audience it
 * was never meant for.
 *
 * Splitting the two costs a second renderer and no tokens at all, because
 * nothing below here is ever sent to a model.
 */

/** Columns the rail itself occupies: a bar and a space. */
const RAIL = 2;

/**
 * The width a section may draw to.
 *
 * Both callers — `renderArtifact` and the approval gate — indent what they are
 * given by two, so the frame is drawn two narrower rather than indenting itself
 * and landing four deep.
 */
function frameWidth(): number {
  // rule() already caps very wide terminals and guards one reporting 0 columns.
  return Math.max(24, rule().length - 2);
}

/**
 * Breaks text at spaces to fit `width`.
 *
 * Without this the terminal wraps at its own edge, which lands mid-word and
 * mid-path, and re-flows differently every time the window changes size.
 */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  const room = Math.max(8, width);
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter((w) => w.length > 0)) {
      if (line.length === 0) line = word;
      else if (line.length + 1 + word.length <= room) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
      // A single token wider than the line — a path, a type signature — has no
      // space to break at, so it is cut deliberately rather than left to the
      // terminal.
      while (line.length > room) {
        out.push(line.slice(0, room));
        line = line.slice(room);
      }
    }
    out.push(line);
  }
  return out;
}

/** A section: a titled top rule, a left rail, and a closing rule. */
function box(title: string, body: readonly string[]): string {
  if (body.length === 0) return '';
  const w = frameWidth();
  const bar = '─'.repeat(Math.max(0, w - title.length - 4));
  return [
    `${pc.dim('╭─')} ${pc.bold(title)} ${pc.dim(bar)}`,
    // A spacer line is the rail alone: padding it would leave trailing blanks
    // that show up as a ragged edge whenever the terminal highlights them.
    ...body.map((line) => (line.length === 0 ? pc.dim('│') : `${pc.dim('│')} ${line}`)),
    pc.dim(`╰${'─'.repeat(w - 1)}`),
  ].join('\n');
}

/**
 * One record: a headline with an optional right-aligned tag, then its detail
 * indented under it. Padding is measured before colour is applied, because
 * escape bytes count toward a string's length but not toward its width.
 */
function entry(head: string, tag: string, detail: string, indent = 3): string[] {
  const w = frameWidth() - RAIL;
  const pad = ' '.repeat(Math.max(1, w - head.length - tag.length));
  const first = tag.length > 0 ? `${pc.cyan(head)}${pad}${pc.dim(tag)}` : pc.cyan(head);
  const under = ' '.repeat(indent);
  return [
    first,
    ...wrap(detail, w - indent).map((l) => `${under}${pc.dim(l)}`),
  ];
}

function bullets(items: readonly string[]): string[] {
  const w = frameWidth() - RAIL;
  return items.flatMap((item) =>
    wrap(item, w - 2).map((l, i) => (i === 0 ? `${pc.dim('·')} ${l}` : `  ${l}`)),
  );
}

function paragraph(text: string): string[] {
  return wrap(text, frameWidth() - RAIL);
}

/** Joins the sections that have content, one blank line apart. */
function sections(parts: readonly string[]): string {
  return parts.filter((p) => p.length > 0).join('\n\n');
}

export function displayPlan(p: Plan): string {
  return sections([
    box('Approach', paragraph(p.approach)),
    box(
      'Steps',
      p.steps.flatMap((s, i) => {
        const label = `${String(i + 1)}  `;
        return [
          ...entry(`${label}${s.file}`, s.action, s.detail, label.length),
          ...(i < p.steps.length - 1 ? [''] : []),
        ];
      }),
    ),
    box(
      `Tests · ${String(p.tests.length)}`,
      // ✗ because a feature test has to fail before the change — the marker is
      // the claim being made, not decoration.
      p.tests.flatMap((t, i) => [
        `${pc.yellow('✗')} ${t.case}`,
        ...wrap(t.whyFailsToday, frameWidth() - RAIL - 2).map((l) => `  ${pc.dim(l)}`),
        // Most plans put every test in one file, and repeating that under each
        // one is three lines of noise saying the same thing. Named only when it
        // changes, it goes back to being information.
        ...(t.file === p.tests[i - 1]?.file ? [] : [`  ${pc.dim(t.file)}`]),
      ]),
    ),
    box('Risks', bullets(p.risks)),
  ]);
}

export function displayExplore(e: Explore): string {
  return sections([
    box('Files', bullets(e.files)),
    box(
      'Reuse',
      e.reuse.flatMap((r) => entry(r.symbol, r.file, r.why)),
    ),
    box('Conventions', [...paragraph(e.conventions.note), pc.dim(e.conventions.example)]),
    box('Constraints', bullets(e.constraints)),
  ]);
}

export function displayEvidence(e: Evidence): string {
  return sections([
    box(
      'Observed',
      e.observations.flatMap((o) => entry(`${o.file}:${String(o.line)}`, '', o.what)),
    ),
    box('Suspects', bullets(e.suspects)),
    box('Repro', e.repro === null ? [] : [pc.cyan(e.repro)]),
    box('Hypotheses', bullets(e.hypotheses)),
  ]);
}

export function displayRootCause(r: RootCause): string {
  return sections([
    box('Cause', paragraph(r.cause)),
    box('Rests on', bullets(r.evidenceRefs)),
    box(
      'Fix',
      r.fix.flatMap((f) => entry(f.file, '', f.change)),
    ),
    box('Verified by', paragraph(r.verification)),
  ]);
}

/**
 * A stage answer in both of the forms it is needed in.
 *
 * Keeping them together is the point. Two audiences read the same answer and
 * want opposite things from it, and the expensive mistake is not showing a
 * person the wrong one — that is merely ugly — but sending a model the pretty
 * one, which costs tokens on every later stage and shows up nowhere.
 * Naming the fields for their reader makes that hard to do by accident.
 */
export interface Shown<T> {
  /** The parsed answer, or null when the stage did not answer in the schema. */
  readonly value: T | null;
  /** TOON tables — what the next stage reads. */
  readonly prompt: string;
  /** Boxed layout — what the operator reads. Never sent to a model. */
  readonly display: string;
}

/** Both forms of a stage answer, falling back to its raw text when unparseable. */
function both<T>(
  schema: z.ZodType<T>,
  output: string,
  toPrompt: (v: T) => string,
  toDisplay: (v: T) => string,
): Shown<T> {
  const value = parse(schema, output);
  if (value === null) return { value: null, prompt: output, display: output };
  return { value, prompt: toPrompt(value), display: toDisplay(value) };
}

export const shownPlan = (output: string): Shown<Plan> =>
  both<Plan>(Plan, output, renderPlan, displayPlan);

export const shownExplore = (output: string): Shown<Explore> =>
  both<Explore>(Explore, output, renderExplore, displayExplore);

export const shownEvidence = (output: string): Shown<Evidence> =>
  both<Evidence>(Evidence, output, renderEvidence, displayEvidence);

export const shownRootCause = (output: string): Shown<RootCause> =>
  both<RootCause>(RootCause, output, renderRootCause, displayRootCause);

export function error(message: string, suggestions: readonly string[] = []): string {
  const lines = [`${pc.red('✗')} ${message}`];
  for (const s of suggestions) lines.push(pc.dim(`  → ${s}`));
  return lines.join('\n');
}

export const HELP = `
${pc.bold('Modes')} ${pc.dim('— sumo picks one per message, or you can pin it')}
  ${pc.cyan('/chat')}      ask about the code, change nothing
  ${pc.cyan('/do')}        small mechanical edits, one stage
  ${pc.cyan('/fix')}       evidence → root cause → your approval → fix → verify
  ${pc.cyan('/feature')}   explore → plan → your approval → tests → implement
  ${pc.cyan('/plan')}      explore and plan, then offer to build it
  ${pc.cyan('/research')}  search the web and answer with sources ${pc.dim('(the only mode that leaves this machine)')}
  ${pc.cyan('/auto')}      back to automatic routing ${pc.dim('(default)')}
  ${pc.cyan('/again')} <mode> re-run the last request as another mode ${pc.dim('(fixes a misroute)')}

${pc.bold('While a task runs')} ${pc.dim('— the input line stays open')}
  ${pc.dim('type anything and press Enter; it is folded into the next stage')}
  ${pc.dim('it never answers a gate you have not been shown')}

${pc.bold('Session')}
  ${pc.cyan('/index')}     build the code index for this repo (writes .codegraph/)
  ${pc.cyan('/lsp')} [off]  precise references via language servers
  ${pc.cyan('/cost')}      spend so far, per stage
  ${pc.cyan('/routing')}   how turns are being routed, and what you corrected
  ${pc.cyan('/cache')} [clear] answers reused instead of paid for again
  ${pc.cyan('/rung')} [n]  show or pin the model tier ${pc.dim('(0 cheapest … 4)')}
  ${pc.cyan('/git')} <args> run git here, e.g. /git checkout main
  ${pc.cyan('/tests')} [cmd] show or set how to run this repo's tests
  ${pc.cyan('/resume')}    show the last task in this repo, and pick it up
  ${pc.cyan('/clear')}     forget the conversation
  ${pc.cyan('/profile')}   show standing preferences
  ${pc.cyan('/remember')}  add a standing preference
  ${pc.cyan('/help')}      this
  ${pc.cyan('/exit')}      quit
`;
