package singbox

import (
	"encoding/json"
	"testing"
)

// The other half of the disagreement documented in
// internal/core/xray/stats_emptyvalue_test.go: a counter arriving as `""` is
// REJECTED here and accepted as zero there, and neither copy knows about the
// other.
//
// This side is the stricter one, and for cumulative counters the stricter
// reading is the safer one: (0, false) skips the entry and leaves the panel's
// snapshot untouched, so the next poll re-derives the same delta, whereas
// (0, true) claims the counter now reads zero — which for a cumulative counter
// is indistinguishable from a core that just restarted.
//
// Pinned so that a later "simplification" that drops the empty check here —
// making the two copies agree by accident, on the looser behaviour — has to be
// a decision rather than a diff nobody reads.
func TestStatEntryInt64_EmptyQuotedValueIsRejected(t *testing.T) {
	if got, ok := statEntryInt64(json.RawMessage(`""`)); ok {
		t.Errorf(`statEntryInt64("\"\"") = (%d, true); this side rejects an empty counter on `+
			`purpose. The xray copy accepts it as zero — reconcile the two together, not one of them.`, got)
	}
}

// The control: an ordinary quoted number must still be read, or the case above
// would pass against a reader that rejects everything.
func TestStatEntryInt64_QuotedNumberStillReads(t *testing.T) {
	got, ok := statEntryInt64(json.RawMessage(`"4096"`))
	if !ok || got != 4096 {
		t.Errorf(`statEntryInt64("\"4096\"") = (%d, %v), want (4096, true)`, got, ok)
	}
}
