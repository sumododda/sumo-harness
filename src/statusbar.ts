/**
 * The live region: the bottom of the screen, owned by the harness.
 *
 * It holds up to two lines — what the harness is doing, and what you are
 * typing — and it is the only thing allowed to draw there. Everything else
 * prints above it.
 *
 * This started as a row pinned with a scroll region (DECSTBM), repainted on a
 * timer with save-cursor / restore-cursor. That flickered constantly, because
 * every repaint raced the text a stage was streaming into the region above.
 *
 * There is no pinned row now and no scroll region. The block is printed in the
 * normal flow at the bottom of whatever has been written, and erased the
 * instant anything else needs to write — so it is never on screen at the same
 * time as something competing for the space, and there is nothing to race.
 *
 * The input line is the reason this exists rather than a spinner library.
 * `readline` echoes keystrokes wherever the cursor happens to be, which during
 * a streaming stage is the middle of the model's output — so typing while the
 * harness worked produced garbage, and there was no way to say anything to a
 * running task. Here `readline` is created with no `output` at all: it still
 * runs the line editor, so backspace, arrows, and history work, but it draws
 * nothing. This module draws the buffer instead, in a place it controls.
 *
 * Nothing here runs unless stdout is a real terminal. Writing escape codes into
 * a pipe would corrupt the transcript, and `sumo | tee` is a normal thing to do.
 */

import pc from 'picocolors';

interface State {
  /** What is happening now, e.g. "evidence 1/5". Empty when idle. */
  activity: string;
  /** When the current activity started, for the clock. */
  since: number;
  /**
   * Session spend so far, already rendered.
   *
   * A string rather than a number because the bar is a display component and
   * spend is no longer one number: a session that routes across providers has
   * a total per cost unit, and deciding how that reads belongs with the ledger
   * that knows the units, not with the thing drawing a line of text.
   */
  cost: string;
  /** Short repo label, shown when idle. */
  where: string;
}

const state: State = { activity: '', since: Date.now(), cost: '$0.0000', where: '' };

/**
 * The spinner. Braille dots occupy one column in any monospace font, so the
 * line never changes width as it turns.
 */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const TICK_MS = 80;
/**
 * How long the terminal must be quiet before the block is drawn.
 *
 * Long enough that a stage streaming text is not interrupted by a clock tick,
 * short enough that the block is back before anyone notices it left. Typing
 * overrides it — see {@link draw}.
 */
const QUIET_MS = 200;

let enabled = false;
let timer: NodeJS.Timeout | undefined;
let frame = 0;

/** How many lines of ours are on screen. 0 when nothing is painted. */
let paintedLines = 0;
/** True when the cursor sits at column 0 of an otherwise empty line. */
let atLineStart = true;
let lastWriteAt = 0;

/**
 * What has been written since the last newline — the text physically on the row
 * the cursor is sitting in.
 *
 * Kept so that row can be taken back. A stage streams in chunks that fall
 * wherever the model's tokens happen to end, so at any moment the terminal is
 * usually mid-sentence, and the block cannot be drawn without either landing in
 * that sentence or vanishing. Knowing what is on the row makes a third option
 * possible: erase it, hold it, and put it back afterwards.
 */
let rowText = '';
/** Beyond this a row is not worth remembering; it cannot be recalled anyway. */
const MAX_ROW_MEMORY = 4096;

/**
 * True while streamed output is being held back at line boundaries.
 *
 * Entered the moment there is something typed and unsent. While a stage streams,
 * output arrives constantly, and each arrival takes the input line off the
 * screen — so a half-written message disappeared under the model's text and had
 * to be typed again. Holding output to whole lines keeps the cursor at a line
 * start, which is the one condition under which the input line can be redrawn
 * immediately and stay put.
 *
 * The cost is that output pauses at a partial line while you type, and catches
 * up when you send. That is the right way round: the model's text is on its way
 * regardless, and a sentence you are part-way through is not recoverable.
 */
let holding = false;
/** Streamed text withheld while holding, waiting for a newline or a send. */
let pending = '';

/** The prompt shown on the input line, or null when nothing is accepting input. */
let prompt: string | null = null;
let buffer = '';
let bufferCursor = 0;

/** stdout's own write, captured before it is wrapped. Never erases first. */
let passthrough: typeof process.stdout.write | null = null;
/** Streams whose `write` has been wrapped, so they can be handed back intact. */
const wrapped: { stream: NodeJS.WriteStream; original: typeof process.stdout.write }[] = [];

/** Assumed width when the terminal will not say how wide it is. */
const ASSUMED_WIDTH = 80;

/**
 * Sanitises a width.
 *
 * `process.stdout.columns` is 0 — not undefined — whenever the size is unknown,
 * which is what a pty with no window size attached reports: a CI runner,
 * `script`, some editors' embedded shells. Taken literally it rendered a line
 * of no characters and a rule of none either, so the harness looked hung.
 */
function usable(width: number): number {
  return width > 0 ? width : ASSUMED_WIDTH;
}

function columns(): number {
  return usable(process.stdout.columns ?? 0);
}

/** Writes without the erase-first wrapper, for drawing the block itself. */
function emit(text: string): void {
  (passthrough ?? process.stdout.write.bind(process.stdout))(text);
}

/**
 * Wraps the terminal's streams so anything else printing takes the block back
 * first.
 *
 * Every writer in the harness goes through one of these, so this is the one
 * place that can guarantee the live region is gone before someone else's text
 * arrives — without every caller having to remember to say so.
 *
 * stderr as much as stdout. They are two handles onto one terminal and one
 * cursor, so a write to either moves it, and an unwrapped one moves it without
 * the region noticing. That is not cosmetic: the region erases by clearing the
 * row the cursor is on, so once its idea of where the cursor is has drifted, it
 * clears somebody else's line and stops appearing where it belongs. The harness
 * announces stages on stderr, which put this on the first stage of every turn.
 */
function install(): void {
  passthrough = process.stdout.write.bind(process.stdout);

  wrap(process.stdout);
  // A redirected stderr (`sumo 2> log`) never reaches the terminal, so wrapping
  // it would feed the region text that moves no cursor anyone can see.
  if (process.stderr.isTTY) wrap(process.stderr);
}

function wrap(stream: NodeJS.WriteStream): void {
  const original = stream.write.bind(stream);
  wrapped.push({ stream, original: original });

  stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    erase();
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (text.length === 0) return true;
    lastWriteAt = Date.now();

    if (holding) {
      pending += text;
      // Whole lines go out; the incomplete tail waits. That is what keeps the
      // cursor at a line start, and the input line therefore redrawable.
      const lastBreak = pending.lastIndexOf('\n');
      if (lastBreak >= 0) {
        emit(pending.slice(0, lastBreak + 1));
        pending = pending.slice(lastBreak + 1);
      }
      atLineStart = true;
      // Callers in this harness do not pass a completion callback, but honour
      // one if it ever appears rather than leaving it uncalled forever.
      for (const argument of rest) if (typeof argument === 'function') argument();
      draw();
      return true;
    }

    trackRow(text);
    const wrote = (original as (...args: unknown[]) => boolean)(chunk, ...rest);
    // Put the block back immediately. Leaving it to the next tick meant a stage
    // writing faster than the tick could restore it kept the prompt off screen.
    draw();
    return wrote;
  });
}

/** Remembers what is on the current row, and whether the cursor starts one. */
function trackRow(text: string): void {
  const lastBreak = text.lastIndexOf('\n');
  const row = lastBreak >= 0 ? text.slice(lastBreak + 1) : rowText + text;
  rowText = row.length > MAX_ROW_MEMORY ? row.slice(-MAX_ROW_MEMORY) : row;
  atLineStart = rowText === '';
}

/**
 * Starts holding output, taking back the partial row so the input line can own
 * the bottom of the screen.
 *
 * A row wider than the terminal has wrapped onto more than one row, and
 * clear-to-end-of-line only reaches the last of them — so rather than leave half
 * a sentence behind, that case moves to a fresh row and lets the partial text
 * stand as written.
 */
function startHolding(): void {
  if (holding) return;
  holding = true;

  if (rowText === '') return;
  if (visibleWidth(rowText) < columns()) {
    emit('\r\x1b[2K');
    pending = rowText + pending;
  } else {
    emit('\n');
  }
  rowText = '';
  atLineStart = true;
}

/** Stops holding and puts everything withheld back on the screen. */
function stopHolding(): void {
  if (!holding) return;
  holding = false;

  if (pending !== '') {
    const text = pending;
    pending = '';
    emit(text);
    trackRow(text);
  }
}

function restore(): void {
  for (const { stream, original } of wrapped.splice(0)) {
    stream.write = original;
  }
  passthrough = null;
}

/**
 * Starts the live region.
 *
 * Returns false when there is no terminal to draw on, so callers can carry on
 * without branching on it themselves.
 */
export function enable(where: string): boolean {
  // An escape hatch that needs no flag parsing, for a terminal that renders the
  // block badly, or a transcript that should not carry it at all.
  if (process.env['SUMO_NO_BAR'] === '1') return false;
  if (enabled || !process.stdout.isTTY) return false;

  enabled = true;
  state.where = where;
  state.since = Date.now();

  // A clean slate. Claiming the terminal must not inherit a half-held line or a
  // remembered row from an earlier session in this process — the screen it is
  // about to draw on is not the screen that state was describing.
  atLineStart = true;
  lastWriteAt = 0;
  paintedLines = 0;
  rowText = '';
  pending = '';
  holding = false;
  prompt = null;
  buffer = '';
  bufferCursor = 0;

  install();

  // Unref'd: the region must never be the reason the process stays alive.
  timer = setInterval(tick, TICK_MS);
  timer.unref();

  process.stdout.on('resize', draw);
  process.once('exit', disable);
  // Only reached when the line editor is not in raw mode — with it, readline
  // intercepts Ctrl-C itself and no process signal is raised. Both paths need
  // covering: a default-terminated process runs no `exit` handler, so without
  // this the terminal would be left with the region still on it.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      disable();
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  }

  return true;
}

/** Takes the block back and unwraps stdout. Safe to call more than once. */
export function disable(): void {
  if (!enabled) return;
  enabled = false;

  if (timer) clearInterval(timer);
  timer = undefined;
  process.stdout.off('resize', draw);

  erase();
  // Anything held back belongs on the screen before the terminal is handed
  // over — output withheld for a message that was never sent is still output.
  stopHolding();
  restore();
}

/**
 * Removes the block from the screen, leaving the cursor where it found it.
 *
 * One line is a carriage return and a clear. More than one needs the cursor
 * walked back up first, because clear-to-end-of-line only reaches the row the
 * cursor is on — which is why every line drawn here is clipped to the terminal's
 * width. A line that wrapped would occupy two rows and leave one behind.
 */
function erase(): void {
  if (paintedLines === 0) return;
  emit(paintedLines === 1 ? '\r\x1b[2K' : `\r\x1b[${paintedLines - 1}A\x1b[0J`);
  paintedLines = 0;
}

/** Sets what the region says is happening, and restarts its clock. */
export function activity(text: string): void {
  state.activity = text;
  state.since = Date.now();
  draw();
}

/** Clears the activity, leaving only the input line if one is open. */
export function idle(): void {
  state.activity = '';
  state.since = Date.now();
  if (prompt === null) erase();
  else draw();
}

/** Updates the running total, already rendered by the ledger. */
export function cost(rendered: string): void {
  state.cost = rendered;
  if (paintedLines > 0) draw();
}

/**
 * Opens the input line, or closes it.
 *
 * While it is open the harness is accepting typed text — at a prompt, and also
 * while a stage runs, which is the whole point: a message sent during a task is
 * collected rather than lost.
 */
export function openInput(text: string | null): void {
  prompt = text;
  buffer = '';
  bufferCursor = 0;
  // Holding is what keeps the bottom of the screen ownable, so it starts when
  // the input line does rather than when the first key is pressed. Streamed
  // output arrives as partial lines, and a partial line leaves the cursor
  // mid-sentence — where the block cannot be drawn without landing in the
  // middle of it. Withholding the incomplete tail keeps the cursor at a line
  // start, which is the condition the input line needs in order to exist at
  // all. Gated on typing, it meant the prompt was absent until you typed
  // something you had no reason to believe would work.
  if (text === null) {
    stopHolding();
    erase();
  } else {
    startHolding();
    draw();
  }
}

/**
 * Reflects the line editor's buffer. Called on every keystroke.
 *
 * The moment there is something typed, streamed output starts being held at
 * line boundaries — see {@link startHolding}. The moment it is sent or cleared,
 * everything withheld goes out at once.
 */
export function setInput(text: string, cursor: number): void {
  buffer = text;
  bufferCursor = Math.max(0, Math.min(cursor, text.length));

  if (prompt !== null) startHolding();
  else stopHolding();

  draw();
}

function tick(): void {
  frame = (frame + 1) % FRAMES.length;
  draw();
}

/**
 * Draws the block, or declines to.
 *
 * Declining is about not landing somewhere the block does not belong: mid-line,
 * or on top of text that is still arriving. The one thing that overrides the
 * quiet rule is someone typing — text you have entered must appear whether or
 * not a stage happens to be streaming at that moment, because the alternative
 * is a keystroke that seems to have done nothing.
 */
function draw(): void {
  if (!enabled) return;

  const lines = compose();
  if (lines.length === 0) {
    erase();
    return;
  }

  // Mid-line: a stage is streaming and owns the cursor. Ours would land in the
  // middle of its sentence. This cannot happen while holding, which is the
  // point of holding — text you have typed is redrawn on every keystroke,
  // whatever the stage is doing.
  if (!atLineStart) return;

  erase();
  emit(lines.join('\n'));
  paintedLines = lines.length;

  // Park the cursor where the next character will go, so the terminal's own
  // cursor is the one telling you where you are typing.
  if (prompt !== null) {
    const { column } = renderInput(prompt, buffer, bufferCursor, columns());
    emit(`\r\x1b[${column}G`);
  }
}

/**
 * The block's lines, top to bottom.
 *
 * The quiet rule applies to the activity line and not to the input line, and
 * the difference is the whole point. The activity line animates — a spinner and
 * a clock — so redrawing it between streamed chunks is what strobes, and it is
 * worth suppressing while output flows. The input line is static text: redrawing
 * it after every write changes nothing on screen, and it must survive, because
 * it is the only thing telling you that typing is possible at all.
 *
 * Suppressing both was the bug. A stage streaming steadily kept `lastWriteAt`
 * inside the quiet window, so the whole block was erased by each write and
 * never repainted — the prompt vanished for exactly as long as the stage had
 * something to say, which is exactly when someone wants to interrupt it. It
 * came back only once you had typed something, which you had no reason to try.
 */
function compose(): string[] {
  const lines: string[] = [];
  const settled = buffer !== '' || Date.now() - lastWriteAt >= QUIET_MS;
  if (state.activity !== '' && settled) lines.push(pc.dim(render()));
  if (prompt !== null) lines.push(renderInput(prompt, buffer, bufferCursor, columns()).line);
  return lines;
}

/**
 * The input line, and where the cursor sits on it.
 *
 * A long message must not wrap. The block is erased by walking a known number
 * of rows back, and a wrapped line occupies more rows than it was counted as —
 * so the last row would be cleared and the first left behind, once per redraw.
 * The buffer therefore scrolls sideways under a fixed-width window, the way any
 * single-line field does, and the whole block stays exactly as tall as it says.
 *
 * Exported for testing: this is arithmetic, and arithmetic is worth checking
 * without a terminal.
 */
export function renderInput(
  head: string,
  text: string,
  cursor: number,
  columnCount: number,
): { readonly line: string; readonly column: number } {
  const width = usable(columnCount);
  const headWidth = visibleWidth(head);
  // One column is left free so the cursor has somewhere to sit at the end of a
  // full line without pushing the terminal onto the next row.
  const room = Math.max(1, width - headWidth - 1);
  const at = Math.max(0, Math.min(cursor, text.length));
  const offset = Math.max(0, at - room);

  return {
    line: `${head}${text.slice(offset, offset + room)}`,
    column: Math.max(1, headWidth + at - offset + 1),
  };
}

/** The printable width of a string, ignoring colour escapes. */
function visibleWidth(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/** m:ss, which reads faster than a raw second count once past a minute. */
function elapsed(from: number): string {
  const total = Math.max(0, Math.floor((Date.now() - from) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * The activity line's text, without colour. Exported so it can be tested.
 *
 * Truncation protects the right-hand side: what a stage is called is recoverable
 * from the scrollback immediately above it, whereas the running total appears
 * nowhere else.
 */
export function render(
  now: State = state,
  columnCount = columns(),
  spin: string = FRAMES[frame] ?? FRAMES[0],
): string {
  const width = usable(columnCount);
  const money = now.cost;

  if (now.activity === '') return clip(`sumo · ${now.where} · ${money} this session`, width);

  const full = `${spin} ${now.activity} · ${elapsed(now.since)} · ${money} · type to steer`;
  if (full.length <= width) return full;

  // Drop the steering hint first, then the activity, before touching the cost.
  const short = `${spin} ${now.activity} · ${elapsed(now.since)} · ${money}`;
  return short.length <= width ? short : clip(short, width, money);
}

/** Truncates to the terminal's width, keeping `keep` visible when given. */
function clip(text: string, width: number, keep?: string): string {
  if (text.length <= width) return text;
  if (keep === undefined || keep.length >= width) return text.slice(0, width);
  return `${text.slice(0, Math.max(0, width - keep.length - 1))} ${keep}`.slice(0, width);
}

/**
 * How wide anything drawn may be.
 *
 * Read at the moment of drawing rather than once at start-up, so resizing the
 * window is picked up by whatever is rendered next with nothing to reconfigure.
 * `usable` supplies a sane default for the terminals that report no width at
 * all — a pty, `script`, some editors' embedded shells.
 */
export function width(columnCount = columns()): number {
  return usable(columnCount);
}

/**
 * A horizontal rule the width of the terminal.
 *
 * Used to frame what the user types, so a session reads as a sequence of turns
 * rather than as one undifferentiated column of text.
 *
 * This used to stop at 120 columns, on the reasoning that a very wide terminal
 * needs a visible line rather than a long one. That was defensible for a rule
 * and wrong for everything measured against it: the boxed artifacts derive
 * their width from here, so on a wide terminal they were drawn to 120 while
 * their content wrapped to the real edge — a frame with text spilling out of
 * the right-hand side of it. Whatever the shell says it is, is what gets used.
 */
export function rule(columnCount = columns()): string {
  return '─'.repeat(width(columnCount));
}
