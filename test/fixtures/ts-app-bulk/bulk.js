/** Bulk-order pricing. Prices are integer cents throughout. */

export function bulkUnitPrice(totalCents, qty) {
  // Bug: copy-pasted from cart.js's pricePerItem, same truncation.
  return Math.trunc(totalCents / qty);
}
