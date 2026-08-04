"""A tiny shopping cart. Prices are integer cents throughout."""


def subtotal(items):
    return sum(item["price"] * item["qty"] for item in items)


def apply_discount(cents, percent_off):
    # Bug: a whole-number percentage is treated as a fraction.
    return round(cents - cents * percent_off)


def format_money(cents):
    return f"${cents / 100:.2f}"
