/**
 * The one hand-written judgement in routing, and the limits on what it may do.
 *
 * Two things are worth pinning. First that the table matches reality — a family
 * name with a typo in it is an opinion that silently never applies. Second that
 * a judgement stays subordinate to a fact: aptitude may order models nothing
 * else separates, and may refuse one outright, but must never promote a model
 * that another strictly beats.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { judgedFamilies, ratingFor, ruledOut, score, workOf } from '../src/engine/aptitude.ts';
import { candidates, modelsFor, undominated } from '../src/engine/catalog.ts';
import { clearUnusable } from '../src/engine/availability.ts';
import { Fleet } from '../src/engine/fleet.ts';
import type { Engine } from '../src/engine/types.ts';

function engine(name: string): Engine {
  return {
    name,
    costUnit: 'usd',
    supportsOutputSchema: true,
    modelFor: () => 'stub',
    supportsEffort: () => true,
    runStage: () => {
      throw new Error('not used');
    },
  };
}

test('every judged family exists in the catalogue', () => {
  // The failure this catches is silent: a mistyped family is an opinion that
  // never matches a model, so routing quietly falls back to price and nobody
  // notices the judgement was ignored.
  const known = new Set(
    ['anthropic', 'github-copilot'].flatMap((p) => modelsFor(p).map((m) => m.family)),
  );
  for (const family of judgedFamilies()) {
    assert.ok(known.has(family), `aptitude judges "${family}", which no model has`);
  }
});

test('stages map to the kind of work they do, and an unknown stage is not special-cased', () => {
  assert.equal(workOf('explore'), 'survey');
  assert.equal(workOf('root-cause'), 'reason');
  assert.equal(workOf('implement'), 'edit');
  assert.equal(workOf('route'), 'classify');
  assert.equal(workOf('a-stage-nobody-has-written-yet'), 'reason');
});

test('an unjudged family is neutral, not bad', () => {
  const anon = { family: 'no-such-family' } as Parameters<typeof score>[0];
  assert.equal(ratingFor(anon, 'edit'), null);
  assert.equal(score(anon, 'edit'), 0);
  assert.equal(ruledOut(anon, 'edit'), false);
});

test('avoid is a refusal, not a low score', () => {
  const nano = { family: 'gpt-nano' } as Parameters<typeof score>[0];
  assert.equal(ruledOut(nano, 'edit'), true, 'must not be given code to write');
  assert.equal(ruledOut(nano, 'classify'), false, 'but sorting is what it is for');
  assert.ok(score(nano, 'classify') > 0);
});

test('a model ruled out for the work is not offered at all', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-apt-'));
  try {
    clearUnusable();
    const fleet = new Fleet([engine('github-copilot')], {}, dir);
    const routed = await fleet.for({
      tier: 'small',
      stage: 'implement',
      needsSchema: false,
      capabilities: [],
    });

    assert.ok(routed.model, 'an edit stage must still find a small model');
    assert.equal(ruledOut(routed.model, 'edit'), false, 'a vetoed family was chosen anyway');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the work changes the winner without leaving the undominated set', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-apt-'));
  try {
    clearUnusable();
    const fleet = new Fleet([engine('github-copilot')], {}, dir);
    const survivors = undominated(candidates('github-copilot', 'mid')).map((m) => m.id);

    const reason = await fleet.for({
      tier: 'mid', stage: 'root-cause', needsSchema: false, capabilities: [],
    });
    const edit = await fleet.for({
      tier: 'mid', stage: 'implement', needsSchema: false, capabilities: [],
    });

    // Both must come from the models nothing beats — aptitude reorders that
    // set, it does not reach outside it.
    assert.ok(survivors.includes(reason.model?.id ?? ''));
    assert.ok(survivors.includes(edit.model?.id ?? ''));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
