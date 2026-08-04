package discount

import "testing"

func TestPercentageAppliesBeforeFlatBulkDiscount(t *testing.T) {
	// 10% off $100 is $90, then $5 flat off bulk orders is $85. This is the
	// seeded bug: applying the flat amount first gives $85.50 instead.
	if got := StackedPrice(10000, 10, 500); got != 8500 {
		t.Errorf("StackedPrice(10000, 10, 500) = %d, want 8500", got)
	}
}

func TestFlatDiscountWithNoPercentageIsPlainSubtraction(t *testing.T) {
	if got := StackedPrice(10000, 0, 500); got != 9500 {
		t.Errorf("StackedPrice(10000, 0, 500) = %d, want 9500", got)
	}
}
