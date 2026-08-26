package singbox

import (
	"encoding/json"
	"testing"
)

// The other half of what used to be a disagreement: a counter arriving as `""`
// is rejected here, and — since 2026-08-26 — on the xray side too. This copy
// was always the stricter one; the two were reconciled onto it rather than
// onto the looser reading, because for CUMULATIVE counters (0, false) skips
// the entry and leaves the panel's snapshot untouched, so the next poll
// re-derives the same delta, whereas (0, true) claims the counter now reads
// zero — indistinguishable from a core that just restarted.
//
// Still pinned separately from the xray one: they are two functions in two
// packages, and a later "simplification" that drops this check would put them
// back out of step without touching the other file.
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
