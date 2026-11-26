package xray

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
)

// 10.1, live: a policy rule by address, with the catch-all under it, takes a
// connection that came by NAME. The name lives in the core's dns.hosts and
// answers 127.0.0.1; the policy is "127.0.0.0/8 -> block, everything else ->
// direct". Asked of the real xray, twice, on the config as the node renders it
// and on the same config with the strategy put back to IPIfNonMatch:
//
//   - rendered (IPOnDemand): the name is resolved at the address rule, matches
//     it, and the connection is blocked;
//   - IPIfNonMatch: the catch-all matches first, the name is never resolved for
//     the address rule, and the connection goes direct. This is the defect the
//     strategy is raised for, so the first half is proof and not luck.
//
// Skipped without XRAY_BIN, like every test here that asks the core.
func TestLiveAnIPRuleTakesAConnectionThatCameByName(t *testing.T) {
	bin := os.Getenv("XRAY_BIN")
	if bin == "" {
		t.Skip("XRAY_BIN not set: the core is not asked here")
	}
	const name = "iceslab-geo.test"

	target, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "reached")
	})}
	go func() { _ = srv.Serve(target) }()
	t.Cleanup(func() { _ = srv.Close() })
	targetPort := target.Addr().(*net.TCPAddr).Port

	policy := []dto.NodePolicyRule{
		{Match: dto.NodePolicyMatch{IP: []string{"127.0.0.0/8"}}, Action: dto.NodePolicyAction{Kind: dto.PolicyActionBlock}},
		{Match: dto.NodePolicyMatch{Network: "tcp,udp"}, Action: dto.NodePolicyAction{Kind: dto.PolicyActionDirect}},
	}

	// run reports whether the request through the node's socks door reached
	// the target, with the strategy the render picked or forced to `force`.
	run := func(t *testing.T, force string) (reached bool, strategy string) {
		t.Helper()
		socksPort, apiPort := freePort(t), freePort(t)
		in := plainIn("socks", socksPort)
		in.ListenHost = "127.0.0.1"
		blob, err := renderMultiConfig([]InboundConfig{in}, []xrayClient{alice}, nil, apiPort, policy,
			&dto.DnsCfg{Servers: []dto.DnsServer{{Address: "1.1.1.1"}}})
		if err != nil {
			t.Fatal(err)
		}
		var doc map[string]any
		if err := json.Unmarshal(blob, &doc); err != nil {
			t.Fatal(err)
		}
		doc["dns"].(map[string]any)["hosts"] = map[string]any{name: "127.0.0.1"}
		routing := doc["routing"].(map[string]any)
		if force != "" {
			routing["domainStrategy"] = force
		}
		strategy, _ = routing["domainStrategy"].(string)
		blob, _ = json.Marshal(doc)
		path := filepath.Join(t.TempDir(), "config.json")
		if err := os.WriteFile(path, blob, 0o600); err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(bin, "run", "-c", path)
		var logs strings.Builder
		cmd.Stdout, cmd.Stderr = &logs, &logs
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
		if !waitListening(fmt.Sprintf("127.0.0.1:%d", socksPort), 5*time.Second) {
			t.Fatalf("xray did not listen:\n%s", logs.String())
		}
		proxy := &url.URL{Scheme: "socks5", User: url.UserPassword(alice.Login, alice.ID), Host: fmt.Sprintf("127.0.0.1:%d", socksPort)}
		client := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{Proxy: http.ProxyURL(proxy)}}
		resp, err := client.Get(fmt.Sprintf("http://%s:%d/", name, targetPort))
		if err != nil {
			return false, strategy
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return string(body) == "reached", strategy
	}

	if reached, strategy := run(t, ""); strategy != "IPOnDemand" || reached {
		t.Fatalf("as rendered (%s): reached=%v, want IPOnDemand and the address rule to block the name", strategy, reached)
	}
	if reached, _ := run(t, "IPIfNonMatch"); !reached {
		t.Fatal("under IPIfNonMatch the address rule took the name too: the defect is not there on this core, the test proves nothing")
	}
}
