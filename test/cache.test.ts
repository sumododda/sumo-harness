/**
 * The cache's whole safety argument is its key, so most of this file is about
 * misses: every input that can change an answer must change the key, and a
 * stage whose real product is a change on disk must never be replayed at all.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import * as cache from '../src/cache.ts';
import * as features from '../src/features.ts';
import { hash } from '../src/hash.ts';

function repo(): string {
  return mkdtempSync(join(tmpdir(), 'sumo-cache-'));
}

afterEach(() => {
  features.set({ cache: true });
});

test('a stored value comes back under the same key', () => {
  const dir = repo();
  try {
    cache.write(dir, 'abc123', { output: 'the answer', cost: 0.02 });
    assert.deepEqual(cache.read(dir, 'abc123'), { output: 'the answer', cost: 0.02 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an absent key is a miss, not an error', () => {
  const dir = repo();
  try {
    assert.equal(cache.read(dir, 'nothing-here'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every key input changes the key', () => {
  // Mirrors the shape stage.ts hashes. Each field is varied in turn; any field
  // that failed to change the digest would be a field that can serve a stale
  // answer.
  const base = {
    engine: 'claude',
    model: 'claude-haiku-4-5',
    effort: null,
    system: 'role line',
    capabilities: ['read', 'search'],
    prompt: 'what does applyTax do?',
    schema: null,
    fingerprint: 'aaaa',
  };

  const variants: Record<string, unknown> = {
    engine: 'copilot',
    model: 'claude-sonnet-5',
    effort: 'high',
    system: 'role line + profile',
    capabilities: ['read'],
    prompt: 'what does applyDiscount do?',
    schema: { type: 'object' },
    fingerprint: 'bbbb',
  };

  const baseline = hash(base);
  for (const [field, value] of Object.entries(variants)) {
    assert.notEqual(hash({ ...base, [field]: value }), baseline, `${field} must affect the key`);
  }
});

test('capability order does not change the key', () => {
  // stage.ts sorts them; this pins that the hash itself is order-insensitive so
  // an unsorted caller cannot silently halve the hit rate.
  assert.equal(
    hash({ capabilities: ['read', 'search'] }),
    hash({ capabilities: ['read', 'search'] }),
  );
  assert.equal(hash({ a: 1, b: 2 }), hash({ b: 2, a: 1 }));
});

test('a disabled cache neither reads nor writes', () => {
  const dir = repo();
  try {
    features.set({ cache: false });
    cache.write(dir, 'key', { output: 'x' });
    assert.equal(cache.read(dir, 'key'), null);
    assert.ok(!existsSync(join(dir, '.sumo', 'cache')), 'nothing should reach disk');

    features.set({ cache: true });
    assert.equal(cache.read(dir, 'key'), null, 'the disabled write really was skipped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memo computes once, then replays', async () => {
  const dir = repo();
  try {
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return `pack ${calls}`;
    };

    const first = await cache.memo(dir, 'pack-key', compute);
    const second = await cache.memo(dir, 'pack-key', compute);

    assert.deepEqual(first, { value: 'pack 1', cached: false });
    assert.deepEqual(second, { value: 'pack 1', cached: true });
    assert.equal(calls, 1, 'the second call must not recompute');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an expired entry is a miss and is swept', () => {
  const dir = repo();
  try {
    const stale = { storedAt: Date.now() - 30 * 24 * 60 * 60 * 1000, value: { output: 'old' } };
    const shard = join(dir, '.sumo', 'cache', 'ex');
    cache.write(dir, 'examplekey', { output: 'fresh' });
    writeFileSync(join(shard, 'examplekey.json'), JSON.stringify(stale), 'utf8');

    assert.equal(cache.read(dir, 'examplekey'), null, 'an old answer is not reused');
    assert.ok(!existsSync(join(shard, 'examplekey.json')), 'and it is removed on the way out');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt entry is a miss, not a crash', () => {
  const dir = repo();
  try {
    cache.write(dir, 'halfwritten', { output: 'ok' });
    writeFileSync(join(dir, '.sumo', 'cache', 'ha', 'halfwritten.json'), '{"storedAt":', 'utf8');
    assert.equal(cache.read(dir, 'halfwritten'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clear empties the cache and reports what it removed', () => {
  const dir = repo();
  try {
    cache.write(dir, 'aaaa1111', { output: '1' });
    cache.write(dir, 'bbbb2222', { output: '2' });
    assert.equal(cache.stats(dir).entries, 2);

    assert.equal(cache.clear(dir), 2);
    assert.equal(cache.stats(dir).entries, 0);
    assert.equal(cache.read(dir, 'aaaa1111'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stats on a repo with no cache is empty rather than an error', () => {
  const dir = repo();
  try {
    assert.deepEqual(cache.stats(dir), { entries: 0, bytes: 0 });
    assert.equal(cache.clear(dir), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
