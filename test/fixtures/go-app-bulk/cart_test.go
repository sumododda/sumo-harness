package bulkpricing

import "testing"

func TestPricePerItemRoundsToNearestCent(t *testing.T) {
	// 1007 / 4 = 251.75, which rounds up, not down. This is the seeded bug.
	if got := PricePerItem(1007, 4); got != 252 {
		t.Errorf("PricePerItem(1007, 4) = %d, want 252", got)
	}
}

func TestBulkUnitPriceRoundsToNearestCentToo(t *testing.T) {
	// Copy-pasted from cart.go; fixing only one file leaves this red.
	if got := BulkUnitPrice(1007, 4); got != 252 {
		t.Errorf("BulkUnitPrice(1007, 4) = %d, want 252", got)
	}
}

func TestExactDivisionIsUnaffectedEitherWay(t *testing.T) {
	if got := PricePerItem(1000, 4); got != 250 {
		t.Errorf("PricePerItem(1000, 4) = %d, want 250", got)
	}
	if got := BulkUnitPrice(1000, 4); got != 250 {
		t.Errorf("BulkUnitPrice(1000, 4) = %d, want 250", got)
	}
}
