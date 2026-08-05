/**
 * The committed model catalogue.
 *
 * These assert against real data rather than a fixture on purpose. The whole
 * point of committing the snapshot is that an upstream change shows up in a
 * diff and in a failing test, instead of silently re-tiering a model or
 * withdrawing a capability the router was counting on.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  acceptsEffort,
  candidates,
  canSchema,
  catalog,
  lookup,
  modelsFor,
  tierOf,
  TIER_CUTS,
} from '../src/engine/catalog.ts';

test('the catalogue carries both providers the harness can route to', () => {
  const providers = Object.keys(catalog().providers);
  assert.ok(providers.includes('anthropic'));
  assert.ok(providers.includes('github-copilot'));
});

test('every model is priced and sized, or it would not be routable', () => {
  for (const provider of Object.keys(catalog().providers)) {
    for (const m of modelsFor(provider)) {
      assert.ok(m.outputPerMtok > 0, `${m.id} has no output price`);
      assert.ok(m.contextWindow > 0, `${m.id} has no context window`);
    }
  }
});

test('models are listed cheapest first, so the file reads as a ladder', () => {
  for (const provider of Object.keys(catalog().providers)) {
    const prices = modelsFor(provider).map((m) => m.outputPerMtok);
    assert.deepEqual(prices, [...prices].sort((a, b) => a - b), provider);
  }
});

test('the tiers the Claude engine names still land where it expects them', () => {
  // src/engine/claude.ts pins these three by hand. If an upstream price change
  // moved one across a cut, the router's idea of "mid" would quietly stop
  // matching the engine's — so this is the assertion that catches it.
  const haiku = lookup('anthropic', 'claude-haiku-4-5');
  const sonnet = lookup('anthropic', 'claude-sonnet-5');
  const opus = lookup('anthropic', 'claude-opus-5');

  assert.ok(haiku && sonnet && opus, 'the engine names a model the catalogue lacks');
  assert.equal(tierOf(haiku), 'small');
  assert.equal(tierOf(sonnet), 'mid');
  assert.equal(tierOf(opus), 'large');
});

test('the tier cuts sit in gaps, not on top of a model price', () => {
  // A cut landing exactly on a price makes tiering fragile: a one-dollar change
  // upstream flips a model to a neighbouring tier with no other signal.
  const prices = new Set(
    Object.keys(catalog().providers).flatMap((p) => modelsFor(p).map((m) => m.outputPerMtok)),
  );
  assert.ok(!prices.has(TIER_CUTS.smallMax), 'a model sits exactly on the small/mid cut');
  assert.ok(!prices.has(TIER_CUTS.midMax), 'a model sits exactly on the mid/large cut');
});

test('every tier has something to route to on both providers', () => {
  for (const provider of ['anthropic', 'github-copilot']) {
    for (const tier of ['small', 'mid', 'large'] as const) {
      assert.ok(candidates(provider, tier).length > 0, `${provider} has no ${tier} model`);
    }
  }
});

test('unknown schema support counts as no, never as yes', () => {
  const unknown = { structuredOutput: null } as Parameters<typeof canSchema>[0];
  assert.equal(canSchema(unknown), false);
  const yes = { structuredOutput: true } as Parameters<typeof canSchema>[0];
  assert.equal(canSchema(yes), true);
});

test('effort support is read per model rather than assumed per tier', () => {
  // The reason the catalogue exists: on Copilot, Haiku 4.5 takes no effort at
  // all while Opus 4.6 takes four levels. A rule keyed on tier would be wrong
  // for one of them whichever way it was written.
  const haiku = lookup('github-copilot', 'claude-haiku-4.5');
  const opus = lookup('github-copilot', 'claude-opus-4.6');

  assert.ok(haiku && opus, 'the Copilot roster has changed shape');
  assert.equal(haiku.efforts.length, 0);
  assert.ok(acceptsEffort(opus, 'high'));
  assert.equal(acceptsEffort(haiku, 'high'), false);
});
