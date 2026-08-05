/**
 * The context budget: what a stage's prompt may contain, and what goes first
 * when it cannot contain all of it.
 *
 * Every part here is exactly 400 characters, which the estimator reads as 100
 * tokens, so the budgets below are countable rather than approximate.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { budgetFor, fit, type Part, type Region } from '../src/context/budget.ts';
import type { Work } from '../src/engine/aptitude.ts';
import { catalog, modelsFor } from '../src/engine/catalog.ts';

const WORKS: readonly Work[] = ['survey', 'reason', 'edit', 'research', 'classify'];

function part(region: Region, label: string): Part {
  return { region, text: label.padEnd(400, '.') };
}

/** The five regions, one part each: 500 tokens in total. */
function full(): Part[] {
  return [
    part('facts', 'FACTS'),
    part('turns', 'TURNS'),
    part('pack', 'PACK'),
    part('task', 'TASK'),
    part('instructions', 'INSTRUCTIONS'),
  ];
}

test('a prompt that fits is assembled whole, in order, with nothing reported', () => {
  const { text, dropped } = fit(full(), 500);

  assert.deepEqual(dropped, []);
  assert.equal(text.length, 2000, 'every part survives');
  const seen = ['FACTS', 'TURNS', 'PACK', 'TASK', 'INSTRUCTIONS'].map((l) => text.indexOf(l));
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b), 'and in assembly order');
});

test('over budget, the least valuable region goes first and is named', () => {
  const { text, dropped } = fit(full(), 450);

  assert.deepEqual(dropped, ['facts'], 'facts are the cheapest thing to lose');
  assert.ok(!text.includes('FACTS'));
  assert.ok(text.includes('TURNS'), 'and nothing else was touched');
  assert.equal(text.length, 1600);
});

test('dropping continues up the priority order until the prompt fits', () => {
  const { text, dropped } = fit(full(), 350);

  assert.deepEqual(dropped, ['facts', 'turns']);
  assert.ok(text.includes('PACK'), 'the pack outranks both');
  assert.equal(text.length, 1200);
});

test('the pack sheds its tail first, because the index ranked the head highest', () => {
  const parts = [
    part('pack', 'BEST'),
    part('pack', 'MIDDLING'),
    part('pack', 'WEAKEST'),
    part('task', 'TASK'),
  ];

  const { text, dropped } = fit(parts, 300);

  assert.deepEqual(dropped, ['pack']);
  assert.ok(text.includes('BEST'), 'the most relevant entry stays');
  assert.ok(!text.includes('WEAKEST'), 'the least relevant goes');
  assert.equal(text.length, 1200);
});

test('facts and turns shed their oldest first, keeping where the work stands', () => {
  const parts = [
    part('facts', 'OLDEST'),
    part('facts', 'NEWEST'),
    part('task', 'TASK'),
  ];

  const { text } = fit(parts, 250);

  assert.ok(!text.includes('OLDEST'));
  assert.ok(text.includes('NEWEST'), 'a fact is a progress note; the recent one is the live one');
});

test('the task and its instructions are never dropped, even alone over budget', () => {
  const parts = [part('task', 'TASK'), part('instructions', 'INSTRUCTIONS')];

  const { text, dropped } = fit(parts, 10);

  // Half a question fails in a way nobody can read. An expensive stage merely
  // costs money, so this deliberately goes over rather than mutilating it.
  assert.deepEqual(dropped, []);
  assert.ok(text.includes('TASK'));
  assert.ok(text.includes('INSTRUCTIONS'));
});

test('nothing is ever cut inside a part', () => {
  const parts = full();
  const { text } = fit(parts, 250);

  for (const p of parts) {
    const kept = text.includes(p.text);
    const gone = !text.includes(p.text.slice(0, 40));
    assert.ok(kept || gone, `${p.region} was truncated rather than kept or dropped whole`);
  }
});

test('instructions are last however the caller ordered its parts', () => {
  // Asserted on the output, because the point is that a caller cannot get this
  // wrong: the invariant lives in the assembler, not in the calling convention.
  const scrambled = [
    part('instructions', 'INSTRUCTIONS'),
    part('task', 'TASK'),
    part('facts', 'FACTS'),
    part('pack', 'PACK'),
    part('turns', 'TURNS'),
  ];

  const { text } = fit(scrambled, 500);

  assert.ok(text.startsWith('FACTS'), 'facts open the block');
  assert.ok(text.endsWith('.'.repeat(10)), 'the last part is padding-terminated');
  assert.equal(
    text.indexOf('INSTRUCTIONS'),
    1600,
    'instructions occupy the final slot, at the strong end position',
  );
});

test('an assembled prompt that dropped nothing is the plain concatenation', () => {
  // What makes this safe to introduce: a stage whose context fits produces the
  // exact string it produced before, so no cached answer is invalidated.
  const parts = full();
  const { text } = fit(parts, 500);

  assert.equal(text, parts.map((p) => p.text).join(''));
});

test('the ceiling binds on every model in the catalogue, never the window', () => {
  // The design decision this asserts: budgets are absolute, so a million-token
  // window buys no more prompt than a hundred-thousand-token one. If a window
  // ever started to bind, a model would be getting more context for being
  // advertised as larger — which is exactly what the ceilings exist to refuse.
  const uncapped = Object.fromEntries(WORKS.map((w) => [w, budgetFor(w, Number.MAX_SAFE_INTEGER)]));

  for (const provider of Object.keys(catalog().providers)) {
    for (const model of modelsFor(provider)) {
      for (const work of WORKS) {
        assert.equal(
          budgetFor(work, model.contextWindow),
          uncapped[work],
          `${model.id} (${String(model.contextWindow)}) capped the ${work} ceiling`,
        );
      }
    }
  }
});

test('a window smaller than the ceiling still caps it', () => {
  // The backstop nothing in the catalogue currently triggers.
  assert.equal(budgetFor('survey', 1_000), 500);
  assert.ok(budgetFor('survey', 1_000) < budgetFor('survey', Number.MAX_SAFE_INTEGER));
});

test('a cheap stage is given a smaller budget than a broad one', () => {
  // Ordering rather than exact values, because the numbers are starting points
  // for `sumo bench` to correct and a test pinning them would just have to be
  // rewritten alongside them.
  const window = Number.MAX_SAFE_INTEGER;
  assert.ok(budgetFor('classify', window) < budgetFor('edit', window));
  assert.ok(budgetFor('edit', window) < budgetFor('reason', window));
  assert.ok(budgetFor('reason', window) < budgetFor('survey', window));
});
