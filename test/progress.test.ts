/**
 * A workflow used to render as an undifferentiated stream of tool calls, so
 * these tests are about the three questions that stream could not answer: what
 * is it doing, where are we, and what happens next.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Progress, ROUTES, roadmap } from '../src/progress.ts';

/** Captures what a block of progress rendering printed. */
function captured(run: () => void): string {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    written.push(chunk);
    return true;
  });
  try {
    run();
  } finally {
    process.stdout.write = original;
  }
  return written.join('');
}

test('the route is stated before anything runs', () => {
  const line = roadmap('fix');
  for (const step of ['evidence', 'root-cause', 'approval', 'fix', 'verify']) {
    assert.ok(line.includes(step), `route should name ${step}`);
  }
});

test('an unknown mode has no route rather than a broken one', () => {
  assert.equal(roadmap('chat'), '');
});

test('every route ends somewhere the work is verified or handed over', () => {
  // A route that just stops after writing code would be claiming success it
  // never checked.
  for (const [mode, steps] of Object.entries(ROUTES)) {
    const last = steps[steps.length - 1]!.name;
    assert.ok(['verify', 'build'].includes(last), `${mode} ends at ${last}`);
  }
});

test('every route has exactly one gate, and it precedes any writing', () => {
  for (const [mode, steps] of Object.entries(ROUTES)) {
    const gates = steps.filter((s) => s.gate);
    assert.equal(gates.length, 1, `${mode} should gate exactly once`);

    // The whole design rests on nothing being written before approval, so the
    // route has to agree with it.
    const gateAt = steps.findIndex((s) => s.gate);
    const writers = ['fix', 'write-tests', 'implement', 'build'];
    for (const [i, step] of steps.entries()) {
      if (writers.includes(step.name)) {
        assert.ok(i > gateAt, `${mode}: ${step.name} must come after approval`);
      }
    }
  }
});

test('a stage announces where it is in the route', () => {
  const output = captured(() => new Progress('feature').begin('plan'));
  assert.match(output, /plan/);
  assert.match(output, /2\/6/, 'position in the route, not just a name');
  assert.match(output, /write the proposal/);
});

test('a finished stage reports its cost and what comes next', () => {
  const progress = new Progress('fix');
  const output = captured(() => {
    progress.begin('evidence');
    progress.done('', 0.0412, 'usd');
  });

  assert.match(output, /\$0\.0412/);
  assert.match(output, /next: root-cause/);
});

test('a replayed stage says so instead of quoting a price', () => {
  const progress = new Progress('fix');
  const output = captured(() => {
    progress.begin('evidence');
    progress.done('', 0, 'usd', true);
  });

  assert.match(output, /reused/);
  assert.doesNotMatch(output, /\$/);
});

test('the step before a gate warns that it will wait', () => {
  const progress = new Progress('feature');
  const output = captured(() => {
    progress.begin('plan');
    progress.done('', 0.01, 'usd');
  });

  assert.match(output, /next: approval — waits for you/);
});

test('the last step promises nothing after it', () => {
  const progress = new Progress('fix');
  const output = captured(() => {
    progress.begin('verify');
    progress.done('', 0, 'usd');
  });

  assert.doesNotMatch(output, /next:/);
});

test('a stage outside the route still renders', () => {
  // `discuss` answers a question at a gate; it is real work but not a leg of
  // the journey, and must not break the display or claim a position.
  const progress = new Progress('fix');
  const output = captured(() => {
    progress.begin('discuss');
    progress.done('', 0.002, 'usd');
  });

  assert.match(output, /discuss/);
  assert.doesNotMatch(output, /\d\/\d/, 'it has no position to claim');
});

test('done without begin does nothing rather than throwing', () => {
  assert.equal(captured(() => new Progress('fix').done('', 0, 'usd')), '');
});
