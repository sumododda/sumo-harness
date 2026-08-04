package bulkpricing

// BulkUnitPrice is copy-pasted from cart.go's PricePerItem, same truncation.
func BulkUnitPrice(totalCents, qty int) int {
	return totalCents / qty
}
