/**
 * The ladder spends money, so its stopping conditions are tested exhaustively
 * and offline. A runaway loop here is the expensive kind of bug.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { afterFailure, type LadderState, MAX_ESCALATIONS, startAt } from '../src/escalate.ts';
import { LADDER } from '../src/types.ts';

test('starting state is found from the rung it was given', () => {
  assert.equal(startAt({ tier: 'small' }).rung, 0);
  assert.equal(startAt({ tier: 'mid', effort: 'low' }).rung, 1);
  assert.equal(startAt({ tier: 'large', effort: 'medium' }).rung, 3);

  // An unrecognised rung falls back to the everyday default rather than to the
  // cheapest or the dearest.
  assert.equal(startAt({ tier: 'mid', effort: 'xhigh' }).rung, 1);
});

test('the first failure retries at the same rung', () => {
  const step = afterFailure(startAt({ tier: 'mid', effort: 'low' }));

  assert.equal(step.kind, 'retry');
  if (step.kind !== 'retry') return;
  assert.deepEqual(step.rung, { tier: 'mid', effort: 'low' }, 'same rung');
  assert.equal(step.climbed, false);
  assert.equal(step.state.retries, 1);
  assert.equal(step.state.escalations, 0);
});

test('a second failure climbs, and effort rises before the model does', () => {
  const state: LadderState = { rung: 1, retries: 1, escalations: 0 };
  const step = afterFailure(state);

  assert.equal(step.kind, 'retry');
  if (step.kind !== 'retry') return;
  // mid/low → mid/high: the cheap move, tried before paying for a bigger model.
  assert.deepEqual(step.rung, { tier: 'mid', effort: 'high' });
  assert.equal(step.climbed, false, 'same tier, so no need to re-plan');
  assert.match(step.why, /thinking harder/);
  assert.equal(step.state.escalations, 1);
  assert.equal(step.state.retries, 0, 'the new rung gets its own retry');
});

test('crossing into a new tier is flagged so planning can be redone', () => {
  // mid/high → large/medium is a different model, not just more thinking.
  const step = afterFailure({ rung: 2, retries: 1, escalations: 0 });

  assert.equal(step.kind, 'retry');
  if (step.kind !== 'retry') return;
  assert.equal(step.rung.tier, 'large');
  assert.equal(step.climbed, true);
  assert.match(step.why, /stepping up/);
});

test('it gives up after the escalation budget, rather than climbing forever', () => {
  const step = afterFailure({ rung: 3, retries: 1, escalations: MAX_ESCALATIONS });

  assert.equal(step.kind, 'giveUp');
  if (step.kind !== 'giveUp') return;
  assert.match(step.why, new RegExp(`${MAX_ESCALATIONS} escalations`));
});

test('it gives up at the top of the ladder even with budget left', () => {
  const top = LADDER.length - 1;
  const step = afterFailure({ rung: top, retries: 1, escalations: 0 });

  assert.equal(step.kind, 'giveUp');
  if (step.kind !== 'giveUp') return;
  assert.match(step.why, /strongest/);
});

test('a full run from the cheapest rung terminates and never repeats a rung', () => {
  // The property that matters most: this loop always ends.
  let state = startAt({ tier: 'small' });
  const attempted: number[] = [state.rung];

  for (let guard = 0; guard < 50; guard += 1) {
    const step = afterFailure(state);
    if (step.kind === 'giveUp') {
      // Two escalations plus one retry each: a small, bounded number of tries.
      assert.ok(attempted.length <= 2 + MAX_ESCALATIONS * 2, `tried ${attempted.length} times`);
      assert.ok(state.escalations <= MAX_ESCALATIONS);
      return;
    }
    state = step.state;
    attempted.push(state.rung);
  }

  assert.fail('the ladder never terminated');
});
