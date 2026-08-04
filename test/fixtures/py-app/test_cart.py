from cart import apply_discount, format_money, subtotal


def test_subtotal_sums_price_times_quantity():
    assert subtotal([{"price": 250, "qty": 2}, {"price": 100, "qty": 1}]) == 600


def test_apply_discount_accepts_a_fraction():
    assert apply_discount(1000, 0.1) == 900


def test_apply_discount_accepts_a_whole_percentage():
    # 25 means 25%, not 2500%. This is the seeded bug.
    assert apply_discount(1000, 25) == 750


def test_format_money():
    assert format_money(648) == "$6.48"
