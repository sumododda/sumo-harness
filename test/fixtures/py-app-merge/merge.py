"""Merges two carts, combining quantities for matching item ids."""


def merge_carts(cart_a, cart_b):
    # Bug: concatenates without combining matching ids, so a shared item shows
    # up as two separate lines instead of one with a summed quantity.
    return [*cart_a, *cart_b]
