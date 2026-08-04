from bulk import bulk_unit_price
from cart import price_per_item


def test_price_per_item_rounds_to_the_nearest_cent():
    # 1007 / 4 = 251.75, which rounds up, not down. This is the seeded bug.
    assert price_per_item(1007, 4) == 252


def test_bulk_unit_price_rounds_to_the_nearest_cent_too():
    # Copy-pasted from cart.py; fixing only one file leaves this red.
    assert bulk_unit_price(1007, 4) == 252


def test_an_exact_division_is_unaffected_either_way():
    assert price_per_item(1000, 4) == 250
    assert bulk_unit_price(1000, 4) == 250
