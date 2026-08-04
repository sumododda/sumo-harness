package merge

import "testing"

func TestMergeCartsCombinesQuantitiesForSameItemID(t *testing.T) {
	cartA := []Item{{ID: "sku-1", Qty: 2}, {ID: "sku-2", Qty: 1}}
	cartB := []Item{{ID: "sku-1", Qty: 3}, {ID: "sku-3", Qty: 1}}

	merged := MergeCarts(cartA, cartB)

	var bySku1 []Item
	for _, item := range merged {
		if item.ID == "sku-1" {
			bySku1 = append(bySku1, item)
		}
	}

	// This is the seeded bug: sku-1 currently appears as two separate lines.
	if len(bySku1) != 1 {
		t.Fatalf("len(bySku1) = %d, want 1", len(bySku1))
	}
	if bySku1[0].Qty != 5 {
		t.Errorf("bySku1[0].Qty = %d, want 5", bySku1[0].Qty)
	}
	if len(merged) != 3 {
		t.Errorf("len(merged) = %d, want 3", len(merged))
	}
}

func TestCartsWithNoOverlapAreUnaffected(t *testing.T) {
	merged := MergeCarts([]Item{{ID: "sku-1", Qty: 1}}, []Item{{ID: "sku-2", Qty: 1}})
	if len(merged) != 2 {
		t.Errorf("len(merged) = %d, want 2", len(merged))
	}
}
