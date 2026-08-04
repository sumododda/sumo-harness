package shipping

import "testing"

func TestOrderUnderThresholdPaysForShipping(t *testing.T) {
	if IsFreeShipping(4999) {
		t.Errorf("IsFreeShipping(4999) = true, want false")
	}
	if got := ShippingCost(4999); got != 499 {
		t.Errorf("ShippingCost(4999) = %d, want 499", got)
	}
}

func TestOrderOverThresholdShipsFree(t *testing.T) {
	if !IsFreeShipping(5001) {
		t.Errorf("IsFreeShipping(5001) = false, want true")
	}
}

func TestOrderExactlyAtThresholdShipsFree(t *testing.T) {
	// $50.00 is the advertised cutoff, not $50.01. This is the seeded bug.
	if !IsFreeShipping(5000) {
		t.Errorf("IsFreeShipping(5000) = false, want true")
	}
	if got := ShippingCost(5000); got != 0 {
		t.Errorf("ShippingCost(5000) = %d, want 0", got)
	}
}
