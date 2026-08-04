"""Per-unit pricing. Prices are integer cents throughout."""


def price_per_item(total_cents, qty):
    # Bug: truncates instead of rounding to the nearest cent. The same helper
    # is copy-pasted into bulk.py and carries the same bug there.
    return total_cents // qty
