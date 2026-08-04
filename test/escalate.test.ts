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

test('omitted verdict and an explicit "nearMiss" are byte-for-byte the same as today, for every case above', () => {
  const cases: LadderState[] = [
    startAt({ tier: 'mid', effort: 'low' }),
    { rung: 1, retries: 1, escalations: 0 },
    { rung: 2, retries: 1, escalations: 0 },
    { rung: 3, retries: 1, escalations: MAX_ESCALATIONS },
    { rung: LADDER.length - 1, retries: 1, escalations: 0 },
  ];

  for (const state of cases) {
    const omitted = afterFailure(state);
    assert.deepEqual(afterFailure(state, undefined), omitted);
    assert.deepEqual(afterFailure(state, 'nearMiss'), omitted);
  }
});

test('a confident capability failure skips the same-rung retry outright', () => {
  // Rung 0's own escalation (0 → 1) is already a tier change, so this isolates
  // the retry-skip from the rung-skip below: nothing here should land on
  // small/none a second time.
  const state = startAt({ tier: 'small' });
  const step = afterFailure(state, 'capabilityFailure');

  assert.equal(step.kind, 'retry');
  if (step.kind !== 'retry') return;
  assert.equal(step.rung.tier, 'mid', 'escalated immediately rather than retrying at small');
  assert.equal(step.climbed, true);
  assert.equal(step.state.escalations, 1);
  assert.equal(step.state.retries, 0);
});

test('a confident capability failure at a same-tier boundary also skips the rung beyond it', () => {
  // mid/low's next rung (mid/high) is the SAME tier, so a capability failure
  // here should skip past it straight to large/medium — the genuine tier
  // change beyond the effort bump it doesn't expect to help.
  const state: LadderState = { rung: 1, retries: 0, escalations: 0 };
  const step = afterFailure(state, 'capabilityFailure');

  assert.equal(step.kind, 'retry');
  if (step.kind !== 'retry') return;
  assert.deepEqual(step.rung, { tier: 'large', effort: 'medium' });
  assert.equal(step.state.rung, 3, 'landed two rungs up, not one');
  assert.equal(step.climbed, true);
  assert.equal(step.state.escalations, 1, 'one escalation, not two, even though the climb moved two rungs');
  assert.match(step.why, /skipping the mid\/high rung/);
});

test('the same skip applies once the same-rung retry has already been spent', () => {
  const state: LadderState = { rung: 1, retries: 1, escalations: 0 };
  const step = afterFailure(state, 'capabilityFailure');

  assert.equal(step.kind, 'retry');
  if (step.kind !== 'retry') return;
  assert.equal(step.state.rung, 3);
});

test('a capability failure at rung 2 does not skip, because the next step already changes tier', () => {
  // mid/high (rung 2) escalates to large/medium (rung 3): already a tier
  // change, so there is nothing for a capability failure to skip past.
  const step = afterFailure({ rung: 2, retries: 1, escalations: 0 }, 'capabilityFailure');

  assert.equal(step.kind, 'retry');
  if (step.kind !== 'retry') return;
  assert.deepEqual(step.rung, { tier: 'large', effort: 'medium' });
  assert.equal(step.state.rung, 3, 'a single-rung climb, exactly as a nearMiss verdict would produce');
  assert.doesNotMatch(step.why, /skipping/);
});

test('capability-failure skipping still respects the escalation cap', () => {
  const step = afterFailure({ rung: 1, retries: 1, escalations: MAX_ESCALATIONS }, 'capabilityFailure');

  assert.equal(step.kind, 'giveUp');
  if (step.kind !== 'giveUp') return;
  assert.match(step.why, new RegExp(`${MAX_ESCALATIONS} escalations`));
});

test('a capability-failure skip that would land past the top of the ladder gives up instead', () => {
  // large/medium (rung 3) is a same-tier boundary too (large/medium →
  // large/high), so a capability failure there tries to skip to rung 5 —
  // past the end of a five-rung ladder — and must give up exactly as an
  // ordinary single-step climb off the top already does.
  const step = afterFailure({ rung: 3, retries: 0, escalations: 0 }, 'capabilityFailure');

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
