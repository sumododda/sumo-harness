// Package promo splits a cart into a head and tail and appends a
// promotional item to the head.
package promo

type Item struct {
	Name  string
	Price int
}

// Split divides items into a head and tail without copying.
func Split(items []Item, at int) (head, tail []Item) {
	return items[:at], items[at:]
}

// AddPromo appends a promotional item to head.
//
// Bug: head shares a backing array with tail (both are views into the same
// items slice), so when head still has spare capacity, append writes into
// that shared array and silently overwrites tail's first element instead of
// allocating new space. The symptom shows up in tail, far from this line.
func AddPromo(head []Item, promo Item) []Item {
	return append(head, promo)
}
