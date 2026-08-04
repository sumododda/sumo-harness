"""Stacks a percentage discount with a flat bulk discount. Prices are integer cents."""


def stacked_price(cents, percent_off, bulk_flat_off):
    # Bug: subtracts the flat amount before applying the percentage, so the
    # flat amount itself gets discounted too instead of coming off afterward.
    return round((cents - bulk_flat_off) * (1 - percent_off / 100))
