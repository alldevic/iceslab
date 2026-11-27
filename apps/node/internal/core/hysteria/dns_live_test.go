package hysteria

import (
	"context"
	"log/slog"

	"encoding/binary"
	"fmt"
	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// 19.14, live against the pinned hysteria (HYSTERIA_BIN): the node's resolver
// is what answers the name a client asks the server to connect to. A UDP DNS
// server on loopback answers every A query with 127.0.0.1 and records the
// names; an echo server sits on loopback; a client asks the server for
// "iceslab-dns-test.invalid:<echo port>". The name resolves nowhere else, so a
// stream that comes back proves the section was used, and the DNS server's log
// carries the name.
func TestLiveTheResolverAnswersTheNamesClientsAsk(t *testing.T) {
	if hysteriaBin == "" {
		t.Skip("HYSTERIA_BIN not set: the resolver is not asked of the real core here")
	}
	const name = "iceslab-dns-test.invalid"
	dns, asked := fakeDNS(t)
	echo := echoServer(t)
	_, echoPort, _ := net.SplitHostPort(echo)

	dir := t.TempDir()
	certPEM, keyPEM, _ := pemPair(t)
	a := New(Config{
		ConfigPath:       filepath.Join(dir, "config.yaml"),
		AuthCallbackPort: freeTCP(t),
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	// No BinaryPath: the agent holds the callback, the test runs hysteria.
	if err := a.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Stop(context.Background()) })
	_ = a.AddUser(core.User{UserID: "u-dns", HysteriaPassword: "live-pw-not-a-secret"})
	cfg := a.cfg
	if err := writeTLSPair(cfg.ConfigPath, certPEM, keyPEM); err != nil {
		t.Fatal(err)
	}
	udp := freeUDP(t)
	res, _, _ := nodeResolver(dnsCfg(dto.DnsServer{Address: dns}))
	blob, err := renderConfigDns(cfg, InboundConfig{Port: udp, TLSCertPEM: certPEM, TLSKeyPEM: keyPEM}, nil, res)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(blob), "resolver:") {
		t.Fatalf("no resolver drawn:\n%s", blob)
	}
	if err := os.WriteFile(cfg.ConfigPath, blob, 0o600); err != nil {
		t.Fatal(err)
	}
	run(t, dir, "hysteria server", "server up and running", hysteriaBin, "server", "-c", cfg.ConfigPath)

	socks := freeTCP(t)
	ccfg := filepath.Join(t.TempDir(), "client.yaml")
	body := fmt.Sprintf("server: 127.0.0.1:%d\nauth: live-pw-not-a-secret\ntls:\n  insecure: true\nsocks5:\n  listen: 127.0.0.1:%d\n", udp, socks)
	if err := os.WriteFile(ccfg, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	run(t, filepath.Dir(ccfg), "hysteria client", "", hysteriaBin, "client", "-c", ccfg)

	var last error
	for deadline := time.Now().Add(15 * time.Second); time.Now().Before(deadline); time.Sleep(200 * time.Millisecond) {
		c, err := socksDialName(socks, name, echoPort)
		if err == nil {
			err = roundTrip(c)
			c.Close()
		}
		if err == nil {
			last = nil
			break
		}
		last = err
	}
	if last != nil {
		t.Fatalf("no stream to %s through the server: %v", name, last)
	}
	if !asked.has(name) {
		t.Errorf("the stream came back but the DNS server never saw %s: %v", name, asked.all())
	}
}

type namesAsked struct {
	mu sync.Mutex
	n  []string
}

func (n *namesAsked) add(s string) { n.mu.Lock(); n.n = append(n.n, s); n.mu.Unlock() }
func (n *namesAsked) all() []string {
	n.mu.Lock()
	defer n.mu.Unlock()
	return append([]string(nil), n.n...)
}
func (n *namesAsked) has(s string) bool {
	for _, x := range n.all() {
		if x == s {
			return true
		}
	}
	return false
}

// fakeDNS answers A with 127.0.0.1 and everything else with no records.
func fakeDNS(t *testing.T) (addr string, asked *namesAsked) {
	t.Helper()
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pc.Close() })
	asked = &namesAsked{}
	go func() {
		buf := make([]byte, 512)
		for {
			n, from, err := pc.ReadFrom(buf)
			if err != nil {
				return
			}
			if n < 13 {
				continue
			}
			i, labels := 12, []string{}
			for i < n && buf[i] != 0 {
				l := int(buf[i])
				if i+1+l > n {
					break
				}
				labels = append(labels, string(buf[i+1:i+1+l]))
				i += 1 + l
			}
			if i+5 > n {
				continue
			}
			qtype := binary.BigEndian.Uint16(buf[i+1:])
			question := append([]byte(nil), buf[12:i+5]...)
			asked.add(strings.Join(labels, "."))
			resp := append([]byte(nil), buf[0:2]...)
			an := byte(0)
			if qtype == 1 {
				an = 1
			}
			resp = append(resp, 0x81, 0x80, 0, 1, 0, an, 0, 0, 0, 0)
			resp = append(resp, question...)
			if an == 1 {
				resp = append(resp, 0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 127, 0, 0, 1)
			}
			_, _ = pc.WriteTo(resp, from)
		}
	}()
	return pc.LocalAddr().String(), asked
}

// socksDialName opens a CONNECT by NAME (ATYP 3) through a socks5 proxy.
func socksDialName(socks int, host, port string) (net.Conn, error) {
	c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", socks), 2*time.Second)
	if err != nil {
		return nil, err
	}
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := c.Write([]byte{5, 1, 0}); err != nil {
		c.Close()
		return nil, err
	}
	resp := make([]byte, 2)
	if _, err := io.ReadFull(c, resp); err != nil || resp[1] != 0 {
		c.Close()
		return nil, fmt.Errorf("socks greeting: %v %v", resp, err)
	}
	var p uint16
	fmt.Sscan(port, &p)
	req := append([]byte{5, 1, 0, 3, byte(len(host))}, host...)
	req = binary.BigEndian.AppendUint16(req, p)
	if _, err := c.Write(req); err != nil {
		c.Close()
		return nil, err
	}
	reply := make([]byte, 10)
	if _, err := io.ReadFull(c, reply); err != nil || reply[1] != 0 {
		c.Close()
		return nil, fmt.Errorf("socks connect: %v %v", reply, err)
	}
	_ = c.SetDeadline(time.Time{})
	return c, nil
}
