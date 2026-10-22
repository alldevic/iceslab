package singbox

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
	"github.com/icecompany-tech/iceslab/apps/node/internal/core/subprocess"
)

// A-163, 22.10: a statsquery that failed was answered with every user at 0,
// on counters that are cumulative. The panel read that as a counter reset,
// re-baselined each snapshot to 0, and the next good poll billed the whole
// counter at once. Now it is NoData and the users are left out.
func TestAFailedStatsqueryIsNoDataNotZeros(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	a := New(Config{
		Protocol:     "tuic",
		BinaryPath:   "/usr/bin/sing-box",
		StatsListen:  "127.0.0.1:8082",
		XrayStatsBin: "/usr/bin/xray",
		RunCmd: func(context.Context, string, ...string) ([]byte, error) {
			return nil, errors.New("connection refused")
		},
	}, logger)
	a.users["u-1"] = userEntry{UUID: "x", Password: "y"}
	a.proc = subprocess.New(subprocess.Config{Name: "sing-box-stub", Binary: "/bin/sleep", Args: []string{"30"}, Logger: logger})
	if err := a.proc.Start(context.Background()); err != nil {
		t.Fatalf("start stub: %v", err)
	}
	defer func() { _ = a.proc.Stop(context.Background()) }()

	stats, err := a.GetStats()
	if err != nil {
		t.Fatalf("GetStats must not fail the poll: %v", err)
	}
	want := core.Stats{NoData: true, Cumulative: true}
	if !stats.NoData || len(stats.Users) != 0 || !stats.Cumulative {
		t.Fatalf("got %+v, want %+v", *stats, want)
	}
}
