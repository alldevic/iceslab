package xray

import (
	"encoding/json"
	"testing"
)

// A counter that arrives as `""` — an empty QUOTED string — is read by the two
// stats readers in this repository DIFFERENTLY, and neither knows about the
// other.
//
//	xray    (here):                     statEntryInt64(`""`) = (0, true)
//	sing-box (internal/core/singbox):   statEntryInt64(`""`) = (0, false)
//
// Both are deliberate. This side's `parseInt64String` has always returned
// (0, nil) for a digitless string, and stats_test.go pins that with a comment
// saying so. The sing-box copy added an explicit empty check and rejects it.
//
// The difference is not cosmetic, because these are CUMULATIVE counters and
// the panel derives deltas from its own snapshot:
//
//	(0, false) is "no reading" — the entry is skipped and the panel's snapshot
//	           stays where it was, so the next poll re-derives the same delta.
//	(0, true)  is "the counter now reads zero" — which for a cumulative counter
//	           is what a RESTARTED core looks like, and the delta logic has to
//	           decide whether that is a rollover or a genuine zero.
//
// Written after finding the two copies disagreeing (2026-08-26). It pins what
// each side does TODAY so the difference stops being invisible; which of the
// two is right is a decision about traffic accounting and is recorded as an
// open question rather than settled here.
func TestStatEntryInt64_EmptyQuotedValueReadsAsZero(t *testing.T) {
	got, ok := statEntryInt64(json.RawMessage(`""`))
	if !ok {
		t.Fatalf(`statEntryInt64("\"\"") reported the value unusable; this side accepts it as zero. `+
			`If that changed on purpose, the sing-box copy already behaves that way and the two `+
			`should be reconciled together. got=(%d, %v)`, got, ok)
	}
	if got != 0 {
		t.Errorf(`statEntryInt64("\"\"") = %d, want 0`, got)
	}
}

// The control: real garbage must still be rejected, or the case above would
// pass against a reader that accepts anything as zero.
func TestStatEntryInt64_GarbageIsStillRejected(t *testing.T) {
	for _, raw := range []string{`"abc"`, `"-5"`, `"12x"`} {
		if _, ok := statEntryInt64(json.RawMessage(raw)); ok {
			t.Errorf("statEntryInt64(%s) was accepted", raw)
		}
	}
}
