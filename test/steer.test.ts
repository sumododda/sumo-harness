/**
 * Steering: what happens to a message sent while a task is already running.
 *
 * The behaviour being replaced was genuinely dangerous. Typed lines sat in the
 * input queue until something asked for one, and the next thing to ask was
 * almost always an approval gate — so "also cover the empty-feed case", typed as
 * a passing thought, silently became the answer to a gate that had not been
 * shown yet, and re-planned the work. Nothing about that was visible.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { Interface } from 'node:readline/promises';
import { askApproval } from '../src/gate.ts';
import { LineReader } from '../src/input.ts';
import { Steering } from '../src/steer.ts';

/** A reader holding lines "typed" while a task was running. */
function typedDuringRun(...lines: readonly string[]): LineReader {
  const emitter = new EventEmitter() as Interface;
  const reader = new LineReader(emitter);
  for (const line of lines) emitter.emit('line', line);
  emitter.emit('close');
  return reader;
}

/** Runs something with stdout captured, so the prints can be asserted on. */
async function quietly<T>(run: () => Promise<T> | T): Promise<{ value: T; output: string }> {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    written.push(chunk);
    return true;
  });
  try {
    return { value: await run(), output: written.join('') };
  } finally {
    process.stdout.write = original;
  }
}

test('drain takes what is queued without waiting for more', () => {
  const reader = typedDuringRun('one', 'two');
  assert.deepEqual(reader.drain(), ['one', 'two']);
  assert.deepEqual(reader.drain(), [], 'and only once');
});

test('a message sent mid-task becomes a steer, and says so', async () => {
  const steer = new Steering(typedDuringRun('also cover the empty-feed case'));
  const { value, output } = await quietly(() => steer.take());

  assert.deepEqual(value, ['also cover the empty-feed case']);
  // Never silently swallowed: the whole failure mode was invisibility.
  assert.match(output, /↳ steering: also cover the empty-feed case/);
});

test('steers are rendered as an addition, not a replacement', async () => {
  const steer = new Steering(typedDuringRun('use vitest', 'skip the branch'));
  const { value } = await quietly(() => steer.takeAsPrompt());

  assert.match(value, /added this while the task was running/);
  assert.match(value, /apply it as well as everything above/);
  assert.match(value, /- use vitest/);
  assert.match(value, /- skip the branch/);
});

test('nothing typed means nothing added to the prompt', async () => {
  const steer = new Steering(typedDuringRun());
  const { value } = await quietly(() => steer.takeAsPrompt());
  assert.equal(value, '', 'an unsteered stage must be byte-identical to before');
});

test('slash commands are refused rather than folded into a prompt', async () => {
  const steer = new Steering(typedDuringRun('/cost', 'also handle nulls'));
  const { value, output } = await quietly(() => steer.take());

  // "/cost" addresses the session, not the task; pasting it into an instruction
  // would be nonsense, and dropping it silently would be worse.
  assert.deepEqual(value, ['also handle nulls']);
  assert.match(output, /ignored while a task is running: \/cost/);
});

test('a gate no longer answers itself with something typed mid-run', async () => {
  const reader = typedDuringRun('also cover the empty-feed case');
  const steer = new Steering(reader);

  const { value: decision, output } = await quietly(() =>
    askApproval(reader, { title: 'Approve this root cause and fix?', steer }, true, false),
  );

  // It still becomes a revision — the operator asked for something, and the
  // point is to keep going and take it into account. What must not happen is
  // it being read as the *verdict* on a proposal never shown.
  assert.equal(decision.kind, 'revise');
  assert.equal(decision.kind === 'revise' && decision.feedback, 'also cover the empty-feed case');
  assert.match(output, /taking that into account rather than asking/);
  assert.match(output, /↳ steering/);
});

test('with nothing steered, the gate asks exactly as before', async () => {
  const reader = typedDuringRun('y');
  // No steer at all: the queued "y" is the operator answering the gate.
  const { value: decision } = await quietly(() =>
    askApproval(reader, { title: 'Approve?' }, true, false),
  );
  assert.equal(decision.kind, 'approved');
});

test('the task keeps a record of everything it was steered by', async () => {
  const reader = typedDuringRun('first note');
  const steer = new Steering(reader);
  await quietly(() => steer.take());
  assert.deepEqual([...steer.applied], ['first note']);
});
