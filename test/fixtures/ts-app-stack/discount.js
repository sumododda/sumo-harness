/** Stacks a percentage discount with a flat bulk discount. Prices are integer cents. */

export function stackedPrice(cents, percentOff, bulkFlatOff) {
  // Bug: subtracts the flat amount before applying the percentage, so the
  // flat amount itself gets discounted too instead of coming off afterward.
  return Math.round((cents - bulkFlatOff) * (1 - percentOff / 100));
}
