package promo

import "testing"

func TestAddPromoDoesNotCorruptTail(t *testing.T) {
	items := []Item{
		{Name: "shirt", Price: 2000},
		{Name: "socks", Price: 500},
		{Name: "hat", Price: 1500},
	}
	head, tail := Split(items, 1)

	head = AddPromo(head, Item{Name: "promo", Price: 0})

	// This is the seeded bug: appending to head silently overwrote tail[0]
	// because head and tail share a backing array.
	if tail[0].Name != "socks" {
		t.Errorf("tail[0].Name = %q, want %q", tail[0].Name, "socks")
	}
	if len(head) != 2 || head[1].Name != "promo" {
		t.Errorf("head = %+v, want promo appended", head)
	}
}
