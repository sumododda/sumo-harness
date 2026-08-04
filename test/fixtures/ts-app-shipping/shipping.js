/** Free-shipping eligibility. Prices are integer cents throughout. */

const FREE_SHIPPING_THRESHOLD = 5000;

export function isFreeShipping(cents) {
  // Bug: excludes an order that lands exactly on the threshold.
  return cents > FREE_SHIPPING_THRESHOLD;
}

export function shippingCost(cents) {
  return isFreeShipping(cents) ? 0 : 499;
}
