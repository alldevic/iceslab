package main

import (
	"io"
	"log/slog"
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/metrics"
)

// `xrayMemoryCeiling` turns XRAY_MEM_LIMIT_PERCENT into the byte figure the
// subprocess watchdog compares RSS against. It is the third and last part of
// one number: `metrics.TotalRAMBytes` (covered in §38) supplies the host RAM,
// `readRSSBytes` (covered in §43.7) supplies the sample, and this decides the
// line between them. `go test -coverpkg` reported it at 0.0% — package `main`
// had no test file at all.
//
// Every branch here is a way to get the watchdog wrong in a direction nobody
// notices:
//
//   - a ceiling set too low restarts a healthy core, and a restart drops every
//     live connection on the node (xray has no drain);
//   - a ceiling of zero disarms the watchdog entirely, which looks exactly like
//     a watchdog that is armed and has never had to fire;
//   - a percentage above 100 is a ceiling that can never be reached, which is
//     the same thing wearing a number.

func quietLogger() (*slog.Logger, *strings.Builder) {
	var b strings.Builder
	return slog.New(slog.NewTextHandler(io.MultiWriter(&b, io.Discard), nil)), &b
}

func TestXrayMemoryCeiling_DefaultIsAShareOfHostRAM(t *testing.T) {
	total, err := metrics.TotalRAMBytes()
	if err != nil {
		t.Skipf("host RAM unreadable here: %v", err)
	}
	t.Setenv("XRAY_MEM_LIMIT_PERCENT", "")

	logger, log := quietLogger()
	got := xrayMemoryCeiling(logger)

	want := total / 100 * uint64(defaultXrayMemLimitPercent)
	if got != want {
		t.Errorf("ceiling = %d, want %d (%d%% of %d)", got, want, defaultXrayMemLimitPercent, total)
	}
	// It must also be BELOW host RAM, or it is not a ceiling. Guards the
	// arithmetic itself: a percent/100 mix-up still produces a plausible
	// uint64, and one that is larger than the box can never fire.
	if got >= total {
		t.Errorf("ceiling %d is not below host RAM %d, so it can never be reached", got, total)
	}
	if !strings.Contains(log.String(), "armed") {
		t.Errorf("an armed ceiling went unlogged, so an operator cannot tell it from a disarmed one; log:\n%s", log.String())
	}
}

func TestXrayMemoryCeiling_ZeroDisarmsAndSaysSo(t *testing.T) {
	t.Setenv("XRAY_MEM_LIMIT_PERCENT", "0")
	logger, log := quietLogger()
	if got := xrayMemoryCeiling(logger); got != 0 {
		t.Errorf("ceiling = %d, want 0 (disarmed)", got)
	}
	// A disarmed watchdog is indistinguishable from an armed one that has never
	// fired, so the only way an operator learns which they have is this line.
	if !strings.Contains(log.String(), "disabled") {
		t.Errorf("the watchdog was disarmed silently; log:\n%s", log.String())
	}
}

// A negative percentage is not a smaller ceiling: `total/100*uint64(pct)` on a
// negative int would wrap to an enormous number, i.e. a ceiling that never
// fires. It has to land on the disarmed branch instead.
func TestXrayMemoryCeiling_NegativeDisarmsRatherThanWrapping(t *testing.T) {
	t.Setenv("XRAY_MEM_LIMIT_PERCENT", "-10")
	logger, _ := quietLogger()
	if got := xrayMemoryCeiling(logger); got != 0 {
		t.Errorf("ceiling = %d for a negative percentage, want 0", got)
	}
}

func TestXrayMemoryCeiling_AbovePercentIsClampedNotAccepted(t *testing.T) {
	total, err := metrics.TotalRAMBytes()
	if err != nil {
		t.Skipf("host RAM unreadable here: %v", err)
	}
	t.Setenv("XRAY_MEM_LIMIT_PERCENT", "250")
	logger, log := quietLogger()

	got := xrayMemoryCeiling(logger)

	// Clamped to 100, not accepted as 250: at 250 the figure is 2.5x the box
	// and the watchdog silently never fires.
	if got != total/100*100 {
		t.Errorf("ceiling = %d for 250%%, want it clamped to 100%% (%d)", got, total/100*100)
	}
	if !strings.Contains(log.String(), "clamping") {
		t.Errorf("the clamp happened silently, so a typo in the env keeps looking like the value that was typed; log:\n%s", log.String())
	}
}

// Garbage falls back to the default rather than to zero. Zero would disarm the
// watchdog because of a typo, and the log line would say "disabled" as though
// somebody had asked for it.
func TestXrayMemoryCeiling_UnparseableFallsBackToTheDefault(t *testing.T) {
	total, err := metrics.TotalRAMBytes()
	if err != nil {
		t.Skipf("host RAM unreadable here: %v", err)
	}
	t.Setenv("XRAY_MEM_LIMIT_PERCENT", "eighty")
	logger, _ := quietLogger()

	if got := xrayMemoryCeiling(logger); got != total/100*uint64(defaultXrayMemLimitPercent) {
		t.Errorf("ceiling = %d for an unparseable percentage, want the default", got)
	}
}
