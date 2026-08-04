"""Free-shipping eligibility. Prices are integer cents throughout."""

FREE_SHIPPING_THRESHOLD = 5000


def is_free_shipping(cents):
    # Bug: excludes an order that lands exactly on the threshold.
    return cents > FREE_SHIPPING_THRESHOLD


def shipping_cost(cents):
    return 0 if is_free_shipping(cents) else 499
