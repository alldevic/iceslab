package server

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core/hysteria"
	"github.com/icecompany-tech/iceslab/apps/node/internal/core/naive"
)

/*
A-280, stand 26.10 on aeza-de-01: hysteria put on the node by its bootstrap
after the install never got the installer's 80/tcp, every HTTP-01 challenge
timed out, and the unit restarted into Let's Encrypt's failed-validation limit
while the push read as applied. A push of a core that takes an ACME
certificate opens 80/tcp; the panel's self-signed pair does not. The real
adapters, with nothing spawned: hysteria writes its config and restarts
through a no-op, naive renders its Caddyfile in config-only mode.
*/

func selfSignedPEM(t *testing.T) (string, string) {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: "203.0.113.9"},
		IPAddresses:  []net.IP{net.ParseIP("203.0.113.9")},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &priv.PublicKey, priv)
	if err != nil {
		t.Fatal(err)
	}
	key, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})),
		string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key}))
}

func hysteriaAdapter(t *testing.T) *hysteria.Adapter {
	t.Helper()
	return hysteria.New(hysteria.Config{
		ConfigPath: filepath.Join(t.TempDir(), "config.yaml"),
		RunCmd:     func(context.Context, string, ...string) error { return nil },
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func cfgJSON(t *testing.T, m map[string]any) string {
	t.Helper()
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestAHysteriaPushOnADomainOpens80AndASelfSignedOneDoesNot(t *testing.T) {
	fw := recordFirewall(t)
	s := serverWithStore(t, filepath.Join(t.TempDir(), "inbounds.json"), hysteriaAdapter(t))
	if code := pushOver(t, s, inboundsPush(ib("hy", "hysteria", 443, cfgJSON(t, map[string]any{"hostname": "hy.example.net"})))); code != http.StatusOK {
		t.Fatalf("push answered %d", code)
	}
	if opened, _ := fw.take(); !slices.Contains(opened, "80/tcp") || !slices.Contains(opened, "443/udp") {
		t.Fatalf("opened %v, want 443/udp and 80/tcp for ACME", opened)
	}

	fw2 := recordFirewall(t)
	s2 := serverWithStore(t, filepath.Join(t.TempDir(), "inbounds.json"), hysteriaAdapter(t))
	cert, key := selfSignedPEM(t)
	if code := pushOver(t, s2, inboundsPush(ib("hy", "hysteria", 443, cfgJSON(t, map[string]any{"tlsCertPem": cert, "tlsKeyPem": key})))); code != http.StatusOK {
		t.Fatalf("push answered %d", code)
	}
	if opened, _ := fw2.take(); slices.Contains(opened, "80/tcp") {
		t.Fatalf("opened %v: the panel's self-signed pair needs no 80/tcp", opened)
	}
}

func TestANaivePushOpens80(t *testing.T) {
	fw := recordFirewall(t)
	nv := naive.New(naive.Config{CaddyfilePath: filepath.Join(t.TempDir(), "Caddyfile")}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	s := serverWithStore(t, filepath.Join(t.TempDir(), "inbounds.json"), nv)
	if code := pushOver(t, s, inboundsPush(ib("nv", "naive", 443, `{"hostname":"naive.example.net","tlsEmail":"ops@iceslab.test"}`))); code != http.StatusOK {
		t.Fatalf("push answered %d", code)
	}
	if opened, _ := fw.take(); !slices.Contains(opened, "80/tcp") || !slices.Contains(opened, "443/tcp") {
		t.Fatalf("opened %v, want 443/tcp and 80/tcp for ACME", opened)
	}
}

// 80/tcp is never closed by the agent: the installer opens the same rule and
// a renewal needs it while the certificate lives (ensureACMEFirewall).
func TestPort80IsNeverClosed(t *testing.T) {
	fw := recordFirewall(t)
	xray := &pickyServerCore{fakeCore: fakeCore{name: "xray", engine: "xray", running: true}}
	s := serverWithStore(t, filepath.Join(t.TempDir(), "inbounds.json"), hysteriaAdapter(t), xray)
	pushOver(t, s, inboundsPush(
		ib("hy", "hysteria", 443, cfgJSON(t, map[string]any{"hostname": "hy.example.net"})),
		ib("x80", "xray", 80, `{}`),
	))
	fw.take()
	pushOver(t, s, inboundsPush())
	if _, closed := fw.take(); slices.Contains(closed, "80/tcp") {
		t.Fatalf("closed %v", closed)
	}
}
