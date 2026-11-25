package mieru

import (
	"sort"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// mita does expose real counters (`mita get-metrics --output json`); wiring
// them up is a follow-up, so GetStats deliberately reports every tracked user
// with zeroes. That is a soft failure by design and it has one hard
// requirement: the user LIST must still be right. Zero counters read as an
// idle user; a missing user reads as an empty node, and those are different
// claims about the same node.
func TestGetStats_ListsEveryTrackedUserWithZeroCounters(t *testing.T) {
	a := newConfigOnlyAdapter(t)
	for _, u := range []core.User{
		{UserID: "u-1", Username: "alice", XrayUUID: "uuid-a"},
		{UserID: "u-2", Username: "bob", XrayUUID: "uuid-b"},
	} {
		if err := a.AddUser(u); err != nil {
			t.Fatalf("AddUser %s: %v", u.UserID, err)
		}
	}

	stats, err := a.GetStats()
	if err != nil {
		t.Fatalf("GetStats: %v", err)
	}
	ids := make([]string, 0, len(stats.Users))
	for _, u := range stats.Users {
		ids = append(ids, u.UserID)
		if u.BytesIn != 0 || u.BytesOut != 0 {
			t.Errorf("%s: counters are not wired to mita yet, want zeroes, got in=%d out=%d",
				u.UserID, u.BytesIn, u.BytesOut)
		}
	}
	sort.Strings(ids)
	if len(ids) != 2 || ids[0] != "u-1" || ids[1] != "u-2" {
		t.Errorf("users: got %v want [u-1 u-2]", ids)
	}

	// A removed user must leave the report, or a deauthorised account keeps
	// showing up on the node the panel is reconciling against.
	if err := a.RemoveUser("u-1"); err != nil {
		t.Fatalf("RemoveUser: %v", err)
	}
	stats, _ = a.GetStats()
	if len(stats.Users) != 1 || stats.Users[0].UserID != "u-2" {
		t.Errorf("after RemoveUser: %+v", stats.Users)
	}
}

// An adapter nobody has been added to reports an empty list, not nil: the
// caller ranges over it and a nil Stats would panic the metrics poll.
func TestGetStats_EmptyAdapterReportsAnEmptyList(t *testing.T) {
	stats, err := newConfigOnlyAdapter(t).GetStats()
	if err != nil {
		t.Fatalf("GetStats: %v", err)
	}
	if stats == nil {
		t.Fatal("GetStats returned a nil Stats")
	}
	if len(stats.Users) != 0 {
		t.Errorf("users: got %+v want none", stats.Users)
	}
}
