import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyDiscount, formatMoney, subtotal } from './cart.js';

test('subtotal sums price times quantity', () => {
  assert.equal(subtotal([{ price: 250, qty: 2 }, { price: 100, qty: 1 }]), 600);
});

test('applyDiscount accepts a fraction', () => {
  assert.equal(applyDiscount(1000, 0.1), 900);
});

test('applyDiscount accepts a whole percentage', () => {
  // 25 means 25%, not 2500%. This is the seeded bug.
  assert.equal(applyDiscount(1000, 25), 750);
});

test('formatMoney renders cents as currency', () => {
  assert.equal(formatMoney(648), '$6.48');
});
