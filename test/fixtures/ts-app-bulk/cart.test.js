import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pricePerItem } from './cart.js';
import { bulkUnitPrice } from './bulk.js';

test('pricePerItem rounds to the nearest cent', () => {
  // 1007 / 4 = 251.75, which rounds up, not down. This is the seeded bug.
  assert.equal(pricePerItem(1007, 4), 252);
});

test('bulkUnitPrice rounds to the nearest cent too', () => {
  // Copy-pasted from cart.js; fixing only one file leaves this red.
  assert.equal(bulkUnitPrice(1007, 4), 252);
});

test('an exact division is unaffected either way', () => {
  assert.equal(pricePerItem(1000, 4), 250);
  assert.equal(bulkUnitPrice(1000, 4), 250);
});
