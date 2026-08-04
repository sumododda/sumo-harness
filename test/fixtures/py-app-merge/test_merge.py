from merge import merge_carts


def test_merge_carts_combines_quantities_for_the_same_item_id():
    cart_a = [{"id": "sku-1", "qty": 2}, {"id": "sku-2", "qty": 1}]
    cart_b = [{"id": "sku-1", "qty": 3}, {"id": "sku-3", "qty": 1}]

    merged = merge_carts(cart_a, cart_b)
    by_sku1 = [i for i in merged if i["id"] == "sku-1"]

    # This is the seeded bug: sku-1 currently appears as two separate lines.
    assert len(by_sku1) == 1
    assert by_sku1[0]["qty"] == 5
    assert len(merged) == 3


def test_carts_with_no_overlap_are_unaffected():
    merged = merge_carts([{"id": "sku-1", "qty": 1}], [{"id": "sku-2", "qty": 1}])
    assert len(merged) == 2
