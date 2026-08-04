from shipping import is_free_shipping, shipping_cost


def test_an_order_under_the_threshold_pays_for_shipping():
    assert is_free_shipping(4999) is False
    assert shipping_cost(4999) == 499


def test_an_order_over_the_threshold_ships_free():
    assert is_free_shipping(5001) is True


def test_an_order_exactly_at_the_threshold_ships_free():
    # $50.00 is the advertised cutoff, not $50.01. This is the seeded bug.
    assert is_free_shipping(5000) is True
    assert shipping_cost(5000) == 0
