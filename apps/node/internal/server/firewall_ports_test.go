package server

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
)

// fwRecorder stands in for ufw: what was opened and what was closed.
type fwRecorder struct {
	mu             sync.Mutex
	opened, closed []string
}

func recordFirewall(t *testing.T) *fwRecorder {
	t.Helper()
	r := &fwRecorder{}
	oldAllow, oldClose := fwAllow, fwClose
	fwAllow = func(_ context.Context, _ *slog.Logger, port int, proto string) {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.opened = append(r.opened, fmt.Sprintf("%d/%s", port, proto))
	}
	fwClose = func(_ context.Context, _ *slog.Logger, port int, proto string) {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.closed = append(r.closed, fmt.Sprintf("%d/%s", port, proto))
	}
	t.Cleanup(func() { fwAllow, fwClose = oldAllow, oldClose })
	return r
}

func (r *fwRecorder) take() (opened, closed []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	opened, closed = r.opened, r.closed
	r.opened, r.closed = nil, nil
	sort.Strings(opened)
	sort.Strings(closed)
	return opened, closed
}

func inboundsPush(ibs ...string) string {
	return `{"inbounds":[` + strings.Join(ibs, ",") + `]}`
}

func ib(id, protocol string, port int, config string) string {
	return fmt.Sprintf(`{"id":%q,"name":%q,"protocol":%q,"port":%d,"config":%s}`, id, id, protocol, port, config)
}

// A-158: xray on kcp listens on UDP. It got a TCP rule only, and ufw dropped
// every packet of its clients.
func TestAKcpInboundGetsAUdpRule(t *testing.T) {
	fw := recordFirewall(t)
	xray := &pickyServerCore{fakeCore: fakeCore{name: "xray", engine: "xray", running: true}}
	s := serverWithStore(t, filepath.Join(t.TempDir(), "inbounds.json"), xray)
	if code := pushOver(t, s, inboundsPush(ib("k", "xray", 4443, `{"network":"kcp"}`), ib("r", "xray", 443, `{"network":"raw"}`))); code != http.StatusOK {
		t.Fatalf("push answered %d", code)
	}
	opened, _ := fw.take()
	if strings.Join(opened, " ") != "443/tcp 4443/udp" {
		t.Fatalf("opened %v, want 443/tcp for raw and 4443/udp for kcp", opened)
	}
}

// The port of a host the push no longer carries is closed; one another host
// still uses stays open, per transport.
func TestTheRuleOfARemovedHostIsClosed(t *testing.T) {
	fw := recordFirewall(t)
	xray := &pickyServerCore{fakeCore: fakeCore{name: "xray", engine: "xray", running: true}}
	hy := &fakeCore{name: "hysteria", engine: "hysteria", running: true}
	s := serverWithStore(t, filepath.Join(t.TempDir(), "inbounds.json"), xray, hy)

	pushOver(t, s, inboundsPush(ib("a", "xray", 4443, `{}`), ib("b", "hysteria", 443, `{}`), ib("c", "xray", 443, `{}`)))
	fw.take()
	// a removed; b removed while c stays on the same port number over TCP.
	if code := pushOver(t, s, inboundsPush(ib("c", "xray", 443, `{}`))); code != http.StatusOK {
		t.Fatalf("push answered %d", code)
	}
	_, closed := fw.take()
	if strings.Join(closed, " ") != "443/udp 4443/tcp" {
		t.Fatalf("closed %v, want 443/udp (hysteria gone, xray still on 443/tcp) and 4443/tcp", closed)
	}
}

// A refused inbound keeps running on its old port, so that port stays open;
// closing it would cut the users still on it.
func TestARefusedMoveKeepsTheOldPortOpen(t *testing.T) {
	fw := recordFirewall(t)
	xray := &pickyServerCore{fakeCore: fakeCore{name: "xray", engine: "xray", running: true}}
	s := serverWithStore(t, filepath.Join(t.TempDir(), "inbounds.json"), xray)
	pushOver(t, s, inboundsPush(ib("a", "xray", 4443, `{"v":"good"}`)))
	fw.take()
	if code := pushOver(t, s, inboundsPush(ib("a", "xray", 5443, `{"v":"bad"}`))); code != http.StatusInternalServerError {
		t.Fatalf("a refused push answered %d", code)
	}
	if _, closed := fw.take(); len(closed) != 0 {
		t.Fatalf("closed %v while the core still serves the old port", closed)
	}
}

// The SSH port is never closed, whatever was on it.
func TestTheSSHPortIsNeverClosed(t *testing.T) {
	fw := recordFirewall(t)
	xray := &pickyServerCore{fakeCore: fakeCore{name: "xray", engine: "xray", running: true}}
	s := serverWithStore(t, filepath.Join(t.TempDir(), "inbounds.json"), xray)
	pushOver(t, s, inboundsPush(ib("a", "xray", 22, `{}`)))
	fw.take()
	pushOver(t, s, inboundsPush())
	if _, closed := fw.take(); len(closed) != 0 {
		t.Fatalf("closed %v", closed)
	}
}
