/**
 * Gate ordering, and what each gate is allowed to eliminate.
 *
 * The dominance tests run against the real committed catalogue, because the
 * claim being made is about the actual model line-up. The routing tests use
 * fake engines, because what matters there is the order the gates run in.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { clearUnusable } from '../src/engine/availability.ts';
import { candidates, modelsFor, type ModelSpec, undominated } from '../src/engine/catalog.ts';
import { Fleet, policyFromEnv } from '../src/engine/fleet.ts';
import type { AvailableModel } from '../src/engine/availability.ts';
import type { Engine } from '../src/engine/types.ts';

function engine(name: string, opts: { schema?: boolean; models?: readonly AvailableModel[] } = {}): Engine {
  const base: Engine = {
    name,
    costUnit: 'usd',
    supportsOutputSchema: opts.schema ?? true,
    modelFor: () => 'stub',
    supportsEffort: () => true,
    runStage: () => {
      throw new Error('not used');
    },
  };
  const models = opts.models;
  return models ? { ...base, availableModels: () => Promise.resolve(models) } : base;
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'sumo-fleet-'));
}

// ---------------------------------------------------------------- dominance

test('dominance collapses a tier to a handful, on the real catalogue', () => {
  for (const [provider, expected] of [
    ['anthropic', 1],
    ['github-copilot', 2],
  ] as const) {
    for (const tier of ['small', 'mid', 'large'] as const) {
      const pool = candidates(provider, tier);
      const kept = undominated(pool);
      assert.ok(kept.length > 0, `${provider}/${tier} eliminated everything`);
      assert.ok(
        kept.length <= expected,
        `${provider}/${tier} kept ${String(kept.length)}, expected at most ${String(expected)}`,
      );
    }
  }
});

test('identical twins survive together rather than eliminating each other', () => {
  // A model and its dated alias are equal on every axis. Naive dominance using
  // >= everywhere would have each dominate the other and drop both, leaving the
  // tier empty — which is exactly what happened the first time this was written.
  const kept = undominated(candidates('anthropic', 'small'));
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.id, 'claude-haiku-4-5', 'the canonical id wins over the dated alias');
});

test('a cheaper model with equal capability eliminates a pricier one', () => {
  const cheap: ModelSpec = {
    id: 'cheap', name: 'c', outputPerMtok: 1, inputPerMtok: 1, contextWindow: 200_000,
    structuredOutput: true, toolCall: true, efforts: ['low'], releaseDate: '2026-01-01',
  };
  const dear: ModelSpec = { ...cheap, id: 'dear', outputPerMtok: 9 };
  assert.deepEqual(undominated([cheap, dear]).map((m) => m.id), ['cheap']);
});

test('a pricier model survives when it is better at something', () => {
  const cheap: ModelSpec = {
    id: 'cheap', name: 'c', outputPerMtok: 1, inputPerMtok: 1, contextWindow: 200_000,
    structuredOutput: false, toolCall: true, efforts: [], releaseDate: '2026-01-01',
  };
  const dear: ModelSpec = {
    ...cheap, id: 'dear', outputPerMtok: 9, structuredOutput: true, efforts: ['low', 'high'],
  };
  assert.deepEqual(undominated([cheap, dear]).map((m) => m.id).sort(), ['cheap', 'dear']);
});

// ------------------------------------------------------------------ routing

test('a schema stage never routes at a provider that cannot constrain output', async () => {
  const dir = scratch();
  try {
    clearUnusable();
    const fleet = new Fleet([engine('nope', { schema: false }), engine('anthropic')], {}, dir);
    const routed = await fleet.for({ tier: 'mid', needsSchema: true, capabilities: [] });
    assert.equal(routed.engine.name, 'anthropic');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stage with no schema may use a provider that cannot do schemas', async () => {
  const dir = scratch();
  try {
    clearUnusable();
    const fleet = new Fleet([engine('nope', { schema: false })], {}, dir);
    const routed = await fleet.for({ tier: 'mid', needsSchema: false, capabilities: [] });
    assert.equal(routed.engine.name, 'nope');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('availability runs before dominance, so a disabled winner yields to its runner-up', async () => {
  const dir = scratch();
  try {
    clearUnusable();
    // opus-5 dominates every other large Anthropic model. Disable it and the
    // next-best must still be routable — pruning first would have removed it.
    const all = candidates('anthropic', 'large');
    const withoutOpus5: AvailableModel[] = all.map((m) => ({
      id: m.id,
      state: m.id === 'claude-opus-5' ? ('disabled' as const) : ('enabled' as const),
    }));

    const fleet = new Fleet([engine('anthropic', { models: withoutOpus5 })], {}, dir);
    const routed = await fleet.for({ tier: 'large', needsSchema: false, capabilities: [] });

    assert.ok(routed.model, 'a large stage must still find a model');
    assert.notEqual(routed.model.id, 'claude-opus-5', 'the disabled model must not be chosen');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the policy is honoured when it can be, and says so when it cannot', async () => {
  const dir = scratch();
  try {
    clearUnusable();
    const fleet = new Fleet(
      [engine('anthropic'), engine('github-copilot')],
      { mid: 'github-copilot' },
      dir,
    );
    const routed = await fleet.for({ tier: 'mid', needsSchema: false, capabilities: [] });
    assert.equal(routed.engine.name, 'github-copilot');
    assert.match(routed.why, /by policy/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a policy naming a provider that cannot answer falls back, and says which', async () => {
  const dir = scratch();
  try {
    clearUnusable();
    const fleet = new Fleet(
      [engine('anthropic'), engine('github-copilot', { schema: false })],
      { mid: 'github-copilot' },
      dir,
    );
    const routed = await fleet.for({ tier: 'mid', needsSchema: true, capabilities: [] });
    assert.equal(routed.engine.name, 'anthropic');
    assert.match(routed.why, /github-copilot/, 'the unmet preference must be named');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a rung asking for an effort only routes at models that accept it', async () => {
  const dir = scratch();
  try {
    clearUnusable();
    // Anthropic's small tier is Haiku 4.5, which takes no effort at all. A rung
    // demanding one therefore has nothing to route at there — an invalid
    // request, not a smaller one.
    const fleet = new Fleet([engine('anthropic')], {}, dir);
    await assert.rejects(
      () => fleet.for({ tier: 'small', effort: 'high', needsSchema: false, capabilities: [] }),
      /No usable model/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an account offering only "auto" still routes, even though the catalogue lacks it', async () => {
  const dir = scratch();
  try {
    clearUnusable();
    // Verified against a real Copilot plan with no premium requests: listModels()
    // returns exactly one entry, `auto` — GitHub's own router, which appears in
    // no model database because it is not a model. The intersection with the
    // 29-model catalogue is empty, and treating that as "no models" would skip
    // a working account entirely.
    const fleet = new Fleet(
      [engine('github-copilot', { models: [{ id: 'auto', state: 'enabled' }] })],
      {},
      dir,
    );
    const routed = await fleet.for({ tier: 'mid', needsSchema: false, capabilities: [] });

    assert.equal(routed.engine.name, 'github-copilot');
    assert.equal(routed.model, null, 'nothing catalogued matched, so the engine decides');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an account offering nothing at all is skipped, not guessed at', async () => {
  const dir = scratch();
  try {
    clearUnusable();
    const fleet = new Fleet([engine('github-copilot', { models: [] })], {}, dir);
    await assert.rejects(
      () => fleet.for({ tier: 'mid', needsSchema: false, capabilities: [] }),
      /No usable model/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a provider the catalogue does not describe still routes, with no model named', async () => {
  const dir = scratch();
  try {
    clearUnusable();
    const fleet = new Fleet([engine('some-local-runner')], {}, dir);
    const routed = await fleet.for({ tier: 'mid', needsSchema: false, capabilities: [] });
    assert.equal(routed.model, null, 'the engine decides its own model');
    assert.equal(routed.engine.name, 'some-local-runner');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Every catalogued Copilot model, as an account that offers all of them. */
const FULL_COPILOT: readonly AvailableModel[] = modelsFor('github-copilot').map((m) => ({
  id: m.id,
  state: 'enabled' as const,
}));

/** The same roster minus a tier, for whatever reason an account might lack one. */
function without(tier: 'small' | 'mid' | 'large'): readonly AvailableModel[] {
  const excluded = new Set(candidates('github-copilot', tier).map((m) => m.id));
  return FULL_COPILOT.filter((m) => !excluded.has(m.id));
}

test('routing picks from whatever the account actually offers, not from the catalogue', async () => {
  const dir = scratch();
  try {
    clearUnusable();
    // The catalogue is the superset; the account decides. Offer exactly one
    // mid-tier model and that is what must be chosen, even though the catalogue
    // knows cheaper and newer ones.
    const only = candidates('github-copilot', 'mid').find((m) => m.id === 'gpt-5.3-codex');
    assert.ok(only, 'the catalogue no longer lists this model — update the fixture');

    const fleet = new Fleet(
      [engine('github-copilot', { models: [{ id: only.id, state: 'enabled' }] })],
      {},
      dir,
    );
    const routed = await fleet.for({ tier: 'mid', needsSchema: false, capabilities: [] });
    assert.equal(routed.model?.id, 'gpt-5.3-codex');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a full roster reduces each tier to its undominated best', async () => {
  const dir = scratch();
  try {
    clearUnusable();
    const fleet = new Fleet([engine('github-copilot', { models: FULL_COPILOT })], {}, dir);

    for (const tier of ['small', 'mid', 'large'] as const) {
      const routed = await fleet.for({ tier, needsSchema: false, capabilities: [] });
      const best = undominated(candidates('github-copilot', tier))[0];
      assert.equal(routed.model?.id, best?.id, `${tier} did not pick its undominated best`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a tier the account cannot serve falls through to a provider that can', async () => {
  const dir = scratch();
  try {
    clearUnusable();
    // Plans differ in what they include, and a plan missing a whole tier is a
    // real shape — one live subscription returned seventeen models with nothing
    // Opus-class among them. A rung is a decision the router already made, so
    // the answer is to fall through, never to quietly serve a `large` stage
    // from a mid-tier model.
    const fleet = new Fleet(
      [engine('github-copilot', { models: without('large') }), engine('anthropic')],
      { large: 'github-copilot' },
      dir,
    );
    const routed = await fleet.for({ tier: 'large', needsSchema: false, capabilities: [] });

    assert.equal(routed.engine.name, 'anthropic');
    assert.match(routed.why, /github-copilot offered nothing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a tier the account does serve is used, not skipped', async () => {
  const dir = scratch();
  try {
    clearUnusable();
    // The mirror of the test above: when the plan does include the tier — Opus
    // and everything else the catalogue lists — Copilot must win the policy.
    const fleet = new Fleet(
      [engine('github-copilot', { models: FULL_COPILOT }), engine('anthropic')],
      { large: 'github-copilot' },
      dir,
    );
    const routed = await fleet.for({ tier: 'large', needsSchema: false, capabilities: [] });

    assert.equal(routed.engine.name, 'github-copilot');
    assert.match(routed.why, /by policy/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('models compete across providers, not within them', async () => {
  const dir = scratch();
  try {
    clearUnusable();
    // The point of pooling. Copilot's small tier reaches down to $1.20; the best
    // Anthropic offers there is Haiku at $5. Asked provider-by-provider, whoever
    // is consulted first wins. Asked as one pool, the cheaper model does — and
    // which account serves it is incidental.
    const fleet = new Fleet(
      [engine('anthropic'), engine('github-copilot')],
      {},
      dir,
    );
    const routed = await fleet.for({ tier: 'small', needsSchema: false, capabilities: [] });

    assert.equal(routed.engine.name, 'github-copilot');
    assert.equal(routed.model?.id, 'gpt-5.6-luna');
    assert.ok(
      routed.model.outputPerMtok < 5,
      'the pool must beat the best single-provider answer',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('engine construction order does not decide the route', async () => {
  const dir = scratch();
  try {
    clearUnusable();
    const forward = new Fleet([engine('anthropic'), engine('github-copilot')], {}, dir);
    const reversed = new Fleet([engine('github-copilot'), engine('anthropic')], {}, dir);

    for (const tier of ['small', 'mid', 'large'] as const) {
      const a = await forward.for({ tier, needsSchema: false, capabilities: [] });
      const b = await reversed.for({ tier, needsSchema: false, capabilities: [] });
      assert.equal(a.model?.id, b.model?.id, `${tier} depended on construction order`);
      assert.equal(a.engine.name, b.engine.name, `${tier} depended on construction order`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a preference only breaks ties; it cannot promote a beaten model', async () => {
  const dir = scratch();
  try {
    clearUnusable();
    // `claude-sonnet-5` is on both providers at the same price. Preferring one
    // must decide that tie — but must not resurrect a model something else
    // dominates outright.
    const anthropicFirst = new Fleet(
      [engine('anthropic'), engine('github-copilot')],
      { mid: 'anthropic' },
      dir,
    );
    const copilotFirst = new Fleet(
      [engine('anthropic'), engine('github-copilot')],
      { mid: 'github-copilot' },
      dir,
    );

    const a = await anthropicFirst.for({ tier: 'mid', needsSchema: false, capabilities: [] });
    const c = await copilotFirst.for({ tier: 'mid', needsSchema: false, capabilities: [] });

    assert.equal(a.engine.name, 'anthropic', 'the preference must settle the tie');
    assert.equal(c.engine.name, 'github-copilot', 'and settle it the other way too');
    assert.equal(a.model?.id, c.model?.id, 'the same model, reached two ways');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the tier policy is read from the environment, and absent means unset', () => {
  assert.deepEqual(policyFromEnv({}), {});
  assert.deepEqual(policyFromEnv({ SUMO_ROUTE_SMALL: 'github-copilot' }), {
    small: 'github-copilot',
  });
});
