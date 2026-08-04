import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoizeAsync, resetCache } from './memo.js';

test('concurrent calls for the same key share one underlying call', async () => {
  resetCache();
  let calls = 0;
  const slow = memoizeAsync(async (key) => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return `${key}-value`;
  });

  const [a, b] = await Promise.all([slow('x'), slow('x')]);
  assert.equal(a, 'x-value');
  assert.equal(b, 'x-value');
  // The second caller arrived before the first resolved. This is the seeded bug.
  assert.equal(calls, 1);
});

test('a resolved key is served from cache without calling again', async () => {
  resetCache();
  let calls = 0;
  const slow = memoizeAsync(async (key) => {
    calls += 1;
    return key;
  });
  await slow('y');
  await slow('y');
  assert.equal(calls, 1);
});
