import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stackedPrice } from './discount.js';

test('the percentage applies before the flat bulk discount', () => {
  // 10% off $100 is $90, then $5 flat off bulk orders is $85. This is the
  // seeded bug: applying the flat amount first gives $85.50 instead.
  assert.equal(stackedPrice(10000, 10, 500), 8500);
});

test('a flat discount with no percentage is a plain subtraction', () => {
  assert.equal(stackedPrice(10000, 0, 500), 9500);
});
