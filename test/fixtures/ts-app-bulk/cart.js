/** Per-unit pricing. Prices are integer cents throughout. */

export function pricePerItem(totalCents, qty) {
  // Bug: truncates instead of rounding to the nearest cent. The same helper
  // is copy-pasted into bulk.js and carries the same bug there.
  return Math.trunc(totalCents / qty);
}
