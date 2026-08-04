/**
 * Typing to a task that is already running.
 *
 * The bug this pins down: a half-written message disappeared under the model's
 * output and had to be typed again. Streamed chunks end wherever a token ends,
 * so the terminal is almost always mid-line, and the input line refused to
 * redraw there rather than land in the middle of a sentence. The buffer was
 * never actually lost — but text you cannot see is text you retype.
 *
 * These run against a stdout pretending to be a terminal, because the whole
 * behaviour is about escape codes and none of it is reachable through a pipe.
 * This file is deliberately separate: `enable` is once-per-process, and the
 * test runner gives each file its own.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activity, disable, enable, openInput, setInput } from '../src/statusbar.ts';

const WIDTH = 80;

/**
 * Runs `body` with both streams claiming to be a terminal, capturing every byte
 * either of them emits, in order.
 *
 * Both, because they are two handles onto one cursor and the region has to
 * cooperate with each of them.
 */
function onFakeTerminal(body: (seen: () => string) => void): void {
  const saved = [process.stdout, process.stderr].map((stream) => ({
    stream,
    write: stream.write.bind(stream),
    isTTY: stream.isTTY,
    columns: stream.columns,
  }));

  const chunks: string[] = [];
  for (const stream of [process.stdout, process.stderr]) {
    // Installed before `enable`, so this is what the live region captures as
    // the real write and calls to paint.
    stream.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    });
    Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(stream, 'columns', { value: WIDTH, configurable: true });
  }

  try {
    body(() => chunks.join(''));
  } finally {
    disable();
    for (const entry of saved) {
      entry.stream.write = entry.write;
      Object.defineProperty(entry.stream, 'isTTY', { value: entry.isTTY, configurable: true });
      Object.defineProperty(entry.stream, 'columns', {
        value: entry.columns,
        configurable: true,
      });
    }
  }
}

test('a half-written message survives output that never reaches a newline', () => {
  onFakeTerminal((seen) => {
    assert.equal(enable('sumo-news'), true, 'the region needs a terminal to draw on');
    openInput('› ');
    setInput('please also handle the empty case', 33);

    const beforeStreaming = seen();
    assert.ok(
      beforeStreaming.includes('please also handle the empty case'),
      'what is typed must be on screen',
    );

    // A stage streaming prose: chunk boundaries fall on tokens, not on lines.
    for (const chunk of ['The cart total', ' is computed', ' in applyDiscount']) {
      process.stdout.write(chunk);
    }

    const after = seen();
    const lastPaint = after.slice(after.lastIndexOf('please also handle the empty case'));
    assert.ok(
      !lastPaint.includes('The cart total'),
      'streamed text must not be printed over the input line',
    );
    assert.ok(
      after.lastIndexOf('please also handle the empty case') > beforeStreaming.length,
      'the input line is redrawn after each chunk, not left behind',
    );
  });
});

test('output held while typing is released once the message is sent', () => {
  onFakeTerminal((seen) => {
    enable('sumo-news');
    openInput('› ');
    setInput('one moment', 10);

    process.stdout.write('The cart total is wrong');
    assert.ok(!seen().includes('The cart total is wrong'), 'held while there is unsent text');

    // Sending clears the buffer, which is what releases the backlog.
    setInput('', 0);
    assert.ok(seen().includes('The cart total is wrong'), 'and printed the moment it can be');
  });
});

test('a partial row already on screen is taken back rather than typed over', () => {
  onFakeTerminal((seen) => {
    enable('sumo-news');
    openInput('› ');

    // Output lands first, leaving the cursor mid-sentence...
    process.stdout.write('Reading src/cart.js');
    // ...and only then does someone start typing.
    setInput('w', 1);

    const after = seen();
    assert.ok(after.includes('\r\x1b[2K'), 'the partial row is cleared, not written under');
    assert.ok(after.lastIndexOf('w') > after.lastIndexOf('Reading src/cart.js'));

    // The recalled text is not lost — it comes back when the buffer empties.
    setInput('', 0);
    assert.ok(
      seen().slice(after.length).includes('Reading src/cart.js'),
      'the row that was taken back is put back',
    );
  });
});

test('a write to stderr takes the region back like any other', () => {
  // The bug that made the input line disappear for a whole task. stderr and
  // stdout are two handles onto one cursor, and the harness announces stages on
  // stderr — so an unwrapped write moved the cursor without the region
  // noticing. From then on it erased whatever row the cursor had drifted to,
  // and never appeared where it belonged again. The keyboard is in raw mode by
  // then, so with no input line there is no way to type at all.
  onFakeTerminal((seen) => {
    enable('sumo-news');
    openInput('› ');
    activity('route');

    const before = seen().length;
    process.stderr.write('→ route (small, read-only)\n');

    const written = seen().slice(before);
    const erasedAt = written.indexOf('\x1b[');
    const textAt = written.indexOf('→ route');
    assert.ok(erasedAt >= 0, 'the region must be erased first');
    assert.ok(erasedAt < textAt, 'and erased before the text lands, not after');
  });
});

test('a redirected stderr is left alone', () => {
  // `sumo 2> log` never reaches the terminal, so treating its writes as cursor
  // movement would feed the region movements that never happened. Set up by
  // hand rather than through the helper, which makes both streams terminals.
  const saved = {
    out: process.stdout.write.bind(process.stdout),
    err: process.stderr.write.bind(process.stderr),
    outTTY: process.stdout.isTTY,
    errTTY: process.stderr.isTTY,
    columns: process.stdout.columns,
  };

  const onTerminal: string[] = [];
  const toFile: string[] = [];
  process.stdout.write = ((chunk: string) => {
    onTerminal.push(chunk);
    return true;
  });
  process.stderr.write = ((chunk: string) => {
    toFile.push(chunk);
    return true;
  });
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
  Object.defineProperty(process.stdout, 'columns', { value: WIDTH, configurable: true });

  try {
    enable('sumo-news');
    openInput('› ');
    activity('route');

    const before = onTerminal.length;
    process.stderr.write('this went to a file\n');

    assert.deepEqual(toFile, ['this went to a file\n'], 'it still reaches the redirect');
    assert.equal(onTerminal.length, before, 'and moves nothing on the terminal');
  } finally {
    disable();
    process.stdout.write = saved.out;
    process.stderr.write = saved.err;
    Object.defineProperty(process.stdout, 'isTTY', { value: saved.outTTY, configurable: true });
    Object.defineProperty(process.stderr, 'isTTY', { value: saved.errTTY, configurable: true });
    Object.defineProperty(process.stdout, 'columns', {
      value: saved.columns,
      configurable: true,
    });
  }
});

test('nothing is held once the input line is closed', () => {
  onFakeTerminal((seen) => {
    enable('sumo-news');
    openInput('› ');
    setInput('half a thought', 14);
    process.stdout.write('streamed while typing');

    // Closing the line ends the turn; anything withheld is still output.
    openInput(null);
    assert.ok(seen().includes('streamed while typing'), 'held text is never dropped');

    process.stdout.write('after the close');
    assert.ok(seen().includes('after the close'), 'and later writes pass straight through');
  });
});
