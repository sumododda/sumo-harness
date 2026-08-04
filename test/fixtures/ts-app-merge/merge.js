/** Merges two carts, combining quantities for matching item ids. */

export function mergeCarts(cartA, cartB) {
  // Bug: concatenates without combining matching ids, so a shared item shows
  // up as two separate lines instead of one with a summed quantity.
  return [...cartA, ...cartB];
}
