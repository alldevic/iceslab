package server

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
	"github.com/icecompany-tech/iceslab/apps/node/internal/egress/zapret2"
	"github.com/icecompany-tech/iceslab/apps/node/internal/payload"
)

// Four handlers the panel calls on a schedule, and the write that survives a
// reboot. Measured with `go test -coverprofile`: `handleApplyEgress`,
// `handleMetrics`, `handleUfwPorts`, `writeInboundsAtomically` and
// `ensureFirewallFromStore` were all at 0.0% - the package sat at 56.7%.
//
// None of them fail loudly when they break. /metrics answering 500 makes a
// healthy node look down on the dashboard; /ufwPorts answering the wrong shape
// makes the exposure check either silent or wrong; /applyEgress refusing on a
// node with no zapret2 provisioning makes the panel retry a push forever; and
// an inbound store written with the wrong mode leaves REALITY private keys
// world-readable on the box.

func discardLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func post(t *testing.T, srv *Server, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	rr := httptest.NewRecorder()
	srv.routes().ServeHTTP(rr, httptest.NewRequest(http.MethodPost, path, strings.NewReader(body)))
	return rr
}

func get(t *testing.T, srv *Server, path string) *httptest.ResponseRecorder {
	t.Helper()
	rr := httptest.NewRecorder()
	srv.routes().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, path, nil))
	return rr
}

// ───── /applyEgress ─────

// The common fleet: no zapret2 provisioning at all. The push must be ACKED as
// "understood, nothing applied" rather than refused - a 4xx or 5xx here is a
// push the panel keeps retrying against every node that does not run egress.
func TestApplyEgressAcksWhenNoManagerIsConfigured(t *testing.T) {
	srv := newServerWith(t)

	rr := post(t, srv, "/applyEgress", `{"enabled":true,"config":"NFQWS2_OPT=--dpi-desync=fake"}`)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 on a node with no egress manager; body=%s", rr.Code, rr.Body.String())
	}
	var out dto.ApplyEgressResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v (%s)", err, rr.Body.String())
	}
	if !out.OK {
		t.Error("ok = false; the push was understood, it simply had nothing to apply")
	}
	if out.Applied {
		t.Error("applied = true on a node with no egress manager")
	}
}

// A dormant manager (config path set, no up command) writes the file and skips
// the exec. That is the whole B2 contract on a node where the stack is staged
// but not started, and it is what makes the panel's config the source of truth.
func TestApplyEgressWritesTheConfigThePanelPushed(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config")
	mgr := zapret2.New(zapret2.Config{ConfigPath: path}, discardLogger())
	srv := newServerWithEgress(t, mgr)

	body := `{"enabled":true,"config":"NFQWS2_OPT=--dpi-desync=fake,split2\nMODE=nfqws"}`
	rr := post(t, srv, "/applyEgress", body)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", rr.Code, rr.Body.String())
	}
	var out dto.ApplyEgressResponse
	_ = json.Unmarshal(rr.Body.Bytes(), &out)
	if !out.Applied {
		t.Error("applied = false, but the manager had a config path to write to")
	}

	written, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("the config the panel pushed was not written: %v", err)
	}
	if !strings.Contains(string(written), "--dpi-desync=fake,split2") {
		t.Errorf("written config does not carry what the panel sent:\n%s", written)
	}

	// Idempotent: the same push again must not report a fresh apply, or the
	// panel reads a re-push as a change every time it reconciles.
	rr = post(t, srv, "/applyEgress", body)
	_ = json.Unmarshal(rr.Body.Bytes(), &out)
	if out.Applied {
		t.Error("the same push applied twice; re-pushing an unchanged policy is a no-op")
	}
}

func TestApplyEgressRejectsWhatItCannotRead(t *testing.T) {
	srv := newServerWith(t)

	rr := get(t, srv, "/applyEgress")
	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET /applyEgress = %d, want 405", rr.Code)
	}

	rr = post(t, srv, "/applyEgress", `{"enabled":`)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("malformed body = %d, want 400", rr.Code)
	}
}

// ───── /metrics ─────

// Polled every 15 seconds. A 500 here reads as a node that stopped answering.
//
// The handler's partial-failure branch (log a warning, serve what was
// collected) is deliberately NOT asserted: reaching it needs every /proc reader
// to fail at once, which no healthy host does, and a check that cannot fail is
// not a check. Measured - a mutant turning that branch into a 500 stays green
// here, because the branch is never entered.
func TestMetricsAnswersWithTheHostSnapshot(t *testing.T) {
	srv := newServerWith(t)

	rr := get(t, srv, "/metrics")
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
	if rr := post(t, srv, "/metrics", "{}"); rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /metrics = %d, want 405", rr.Code)
	}
}

// ───── /ufwPorts ─────

// `managed:false` is how the panel is told to SKIP the exposure check rather
// than to report every node as wide open. On a host without ufw - this one -
// that is the answer.
func TestUfwPortsReportsUnmanagedRatherThanFailing(t *testing.T) {
	srv := newServerWith(t)

	rr := get(t, srv, "/ufwPorts")
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 even with no ufw on the box; body=%s", rr.Code, rr.Body.String())
	}

	// Read as raw JSON: `ports` must be an empty ARRAY, not null. A null is a
	// runtime error in any client that iterates it, and the panel does.
	var raw map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if _, isArray := raw["ports"].([]any); !isArray {
		t.Errorf("ports is %T, want an array (a null breaks every client that iterates)", raw["ports"])
	}

	// Asked the same way the handler asks it - exec.LookPath, not a guess at
	// where the binary lives. The first version of this checked /usr/sbin/ufw
	// and skipped its own assertion on a host where the path did not match,
	// which made the check unfalsifiable.
	var out dto.UfwPortsResponse
	_ = json.Unmarshal(rr.Body.Bytes(), &out)
	_, ufwErr := exec.LookPath("ufw")
	if ufwErr != nil && out.Managed {
		t.Error("managed = true on a host with no ufw; the panel would compare its expected " +
			"port set against nothing and report every node as clean")
	}
	if ufwErr == nil && !out.Managed {
		t.Error("managed = false on a host that HAS ufw; the exposure check would never run")
	}
}

func TestUfwPortsIsGetOnly(t *testing.T) {
	srv := newServerWith(t)
	if rr := post(t, srv, "/ufwPorts", "{}"); rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /ufwPorts = %d, want 405", rr.Code)
	}
}

// ───── the inbound store ─────

// What the agent re-reads after a reboot to bring cores up before the panel has
// pushed anything. It holds REALITY private keys and shadowsocks PSKs.
func TestInboundStoreIsWrittenPrivatelyAndCompletely(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "dir", "inbounds.json")
	in := []dto.InboundDto{
		{ID: "i1", Name: "vless", Protocol: dto.ProtocolXray, Port: 443, Config: json.RawMessage(`{"security":"reality"}`)},
		{ID: "i2", Name: "hy2", Protocol: dto.ProtocolHysteria, Engine: dto.EngineSingbox, Port: 8443, Config: json.RawMessage(`{}`)},
	}

	if err := writeInboundsAtomically(path, in); err != nil {
		t.Fatalf("write: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("the parent directories were not created: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("mode = %o, want 600: this file holds private keys", perm)
	}

	var back []dto.InboundDto
	raw, _ := os.ReadFile(path)
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("what was written is not valid JSON: %v\n%s", err, raw)
	}
	if len(back) != 2 || back[0].ID != "i1" || back[1].Engine != dto.EngineSingbox {
		t.Errorf("round trip lost something: %+v", back)
	}
}

// A second push replaces the first completely. A partial overwrite would leave
// the tail of a longer previous set behind - trailing JSON that fails to parse
// on the next boot, which is the boot where nothing is running yet.
func TestInboundStoreOverwriteLeavesNoRemnants(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "inbounds.json")

	long := make([]dto.InboundDto, 0, 5)
	for i := 0; i < 5; i++ {
		long = append(long, dto.InboundDto{ID: "long", Name: "x", Protocol: dto.ProtocolXray, Config: json.RawMessage(`{}`)})
	}
	if err := writeInboundsAtomically(path, long); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := writeInboundsAtomically(path, []dto.InboundDto{{ID: "short", Protocol: dto.ProtocolXray, Config: json.RawMessage(`{}`)}}); err != nil {
		t.Fatalf("rewrite: %v", err)
	}

	var back []dto.InboundDto
	raw, _ := os.ReadFile(path)
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("the rewritten file does not parse: %v\n%s", err, raw)
	}
	if len(back) != 1 || back[0].ID != "short" {
		t.Errorf("the previous set survived the rewrite: %+v", back)
	}

	// Atomic means via a temp file that is renamed, and the temp file must not
	// be left behind next to the real one.
	entries, _ := os.ReadDir(dir)
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
func TestInboundStoreWritesTheEmptySet(t *testing.T) {
	path := filepath.Join(t.TempDir(), "inbounds.json")
	if err := writeInboundsAtomically(path, []dto.InboundDto{}); err != nil {
		t.Fatalf("write: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if strings.TrimSpace(string(raw)) != "[]" {
		t.Errorf("empty set written as %q, want []", raw)
	}
}

// newServerWithEgress builds a server whose /applyEgress has a real (dormant)
// zapret2 manager behind it, rather than the nil the other helpers leave.
func newServerWithEgress(t *testing.T, mgr *zapret2.Manager) *Server {
	t.Helper()
	srv, err := New(Config{
		Logger:  discardLogger(),
		Payload: &payload.Payload{NodeCertPem: "x", NodeKeyPem: "y", CACertPem: "z"},
		Egress:  mgr,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return srv
}
