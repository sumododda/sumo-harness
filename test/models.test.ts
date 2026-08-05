/**
 * Turning a model off, and routing noticing.
 *
 * The switch is only worth having if it reaches the pool routing ranks, so the
 * test that matters is the one asserting a disabled model stops being chosen —
 * not the one asserting a file was written.
 *
 * Every test here points `SUMO_HOME` at a temp directory. Without that this
 * suite would write to the developer's own `~/.sumo` and turn off a model they
 * were using, which is a rude way to find out the path was a constant.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { clearUnusable } from '../src/engine/availability.ts';
import { Fleet } from '../src/engine/fleet.ts';
import { disabledModels, disabledPath, isDisabled, turnOff, turnOn } from '../src/engine/preferences.ts';
import type { Engine } from '../src/engine/types.ts';
import { switchModel } from '../src/models.ts';
import { PickerState } from '../src/models-picker.ts';

let home = '';
let previous: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sumo-prefs-'));
  previous = process.env['SUMO_HOME'];
  process.env['SUMO_HOME'] = home;
  clearUnusable();
});

afterEach(() => {
  if (previous === undefined) delete process.env['SUMO_HOME'];
  else process.env['SUMO_HOME'] = previous;
  rmSync(home, { recursive: true, force: true });
});

function engine(name: string, catalogName?: string): Engine {
  return {
    name,
    ...(catalogName ? { catalogName } : {}),
    costUnit: 'usd',
    supportsOutputSchema: true,
    modelFor: () => 'stub',
    supportsEffort: () => true,
    runStage: () => {
      throw new Error('not used');
    },
  };
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'sumo-models-'));
}

test('nothing is turned off to begin with', () => {
  assert.equal(disabledModels().size, 0);
  assert.ok(disabledPath().startsWith(home), 'the test must not touch the real home');
});

test('a model turned off stays off, and can be turned back on', () => {
  assert.equal(turnOff('claude', 'claude-opus-5'), true);
  assert.equal(isDisabled('claude', 'claude-opus-5'), true);

  // Saying it twice is not an error, it is a no-op worth reporting as one.
  assert.equal(turnOff('claude', 'claude-opus-5'), false);

  assert.equal(turnOn('claude', 'claude-opus-5'), true);
  assert.equal(isDisabled('claude', 'claude-opus-5'), false);
  assert.equal(turnOn('claude', 'claude-opus-5'), false);
});

test('turning one provider off leaves the same model on the other', () => {
  turnOff('github-copilot', 'claude-sonnet-5');
  assert.equal(isDisabled('github-copilot', 'claude-sonnet-5'), true);
  assert.equal(isDisabled('claude', 'claude-sonnet-5'), false);
});

test('routing stops choosing a model that was turned off', async () => {
  const dir = scratch();
  try {
    const fleet = new Fleet([engine('claude', 'anthropic')], {}, dir);

    const before = await fleet.for({ tier: 'large', needsSchema: false, capabilities: [] });
    assert.ok(before.model, 'the large tier must route somewhere to begin with');

    turnOff('claude', before.model.id);

    const after = await fleet.for({ tier: 'large', needsSchema: false, capabilities: [] });
    assert.notEqual(
      after.model?.id,
      before.model.id,
      'a model turned off was still routed at — the switch never reached the pool',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a bare id turns the model off everywhere it exists', () => {
  // `claude-sonnet-5` is reachable through both accounts. Turning it off on one
  // while it quietly keeps running on the other is the least useful thing this
  // could do, so a bare id means both.
  const engines = [engine('claude', 'anthropic'), engine('github-copilot')];
  switchModel(engines, 'off', 'claude-sonnet-5');

  assert.equal(isDisabled('claude', 'claude-sonnet-5'), true);
  assert.equal(isDisabled('github-copilot', 'claude-sonnet-5'), true);
});

test('provider/id turns it off on that provider alone', () => {
  const engines = [engine('claude', 'anthropic'), engine('github-copilot')];
  switchModel(engines, 'off', 'github-copilot/claude-sonnet-5');

  assert.equal(isDisabled('github-copilot', 'claude-sonnet-5'), true);
  assert.equal(isDisabled('claude', 'claude-sonnet-5'), false);
});

test('a model nobody carries is refused rather than written down', () => {
  const engines = [engine('claude', 'anthropic')];
  assert.throws(() => switchModel(engines, 'off', 'not-a-real-model'), /No catalogued model/);
  assert.equal(disabledModels().size, 0, 'a typo must not end up in the file');
});

test('a model is looked up under the catalogue name, not the display name', () => {
  // ClaudeEngine is named "claude" and catalogued as "anthropic". Resolving by
  // the display name finds nothing, which would make every Anthropic model
  // un-switchable while reporting them all as unknown.
  const engines = [engine('claude', 'anthropic')];
  switchModel(engines, 'off', 'claude-opus-5');
  assert.equal(isDisabled('claude', 'claude-opus-5'), true);
});

// ------------------------------------------------------------------ the editor

test('the cursor starts on a model, not on a heading', () => {
  const state = new PickerState([engine('claude', 'anthropic')], scratch(), new Set());
  assert.equal(state.lines[state.focus]?.kind, 'model');
});

test('moving skips headings and unavailable models', () => {
  const dir = scratch();
  try {
    const state = new PickerState([engine('claude', 'anthropic')], dir, new Set());
    // Walk the whole list; every landing has to be a togglable model, or the
    // cursor would stop on a row where space does nothing.
    for (let i = 0; i < 60; i += 1) {
      state.move(1);
      const line = state.lines[state.focus];
      assert.equal(line?.kind, 'model', 'the cursor landed on a heading');
      assert.equal(line?.blocked ?? null, null, 'the cursor landed on an unavailable model');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('moving past either end stays put rather than wrapping', () => {
  const state = new PickerState([engine('claude', 'anthropic')], scratch(), new Set());
  const first = state.focus;
  state.move(-1);
  assert.equal(state.focus, first, 'moved above the first model');

  for (let i = 0; i < 200; i += 1) state.move(1);
  const last = state.focus;
  state.move(1);
  assert.equal(state.focus, last, 'moved past the last model');
});

test('nothing is written until the draft is saved', () => {
  const state = new PickerState([engine('claude', 'anthropic')], scratch(), new Set());
  const key = state.lines[state.focus]?.key ?? '';

  state.toggle();
  assert.equal(state.pending, 1);
  assert.equal(disabledModels().size, 0, 'a toggle reached disk before save');

  state.save();
  assert.equal(disabledModels().has(key), true);
});

test('toggling twice is a draft with nothing in it', () => {
  const state = new PickerState([engine('claude', 'anthropic')], scratch(), new Set());
  state.toggle();
  state.toggle();
  assert.equal(state.pending, 0);

  const changes = state.save();
  assert.deepEqual(changes, { turnedOff: [], turnedOn: [] });
  assert.equal(disabledModels().size, 0);
});

test('a save reports both directions', () => {
  const dir = scratch();
  try {
    turnOff('claude', 'claude-opus-5');
    const state = new PickerState([engine('claude', 'anthropic')], dir, disabledModels());

    // Turn the already-off one back on, and turn a different one off.
    const opus = state.lines.findIndex((l) => l.key === 'claude:claude-opus-5');
    state.focus = opus;
    state.toggle();

    const haiku = state.lines.findIndex((l) => l.key === 'claude:claude-haiku-4-5');
    state.focus = haiku;
    state.toggle();

    const changes = state.save();
    assert.deepEqual(changes.turnedOn, ['claude:claude-opus-5']);
    assert.deepEqual(changes.turnedOff, ['claude:claude-haiku-4-5']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('turning off the winner promotes the next model at that tier', () => {
  const dir = scratch();
  try {
    const state = new PickerState([engine('claude', 'anthropic')], dir, new Set());
    const winner = state.lines.find((l) => l.kind === 'model' && l.dominated === false);
    assert.ok(winner?.key, 'no undominated model to begin with');

    state.focus = state.lines.findIndex((l) => l.key === winner.key);
    state.toggle();

    // The list is rebuilt on toggle, so something else has to be undominated
    // now — that shift is the whole reason to watch this screen.
    const promoted = state.lines.find(
      (l) => l.kind === 'model' && !l.blocked && !l.dominated && l.key !== winner.key,
    );
    assert.ok(promoted, 'nothing took over the tier');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
