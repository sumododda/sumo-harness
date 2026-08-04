// Package cart is a tiny shopping cart. Prices are integer cents throughout.
package cart

import "math"

type Item struct {
	Price int
	Qty   int
}

func Subtotal(items []Item) int {
	total := 0
	for _, item := range items {
		total += item.Price * item.Qty
	}
	return total
}

// ApplyDiscount has a seeded bug: a whole-number percentage is treated as a fraction.
func ApplyDiscount(cents int, percentOff float64) int {
	return int(math.Round(float64(cents) - float64(cents)*percentOff))
}
