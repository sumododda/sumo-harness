package cart

import "testing"

func TestSubtotal(t *testing.T) {
	got := Subtotal([]Item{{Price: 250, Qty: 2}, {Price: 100, Qty: 1}})
	if got != 600 {
		t.Errorf("Subtotal() = %d, want 600", got)
	}
}

func TestApplyDiscountFraction(t *testing.T) {
	if got := ApplyDiscount(1000, 0.1); got != 900 {
		t.Errorf("ApplyDiscount(1000, 0.1) = %d, want 900", got)
	}
}

func TestApplyDiscountWholePercentage(t *testing.T) {
	// 25 means 25%, not 2500%. This is the seeded bug.
	if got := ApplyDiscount(1000, 25); got != 750 {
		t.Errorf("ApplyDiscount(1000, 25) = %d, want 750", got)
	}
}
