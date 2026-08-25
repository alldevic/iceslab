package subprocess

import "testing"

// What a core printed last is its reason for being down, and the reason lives at
// the END of these lines: xray nests with " > " and wrapped Go errors with ": ",
// both putting the root cause last. Truncating from the front keeps the
// outermost context and throws away the cause.
func TestRecordLastLine_KeepsTheRootCause(t *testing.T) {
	s := &Subprocess{}
	// The real one, from a node whose listen port was taken.
	long := "Failed to start: app/proxyman/inbound: failed to listen TCP on 8443 > " +
		"transport/internet: failed to listen on address: 0.0.0.0:8443 > " +
		"transport/internet/tcp: failed to listen TCP on 0.0.0.0:8443 > " +
		"listen tcp 0.0.0.0:8443: bind: address already in use"
	s.recordLastLine(long)

	got := s.LastLine()
	if len(got) > maxLastLine+3 {
		t.Errorf("kept %d chars, cap is %d(+ellipsis)", len(got), maxLastLine)
	}
	if !contains(got, "address already in use") {
		t.Errorf("the root cause was truncated away; kept: %q", got)
	}
	if !contains(got, "...") {
		t.Error("a truncated line must not read as a whole sentence")
	}
}

// The control: a line that fits is kept whole, ellipsis and all left off.
func TestRecordLastLine_ShortLineKeptWhole(t *testing.T) {
	s := &Subprocess{}
	s.recordLastLine("  bind: address already in use  ")
	if got := s.LastLine(); got != "bind: address already in use" {
		t.Errorf("short line mangled: %q", got)
	}
}

// Blank output must not overwrite a real reason with nothing - a core often
// prints an empty line on its way out.
func TestRecordLastLine_BlankDoesNotErase(t *testing.T) {
	s := &Subprocess{}
	s.recordLastLine("bind: address already in use")
	s.recordLastLine("   ")
	s.recordLastLine("")
	if got := s.LastLine(); got != "bind: address already in use" {
		t.Errorf("a blank line erased the reason: %q", got)
	}
}

func contains(h, n string) bool {
	for i := 0; i+len(n) <= len(h); i++ {
		if h[i:i+len(n)] == n {
			return true
		}
	}
	return false
}
