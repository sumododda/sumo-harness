import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeCarts } from './merge.js';

test('mergeCarts combines quantities for the same item id', () => {
  const cartA = [
    { id: 'sku-1', qty: 2 },
    { id: 'sku-2', qty: 1 },
  ];
  const cartB = [
    { id: 'sku-1', qty: 3 },
    { id: 'sku-3', qty: 1 },
  ];

  const merged = mergeCarts(cartA, cartB);
  const bySku1 = merged.filter((i) => i.id === 'sku-1');

  // This is the seeded bug: sku-1 currently appears as two separate lines.
  assert.equal(bySku1.length, 1);
  assert.equal(bySku1[0].qty, 5);
  assert.equal(merged.length, 3);
});

test('carts with no overlap are unaffected', () => {
  const merged = mergeCarts([{ id: 'sku-1', qty: 1 }], [{ id: 'sku-2', qty: 1 }]);
  assert.equal(merged.length, 2);
});
