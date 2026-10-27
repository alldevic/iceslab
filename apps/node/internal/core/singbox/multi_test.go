package singbox

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// A-055 on sing-box: two inbounds of one protocol in one process, a user on
// the ones they are scoped to (A-022), a port clash refused by name.

func renderedUsersByTag(t *testing.T, blob []byte) map[string][]string {
	t.Helper()
	var doc struct {
		Inbounds []struct {
			Tag   string `json:"tag"`
			Users []struct {
				Name string `json:"name"`
			} `json:"users"`
		} `json:"inbounds"`
	}
	if err := json.Unmarshal(blob, &doc); err != nil {
		t.Fatal(err)
	}
	out := map[string][]string{}
	for _, in := range doc.Inbounds {
		for _, u := range in.Users {
			out[in.Tag] = append(out[in.Tag], u.Name)
		}
		if _, ok := out[in.Tag]; !ok {
			out[in.Tag] = nil
		}
	}
	return out
}

func TestTwoInboundsOfOneProtocolAreOneConfigWithScopedUsers(t *testing.T) {
	a := New(Config{Protocol: "tuic", BinaryPath: taggedBinary(t, "with_quic")}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	held := []heldInbound{
		{id: "a", cfg: InboundConfig{ListenPort: 1001, ServerName: "n"}},
		{id: "b", cfg: InboundConfig{ListenPort: 1002, ServerName: "n"}},
	}
	users := map[string]userEntry{
		"alice": {UUID: "u-a", Password: "p"},                // every inbound
		"bob":   {UUID: "u-b", Password: "p", Inbounds: "b"}, // scoped
	}
	blob, err := a.renderAll("c", "k", "", held, users)
	if err != nil {
		t.Fatal(err)
	}
	got := renderedUsersByTag(t, blob)
	if len(got) != 2 {
		t.Fatalf("inbounds by tag %v, want two", got)
	}
	for tag, names := range got {
		joined := strings.Join(names, ",")
		switch {
		case strings.HasSuffix(tag, "-a") && joined != "alice":
			t.Errorf("%s carries %q, want alice", tag, joined)
		case strings.HasSuffix(tag, "-b") && joined != "alice,bob":
			t.Errorf("%s carries %q, want alice,bob", tag, joined)
		}
	}
}

func TestASecondInboundOnATakenPortIsRefused(t *testing.T) {
	a := New(Config{Protocol: "tuic"}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := a.ApplyIdentifiedInbound("a", 9443, []byte(`{"serverName":"n"}`)); err != nil {
		t.Fatal(err)
	}
	if err := a.ApplyIdentifiedInbound("b", 9444, []byte(`{"serverName":"n"}`)); err != nil {
		t.Fatalf("a second inbound on its own port: %v", err)
	}
	err := a.ApplyIdentifiedInbound("c", 9443, []byte(`{"serverName":"n"}`))
	if err == nil || !strings.Contains(err.Error(), "9443") {
		t.Fatalf("a clash was not refused by port: %v", err)
	}
	// Re-created under a new id on the same port, in one push: scoped first.
	a.ScopePush([]string{"b", "d"})
	if err := a.ApplyIdentifiedInbound("d", 9443, []byte(`{"serverName":"n"}`)); err != nil {
		t.Fatalf("the replacement of a deleted binding was refused: %v", err)
	}
	if err := a.RetainInbounds([]string{"b", "d"}); err != nil {
		t.Fatal(err)
	}
	if len(a.inbounds) != 2 {
		t.Fatalf("held %v, want b and d", a.inbounds)
	}
}

// Live, pinned engine: two managed shadowsocks inbounds in one process, alice
// scoped to the first, bob to the second. Each gets in through their own and
// not through the other, and the counters come from both ssm-api paths.
func TestLiveTwoShadowsocksInboundsKeepTheirUsersApart(t *testing.T) {
	bin := singboxBin(t)
	portA, portB, ssmPort := free(t), free(t), free(t)
	dir := t.TempDir()
	a := New(Config{Protocol: "shadowsocks", BinaryPath: bin, ConfigPath: filepath.Join(dir, "ss.json"),
		SSMListen: fmt.Sprintf("127.0.0.1:%d", ssmPort)}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Stop(context.Background()) })
	const method = "2022-blake3-aes-128-gcm"
	pskA, pskB := ssKey(), ssKey()
	wire := func(psk string) []byte {
		b, _ := json.Marshal(map[string]string{"method": method, "serverPsk": psk})
		return b
	}
	if err := a.ApplyIdentifiedInbound("in-a", portA, wire(pskA)); err != nil {
		t.Fatalf("inbound A: %v", err)
	}
	if err := a.ApplyIdentifiedInbound("in-b", portB, wire(pskB)); err != nil {
		t.Fatalf("inbound B: %v", err)
	}
	alice := core.User{UserID: "alice", XrayUUID: "11111111-1111-4111-8111-111111111111"}
	bob := core.User{UserID: "bob", XrayUUID: "22222222-2222-4222-8222-222222222222"}
	if err := a.AddUserOn(alice, []string{"in-a"}); err != nil {
		t.Fatal(err)
	}
	if err := a.AddUserOn(bob, []string{"in-b"}); err != nil {
		t.Fatal(err)
	}

	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") }))
	defer target.Close()
	clientVia := func(name string, port int, psk string, u core.User) int {
		socks := free(t)
		cfg := fmt.Sprintf(`{"log":{"level":"warn"},"inbounds":[{"type":"socks","listen":"127.0.0.1","listen_port":%d}],
 "outbounds":[{"type":"shadowsocks","server":"127.0.0.1","server_port":%d,"method":%q,"password":%q}]}`,
			socks, port, method, psk+":"+core.DeriveSsPassword(u.XrayUUID, method))
		p := filepath.Join(dir, name+".json")
		_ = os.WriteFile(p, []byte(cfg), 0o600)
		cmd := exec.Command(bin, "run", "-c", p)
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() })
		return socks
	}
	aliceA := clientVia("alice-a", portA, pskA, alice)
	aliceB := clientVia("alice-b", portB, pskB, alice)
	bobB := clientVia("bob-b", portB, pskB, bob)
	bobA := clientVia("bob-a", portA, pskA, bob)

	reach := func(socks int) bool {
		for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(200 * time.Millisecond) {
			if body, err := getVia(socks, target.Listener.Addr().String()); err == nil && body == "ok" {
				return true
			}
			if c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", socks), 200*time.Millisecond); err == nil {
				c.Close() // the client is up: the answer above is the server's
				return false
			}
		}
		return false
	}
	if !reach(aliceA) {
		t.Fatal("alice cannot get through her own inbound")
	}
	if !reach(bobB) {
		t.Fatal("bob cannot get through his own inbound")
	}
	if reach(aliceB) {
		t.Fatal("alice got through an inbound she is not on")
	}
	if reach(bobA) {
		t.Fatal("bob got through an inbound he is not on")
	}
	st, err := a.GetStats()
	if err != nil || st.NoData {
		t.Fatalf("GetStats %+v %v", st, err)
	}
	counted := map[string]int64{}
	for _, u := range st.Users {
		counted[u.UserID] = u.BytesIn + u.BytesOut
	}
	if counted["alice"] == 0 || counted["bob"] == 0 {
		t.Fatalf("counters %v: each user moved bytes on their own inbound", counted)
	}
}
