/**
 * The line reader caused a real bug: approval gates never received answers,
 * because piped input arrives all at once while a stage is still running and a
 * plain `question()` was not listening yet. These pin that behaviour down.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { Interface } from 'node:readline/promises';
import { LineReader } from '../src/input.ts';

/** Stands in for a readline interface, emitting the same two events. */
function fakeRl(): Interface & { feed(line: string): void; end(): void } {
  const emitter = new EventEmitter() as Interface & {
    feed(line: string): void;
    end(): void;
  };
  emitter.feed = (line: string) => {
    emitter.emit('line', line);
  };
  emitter.end = () => {
    emitter.emit('close');
  };
  return emitter;
}

test('lines that arrive while the harness is busy are not lost', async () => {
  const rl = fakeRl();
  const reader = new LineReader(rl);

  // The whole pipe drains before anything asks for a line — the exact case
  // that used to leave every approval gate starved.
  rl.feed('fix the bug');
  rl.feed('y');
  rl.feed('/exit');

  assert.equal(await reader.ask(''), 'fix the bug');
  assert.equal(await reader.ask(''), 'y');
  assert.equal(await reader.ask(''), '/exit');
});

test('a waiting reader is handed the next line as it arrives', async () => {
  const rl = fakeRl();
  const reader = new LineReader(rl);

  const pending = reader.ask('');
  rl.feed('typed later');

  assert.equal(await pending, 'typed later');
});

test('end of input resolves null rather than hanging forever', async () => {
  const rl = fakeRl();
  const reader = new LineReader(rl);

  const pending = reader.ask('');
  rl.end();

  assert.equal(await pending, null, 'a pending read must settle when input ends');
  assert.equal(await reader.ask(''), null, 'and stay settled afterwards');
});

test('buffered lines are still delivered after input ends', async () => {
  const rl = fakeRl();
  const reader = new LineReader(rl);

  // A short pipe: every line arrives, then EOF, before anything reads.
  rl.feed('y');
  rl.end();

  assert.equal(await reader.ask(''), 'y', 'queued input survives EOF');
  assert.equal(await reader.ask(''), null);
});

test('a line sent to a running task is acknowledged, not silently swallowed', async () => {
  // The complaint this answers: with a stage streaming, there was no visible
  // way to say anything to it. `readline` echoed keystrokes into the middle of
  // the model's own output, so typing looked broken even though the line was
  // being queued correctly. Feedback at the moment of sending is the fix.
  const rl = fakeRl();
  const reader = new LineReader(rl, true);
  reader.openSteering();

  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    written.push(chunk);
    return true;
  });

  try {
    // Nothing is reading: this is a message sent mid-task.
    rl.feed('also cover the empty feed');
  } finally {
    process.stdout.write = original;
  }

  const output = written.join('');
  assert.match(output, /also cover the empty feed/, 'it must be shown back');
  assert.match(output, /queued/, 'and say what happens to it next');
  assert.deepEqual(reader.drain(), ['also cover the empty feed'], 'and still be delivered');
});

test('a blank line sent mid-task says nothing at all', async () => {
  const rl = fakeRl();
  const reader = new LineReader(rl, true);
  reader.openSteering();

  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    written.push(chunk);
    return true;
  });

  try {
    rl.feed('   ');
  } finally {
    process.stdout.write = original;
  }

  assert.equal(written.join(''), '', 'an accidental Enter is not a message');
});

test('two consumers take turns instead of starving each other', async () => {
  // The main loop and an approval gate both read from the same reader.
  const rl = fakeRl();
  const reader = new LineReader(rl);

  rl.feed('the cart total is wrong');
  rl.feed('y');

  const fromMainLoop = await reader.ask('› ');
  const fromGate = await reader.ask('approve? ');

  assert.equal(fromMainLoop, 'the cart total is wrong');
  assert.equal(fromGate, 'y');
});
