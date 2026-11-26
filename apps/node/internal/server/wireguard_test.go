package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
	"github.com/icecompany-tech/iceslab/apps/node/internal/core/amneziawg"
	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
)

// Plain WireGuard (milestone 9.1): the amneziawg package's second instance, in
// the same registry as the AmneziaWG one. Real adapters in config-only mode (no
// CLI), so what each instance holds shows in its config file.

const (
	wgTestKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
	wgPeerA   = "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
	wgPeerB   = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
)

func twoWireGuards(t *testing.T) (srv *Server, plain, awg *amneziawg.Adapter, dir string) {
	t.Helper()
	dir = t.TempDir()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	plain = amneziawg.New(amneziawg.Config{
		Protocol:   amneziawg.NameWireguard,
		ConfigPath: filepath.Join(dir, "wg0.conf"),
	}, logger)
	awg = amneziawg.New(amneziawg.Config{
		ConfigPath: filepath.Join(dir, "awg0.conf"),
	}, logger)
	return newServerWith(t, awg, plain), plain, awg, dir
}

func wgPush(t *testing.T) dto.ApplyInboundsRequest {
	t.Helper()
	return dto.ApplyInboundsRequest{Inbounds: []dto.InboundDto{
		{ID: "ib-wg", Protocol: "wireguard", Port: 51899, Config: json.RawMessage(
			`{"subnet":"10.77.77.0/24","serverPrivateKey":"` + wgTestKey + `","serverPublicKey":"` + wgTestKey + `","inboundId":"ib-wg"}`)},
		{ID: "ib-awg", Protocol: "amneziawg", Port: 51820, Config: json.RawMessage(
			`{"subnet":"10.66.66.0/24","serverPrivateKey":"` + wgTestKey + `","inboundId":"ib-awg",` +
				`"obfuscation":{"jc":4,"jmin":40,"jmax":70,"s1":72,"s2":56,"s3":32,"s4":16,"h1":100,"h2":200,"h3":300,"h4":400}}`)},
	}}
}

func readConf(t *testing.T, dir, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(b)
}

// The protocol and the engine are both "wireguard"; the pair finds the plain
// instance and not the AmneziaWG one, whichever is registered first.
func TestAWireguardInboundGoesToThePlainInstanceAlone(t *testing.T) {
	srv, plain, awg, dir := twoWireGuards(t)
	if plain.Name() != "wireguard" || plain.Engine() != "wireguard" {
		t.Fatalf("plain instance answers %s/%s", plain.Name(), plain.Engine())
	}
	if srv.adapterFor(dto.InboundDto{Protocol: "wireguard"}) != core.CoreAdapter(plain) {
		t.Error("a wireguard inbound did not find the plain instance")
	}
	if srv.adapterFor(dto.InboundDto{Protocol: "amneziawg"}) != core.CoreAdapter(awg) {
		t.Error("an amneziawg inbound did not find the AmneziaWG instance")
	}
	if coreKey(plain) == coreKey(awg) {
		t.Errorf("both instances are one key in the stored maps: %s", coreKey(plain))
	}

	srv.applyPush(context.Background(), dto.ApplyInboundsRequest{Inbounds: wgPush(t).Inbounds[:1]})
	wg := readConf(t, dir, "wg0.conf")
	if !strings.Contains(wg, "ListenPort = 51899") || strings.Contains(wg, "H1 =") {
		t.Errorf("wg0.conf:\n%s", wg)
	}
	if _, err := os.Stat(filepath.Join(dir, "awg0.conf")); err == nil {
		t.Error("a wireguard push wrote the AmneziaWG config")
	}
}

// addUser with wireguard* keys reaches the plain instance and not AmneziaWG; a
// user carrying both gets each its own address; the other flavour's user is not
// taken by the plain one.
func TestAddUserWithWireguardKeysReachesOnlyThePlainInstance(t *testing.T) {
	srv, _, _, dir := twoWireGuards(t)
	srv.applyPush(context.Background(), wgPush(t))

	post := func(body string) {
		t.Helper()
		rr := httptest.NewRecorder()
		srv.routes().ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/addUser", strings.NewReader(body)))
		if rr.Code != http.StatusOK {
			t.Fatalf("addUser: %d %s", rr.Code, rr.Body.String())
		}
	}
	post(`{"userId":"u-1","username":"wg-only","credentials":{"wireguardPublicKey":"` + wgPeerA + `","wireguardAllowedIp":"10.77.77.2"}}`)
	post(`{"userId":"u-2","username":"awg-only","credentials":{"amneziawgPublicKey":"` + wgPeerB + `","amneziawgAllowedIp":"10.66.66.2"}}`)

	wg, awg := readConf(t, dir, "wg0.conf"), readConf(t, dir, "awg0.conf")
	if !strings.Contains(wg, wgPeerA) || !strings.Contains(wg, "10.77.77.2/32") {
		t.Errorf("wg0.conf lacks the plain user:\n%s", wg)
	}
	if strings.Contains(wg, wgPeerB) || strings.Contains(wg, "10.66.66.2") {
		t.Errorf("wg0.conf took the AmneziaWG user:\n%s", wg)
	}
	if !strings.Contains(awg, wgPeerB) || !strings.Contains(awg, "10.66.66.2/32") {
		t.Errorf("awg0.conf lacks the AmneziaWG user:\n%s", awg)
	}
	if strings.Contains(awg, wgPeerA) || strings.Contains(awg, "10.77.77.2") {
		t.Errorf("awg0.conf took the plain user:\n%s", awg)
	}
}

// The two interface names are in /healthz as two cores; the AmneziaWG-only
// generation fields stay on the AmneziaWG row.
func TestHealthzListsTheTwoInstancesApart(t *testing.T) {
	_, plain, awg, _ := twoWireGuards(t)
	h := health(t, awg, plain)
	byName := map[string]dto.CoreStatus{}
	for _, c := range h.Cores {
		byName[string(c.Name)+"/"+c.Engine] = c
	}
	if _, ok := byName["amneziawg/amneziawg"]; !ok {
		t.Errorf("no amneziawg row: %+v", h.Cores)
	}
	row, ok := byName["wireguard/wireguard"]
	if !ok {
		t.Fatalf("no wireguard row: %+v", h.Cores)
	}
	if row.AwgGenerations != nil || row.AwgProtocol != 0 {
		t.Errorf("the plain row carries AmneziaWG generations: %+v", row)
	}
}

func TestProtoForInboundWireguardIsUDP(t *testing.T) {
	got := protoForInbound(dto.ProtocolName("wireguard"))
	if len(got) != 1 || got[0] != "udp" {
		t.Errorf("protoForInbound(wireguard) = %v, want [udp]", got)
	}
}
