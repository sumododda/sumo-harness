import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isFreeShipping, shippingCost } from './shipping.js';

test('an order under the threshold pays for shipping', () => {
  assert.equal(isFreeShipping(4999), false);
  assert.equal(shippingCost(4999), 499);
});

test('an order over the threshold ships free', () => {
  assert.equal(isFreeShipping(5001), true);
});

test('an order exactly at the threshold ships free', () => {
  // $50.00 is the advertised cutoff, not $50.01. This is the seeded bug.
  assert.equal(isFreeShipping(5000), true);
  assert.equal(shippingCost(5000), 0);
});
