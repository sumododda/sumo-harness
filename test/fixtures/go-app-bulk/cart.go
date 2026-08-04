// Package bulkpricing computes per-unit pricing. Prices are integer cents
// throughout.
package bulkpricing

// PricePerItem has a seeded bug: it truncates instead of rounding to the
// nearest cent. The same helper is copy-pasted into bulk.go and carries the
// same bug there.
func PricePerItem(totalCents, qty int) int {
	return totalCents / qty
}
