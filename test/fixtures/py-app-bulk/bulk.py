"""Bulk-order pricing. Prices are integer cents throughout."""


def bulk_unit_price(total_cents, qty):
    # Bug: copy-pasted from cart.py's price_per_item, same truncation.
    return total_cents // qty
