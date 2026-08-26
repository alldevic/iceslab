package xray

import (
	"encoding/json"
	"testing"
)

// A counter that arrives as `""` — an empty QUOTED string — is REJECTED, on
// this core and on sing-box alike.
//
// It was not always so. Until 2026-08-26 this side read it as (0, true) — "the
// counter reads zero" — while the sing-box copy of the same parser rejected
// it, and neither knew about the other. Both behaviours were deliberate: this
// parser had always returned (0, nil) for a digitless string and its test
// pinned that with a comment, and the sing-box copy had added an explicit
// empty check.
//
// The two were reconciled on the stricter reading, because these counters are
// CUMULATIVE and the panel derives deltas from its own snapshot:
//
//	(0, false) is "no reading" — the entry is skipped and the snapshot stays
//	           where it was, so the next poll re-derives the same delta.
//	(0, true)  is "the counter now reads zero" — which for a cumulative counter
//	           is what a RESTARTED core looks like, and the delta logic then has
//	           to guess whether that is a rollover or a genuine zero.
//
// Only one of those can invent traffic, so only one of them was a safe default.
func TestStatEntryInt64_EmptyQuotedValueIsRejected(t *testing.T) {
	if got, ok := statEntryInt64(json.RawMessage(`""`)); ok {
		t.Errorf(`statEntryInt64("\"\"") = (%d, true); an empty counter is "no reading", not `+
			`"zero bytes" — reading it as zero makes a cumulative counter look like a core that `+
			`just restarted`, got)
	}
}

// The control: real garbage must still be rejected, and an ordinary quoted
// number must still be read, or the case above would pass against a reader
// that rejects everything.
func TestStatEntryInt64_GarbageRejectedAndNumbersStillRead(t *testing.T) {
	for _, raw := range []string{`"abc"`, `"-5"`, `"12x"`} {
		if _, ok := statEntryInt64(json.RawMessage(raw)); ok {
			t.Errorf("statEntryInt64(%s) was accepted", raw)
		}
	}
	got, ok := statEntryInt64(json.RawMessage(`"4096"`))
	if !ok || got != 4096 {
		t.Errorf(`statEntryInt64("\"4096\"") = (%d, %v), want (4096, true)`, got, ok)
	}
	// And a real zero — the digit, not the absence — still reads as zero.
	if got, ok := statEntryInt64(json.RawMessage(`"0"`)); !ok || got != 0 {
		t.Errorf(`statEntryInt64("\"0\"") = (%d, %v), want (0, true)`, got, ok)
	}
}
