from discount import stacked_price


def test_the_percentage_applies_before_the_flat_bulk_discount():
    # 10% off $100 is $90, then $5 flat off bulk orders is $85. This is the
    # seeded bug: applying the flat amount first gives $85.50 instead.
    assert stacked_price(10000, 10, 500) == 8500


def test_a_flat_discount_with_no_percentage_is_a_plain_subtraction():
    assert stacked_price(10000, 0, 500) == 9500
