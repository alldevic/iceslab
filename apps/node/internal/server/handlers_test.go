package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
)

// Two read-only handlers the panel calls on a schedule, and the write that
// survives a reboot. None of them fail loudly when they break: /metrics
// answering 500 makes a healthy node look down on the dashboard, /ufwPorts
// answering the wrong shape makes the exposure check either silent or wrong,
// and a store that keeps the tail of its previous contents fails to parse on the
// one boot where nothing is running yet.

// getPath and sendTo are named apart from post() in rotate_cert_test.go, which
// takes a value to marshal; these take the raw method and body.
func getPath(srv *Server, path string) *httptest.ResponseRecorder {
	return sendTo(srv, http.MethodGet, path, "")
}

func sendTo(srv *Server, method, path, body string) *httptest.ResponseRecorder {
	rr := httptest.NewRecorder()
	srv.routes().ServeHTTP(rr, httptest.NewRequest(method, path, strings.NewReader(body)))
	return rr
}

// ───── /metrics ─────

// Polled every 15 seconds. The handler's partial-failure branch (log a warning,
// serve what was collected) is deliberately NOT asserted: reaching it needs
// every /proc reader to fail at once, which no healthy host does.
func TestMetricsAnswersWithTheHostSnapshot(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("the collector reads /proc")
	}
	srv := newServerWith(t)

	rr := getPath(srv, "/metrics")
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rr.Code, rr.Body.String())
	}
	var out dto.HostMetricsResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v (%s)", err, rr.Body.String())
	}

	if out.CPU.Cores != runtime.NumCPU() {
		t.Errorf("cores = %d, want %d", out.CPU.Cores, runtime.NumCPU())
	}
	if out.Memory.TotalBytes == 0 {
		t.Error("total memory is 0; the dashboard would show a host with no RAM")
	}
	if out.Memory.UsedPercent < 0 || out.Memory.UsedPercent > 100 {
		t.Errorf("memory used = %.2f%%", out.Memory.UsedPercent)
	}
	if out.Disk.Path != "/" {
		t.Errorf("disk path = %q, want the root filesystem the agent watches", out.Disk.Path)
	}
	if out.Disk.TotalBytes == 0 {
		t.Error("disk total is 0")
	}
	// The panel uses this stamp to tell a fresh sample from a stale one, so it
	// has to be a timestamp it can parse rather than any string.
	if _, err := time.Parse(time.RFC3339Nano, out.CollectedAt); err != nil {
		t.Errorf("collectedAt %q does not parse as RFC3339Nano: %v", out.CollectedAt, err)
	}
	if out.UptimeSeconds < 0 {
		t.Errorf("uptime = %d", out.UptimeSeconds)
	}
}

func TestMetricsIsGetOnly(t *testing.T) {
	srv := newServerWith(t)
	if rr := sendTo(srv, http.MethodPost, "/metrics", "{}"); rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /metrics = %d, want 405", rr.Code)
	}
}

// ───── /ufwPorts ─────

// `managed:false` is how the panel is told to SKIP the exposure check rather
// than to report every node as wide open. The handler asks firewall.ListAllowed,
// which looks ufw up on PATH, so PATH is pointed at an empty directory: the
// answer does not depend on whether the host running the test has ufw.
func TestUfwPortsReportsUnmanagedRatherThanFailing(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	srv := newServerWith(t)

	rr := getPath(srv, "/ufwPorts")
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 even with no ufw on the box; body=%s", rr.Code, rr.Body.String())
	}

	// Read as raw JSON: `ports` must be an empty ARRAY, not null. A null is a
	// runtime error in any client that iterates it, and the panel does.
	var raw map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decode: %v", err)
	}
	ports, isArray := raw["ports"].([]any)
	if !isArray {
		t.Fatalf("ports is %T, want an array (a null breaks every client that iterates)", raw["ports"])
	}
	if len(ports) != 0 {
		t.Errorf("ports = %v on a host with no ufw", ports)
	}
	if raw["managed"] != false {
		t.Errorf("managed = %v on a host with no ufw; the panel would compare its expected "+
			"port set against nothing and report every node as clean", raw["managed"])
	}
}

func TestUfwPortsIsGetOnly(t *testing.T) {
	srv := newServerWith(t)
	if rr := sendTo(srv, http.MethodPost, "/ufwPorts", "{}"); rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /ufwPorts = %d, want 405", rr.Code)
	}
}

// ───── the push store ─────

// What the agent re-reads after a reboot to bring cores up before the panel has
// pushed anything. The mode and the node-level blocks are pinned in
// restore_test.go; what is left is what a REWRITE leaves behind.

// A second push replaces the first completely, and the temp file the atomic
// write goes through is not left next to the real one.
func TestAStoreRewriteLeavesNoTempFilesAndNoRemnants(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "inbounds.json")

	var long dto.ApplyInboundsRequest
	for _, id := range []string{"a", "b", "c", "d", "e"} {
		long.Inbounds = append(long.Inbounds, dto.InboundDto{
			ID: id, Name: "x", Protocol: dto.ProtocolXray, Config: json.RawMessage(`{}`),
		})
	}
	if err := writePushStore(path, long); err != nil {
		t.Fatalf("write: %v", err)
	}
	short := dto.ApplyInboundsRequest{Inbounds: []dto.InboundDto{
		{ID: "short", Name: "x", Protocol: dto.ProtocolXray, Config: json.RawMessage(`{}`)},
	}}
	if err := writePushStore(path, short); err != nil {
		t.Fatalf("rewrite: %v", err)
	}

	// A partial overwrite would leave the tail of the longer set behind:
	// trailing JSON that fails to parse on the next boot.
	back, err := readPushStore(path)
	if err != nil {
		t.Fatalf("the rewritten store does not read back: %v", err)
	}
	if len(back.Inbounds) != 1 || back.Inbounds[0].ID != "short" {
		t.Errorf("the previous set survived the rewrite: %+v", back.Inbounds)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("directory holds %v, want only inbounds.json", names)
	}
}

// The empty set is a legitimate state: the operator removed the last inbound.
// It must be written, not skipped, or the next boot restores a set that was
// deleted.
func TestAnEmptyPushIsWrittenToTheStore(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "inbounds.json")
	if err := writePushStore(path, dto.ApplyInboundsRequest{Inbounds: []dto.InboundDto{}}); err != nil {
		t.Fatalf("write: %v", err)
	}
	back, err := readPushStore(path)
	if err != nil {
		t.Fatalf("an empty push does not read back: %v", err)
	}
	if len(back.Inbounds) != 0 {
		t.Errorf("inbounds = %+v, want none", back.Inbounds)
	}
}
