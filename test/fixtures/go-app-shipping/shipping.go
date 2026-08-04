// Package shipping computes free-shipping eligibility. Prices are integer
// cents throughout.
package shipping

const FreeShippingThreshold = 5000

// IsFreeShipping has a seeded bug: it excludes an order exactly at the
// threshold.
func IsFreeShipping(cents int) bool {
	return cents > FreeShippingThreshold
}

func ShippingCost(cents int) int {
	if IsFreeShipping(cents) {
		return 0
	}
	return 499
}
