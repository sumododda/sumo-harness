/**
 * How the gate reads your answer decides whether a good proposal survives.
 *
 * The rule is now a question mark and nothing else. The previous version guessed
 * from sentence shape and got about a third of real answers wrong, always the
 * same way: "do it in one file", "have a look at rank.ts first" and "can you use
 * a Map instead" were all read as questions, answered, and the proposal left
 * exactly as it was. Being told what to change and having nothing change is the
 * worst thing a gate can do, so those cases are pinned here.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { Interface } from 'node:readline/promises';
import { askApproval, type GateDecision } from '../src/gate.ts';
import { LineReader } from '../src/input.ts';

/**
 * A reader that hands out the given lines and then ends.
 *
 * Ending matters: the gate re-asks on an empty answer, so a reader that never
 * closed would wait forever rather than fail.
 */
function reader(lines: readonly string[]): LineReader {
  const emitter = new EventEmitter() as Interface;
  const lineReader = new LineReader(emitter);
  for (const line of lines) emitter.emit('line', line);
  emitter.emit('close');
  return lineReader;
}

/** Runs the gate against scripted input, capturing what it printed. */
async function answer(
  ...lines: readonly string[]
): Promise<{ decision: GateDecision; output: string }> {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    written.push(chunk);
    return true;
  });

  try {
    const decision = await askApproval(reader(lines), { title: 'Approve?' }, true, false);
    return { decision, output: written.join('') };
  } finally {
    process.stdout.write = original;
  }
}

test('yes and no are taken literally', async () => {
  for (const yes of ['y', 'Y', 'yes', 'YES', 'ok', 'sure', 'go ahead']) {
    assert.equal((await answer(yes)).decision.kind, 'approved', yes);
  }
  for (const no of ['n', 'no', 'stop', 'q', 'quit', 'cancel']) {
    assert.equal((await answer(no)).decision.kind, 'rejected', no);
  }
});

test('a question mark asks; anything else changes the proposal', async () => {
  for (const question of [
    'why did you choose that file?',
    'what happens if the worker is already running?',
    'can you use a Map instead?',
    'is this going to break the edition job?',
  ]) {
    assert.equal((await answer(question)).decision.kind, 'discuss', question);
  }

  for (const instruction of [
    'use the existing worker instead of a new one',
    'drop step 4',
    'put it in src/lib/jobs.ts',
    'do not touch the API route',
  ]) {
    assert.equal((await answer(instruction)).decision.kind, 'revise', instruction);
  }
});

test('instructions phrased like questions are still instructions', async () => {
  // Every one of these was previously answered as a question, leaving the
  // proposal untouched — the exact failure this rule exists to remove.
  for (const instruction of [
    'do it in one file',
    'have a look at rank.ts first',
    'can you use a Map instead',
    'why not reuse formatMoney',
    'should we also handle nulls',
    'what about the empty case',
  ]) {
    const { decision } = await answer(instruction);
    assert.equal(decision.kind, 'revise', instruction);
    assert.equal(decision.kind === 'revise' && decision.feedback, instruction);
  }
});

test('the same words become a question with a question mark', async () => {
  // The rule is controllable, which is the point: you decide, not a regex.
  assert.equal((await answer('do it in one file')).decision.kind, 'revise');
  assert.equal((await answer('do it in one file?')).decision.kind, 'discuss');
});

test('Enter re-asks instead of destroying the task', async () => {
  // This used to reject: one stray keypress threw away a whole workflow.
  assert.equal((await answer('', '', 'y')).decision.kind, 'approved');
});

test('repeated silence eventually stops, rather than looping forever', async () => {
  assert.equal((await answer('', '', '', '', '')).decision.kind, 'rejected');
});

test('the grammar is printed, so the rule never has to be remembered', async () => {
  const { output } = await answer('y');
  assert.match(output, /go ahead/);
  assert.match(output, /stop/);
  assert.match(output, /ask about it/);
  assert.match(output, /say what to change/);
});

test('a bare question mark explains the prompt rather than asking about the plan', async () => {
  const { decision, output } = await answer('?', 'y');
  assert.equal(decision.kind, 'approved');
  assert.match(output, /approve and continue/);
  assert.match(output, /treated as a change to make/);
});

test('ending input mid-question stops rather than assuming yes', async () => {
  assert.equal((await answer()).decision.kind, 'rejected');
});

test('a non-interactive run fails closed unless told otherwise', async () => {
  assert.equal(
    (await askApproval(reader([]), { title: 'Approve?' }, false, false)).kind,
    'rejected',
    'no way to ask means no approval',
  );
  assert.equal(
    (await askApproval(reader([]), { title: 'Approve?' }, false, true)).kind,
    'approved',
    'unless auto-approval was explicitly requested',
  );
});

/** As `answer`, but with control over what the gate is asked to present. */
async function present(
  body: string | undefined,
  ...lines: readonly string[]
): Promise<{ decision: GateDecision; output: string }> {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    written.push(chunk);
    return true;
  });

  try {
    const decision = await askApproval(
      reader(lines),
      { title: 'Approve this root cause and fix?', ...(body === undefined ? {} : { body }) },
      true,
      false,
    );
    return { decision, output: written.join('') };
  } finally {
    process.stdout.write = original;
  }
}

test('a gate with nothing to show does not ask', async () => {
  // Seen live: the root-cause stage ended with `stopped: error`, wrote an empty
  // rootcause.md, and the gate printed its question over a blank space and
  // waited. A `y` there would have sent an empty root cause into the fix stage.
  // The scripted answer here is yes, so the only way this passes is if the gate
  // never got as far as reading it.
  for (const empty of ['', '   ', '\n\n']) {
    const { decision, output } = await present(empty, 'y');
    assert.equal(decision.kind, 'rejected', `empty body must not be approvable: ${JSON.stringify(empty)}`);
    assert.match(output, /produced nothing to approve/);
    assert.doesNotMatch(output, /Approve this root cause/, 'the question is not even asked');
  }
});

test('an omitted body still asks, because it means already shown', async () => {
  // Omitting the body is how a gate avoids reprinting something the operator
  // just watched stream past. That is not the same as having nothing to say.
  const { decision, output } = await present(undefined, 'y');
  assert.equal(decision.kind, 'approved');
  assert.match(output, /Approve this root cause/);
});

test('a gate with a real proposal is unaffected', async () => {
  const { decision } = await present('Cause: listNotes swallows ENOENT.', 'y');
  assert.equal(decision.kind, 'approved');
});

test('the reason a stage produced nothing is carried to the operator', async () => {
  const { producedNothing } = await import('../src/gate.ts');

  // A budget stop and a provider error want opposite responses — retrying is
  // right for one and pointless for the other — so the reason is not dropped.
  assert.match(producedNothing('root-cause', 'error'), /root-cause/);
  assert.match(producedNothing('root-cause', 'error'), /stopped: error/);
  assert.match(producedNothing('plan', 'budget'), /stopped: budget/);
  assert.doesNotMatch(producedNothing('plan', undefined), /stopped:/);
  assert.match(producedNothing('plan', undefined), /nothing was changed/);
});
