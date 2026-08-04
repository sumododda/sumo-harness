/** A tiny shopping cart. Prices are integer cents throughout. */

export function subtotal(items) {
  return items.reduce((total, item) => total + item.price * item.qty, 0);
}

export function applyDiscount(cents, percentOff) {
  // Bug: a whole-number percentage is treated as a fraction.
  return Math.round(cents - cents * percentOff);
}

export function formatMoney(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}
