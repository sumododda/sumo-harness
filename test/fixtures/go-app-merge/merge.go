// Package merge combines two carts, summing quantities for matching item
// ids.
package merge

type Item struct {
	ID  string
	Qty int
}

// MergeCarts has a seeded bug: it concatenates without combining matching
// ids, so a shared item shows up as two separate lines instead of one with
// a summed quantity.
func MergeCarts(cartA, cartB []Item) []Item {
	return append(append([]Item{}, cartA...), cartB...)
}
