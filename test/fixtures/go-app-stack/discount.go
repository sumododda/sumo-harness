// Package discount stacks a percentage discount with a flat bulk discount.
// Prices are integer cents throughout.
package discount

import "math"

// StackedPrice has a seeded bug: it subtracts the flat amount before
// applying the percentage, so the flat amount itself gets discounted too
// instead of coming off afterward.
func StackedPrice(cents, percentOff, bulkFlatOff int) int {
	return int(math.Round(float64(cents-bulkFlatOff) * (1 - float64(percentOff)/100)))
}
