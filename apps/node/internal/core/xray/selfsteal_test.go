package xray

import (
	"context"
	"crypto/tls"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestSelfSteal_ServesTLS13WithDomainCert starts the fallback on an ephemeral
// port, dials it as a TLS client, and checks: the handshake is TLS 1.3, the
// presented cert is for the configured domain, and the body is the benign page.
func TestSelfSteal_ServesTLS13WithDomainCert(t *testing.T) {
	// Bind an ephemeral port instead of the fixed :8443 so the test is isolated.
	var boundAddr string
	orig := selfStealListen
	selfStealListen = func(_ string) (net.Listener, error) {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return nil, err
		}
		boundAddr = ln.Addr().String()
		return ln, nil
	}
	defer func() { selfStealListen = orig }()

	srv, err := startSelfSteal(selfStealAddr, []selfStealSite{{names: []string{"node.example.com"}}}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("startSelfSteal: %v", err)
	}
	defer func() { _ = srv.stop(context.Background()) }()

	// Give the goroutine a moment to begin serving.
	deadline := time.Now().Add(2 * time.Second)
	var conn *tls.Conn
	for time.Now().Before(deadline) {
		conn, err = tls.DialWithDialer(
			&net.Dialer{Timeout: 500 * time.Millisecond},
			"tcp", boundAddr,
			// We present a self-signed cert; the client must skip verification.
			&tls.Config{InsecureSkipVerify: true, ServerName: "node.example.com"},
		)
		if err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("tls dial: %v", err)
	}
	defer conn.Close()

	state := conn.ConnectionState()
	if state.Version != tls.VersionTLS13 {
		t.Errorf("expected TLS 1.3, got version 0x%x", state.Version)
	}
	if len(state.PeerCertificates) == 0 {
		t.Fatalf("no peer certificate presented")
	}
	leaf := state.PeerCertificates[0]
	if leaf.Subject.CommonName != "node.example.com" {
		t.Errorf("cert CN = %q, want node.example.com", leaf.Subject.CommonName)
	}
	foundSAN := false
	for _, dns := range leaf.DNSNames {
		if dns == "node.example.com" {
			foundSAN = true
		}
	}
	if !foundSAN {
		t.Errorf("cert SAN missing node.example.com: %v", leaf.DNSNames)
	}

	// Issue a plain HTTP GET over the TLS conn and confirm the benign body.
	req, _ := http.NewRequest(http.MethodGet, "https://node.example.com/", nil)
	if err := req.Write(conn); err != nil {
		t.Fatalf("write request: %v", err)
	}
	buf := make([]byte, 1024)
	n, _ := conn.Read(buf)
	resp := string(buf[:n])
	if !strings.Contains(resp, "It works!") {
		t.Errorf("unexpected fallback body: %q", resp)
	}
}

// TestGenerateSelfSignedCert covers the cert builder in isolation.
func TestGenerateSelfSignedCert(t *testing.T) {
	cert, err := generateSelfSignedCert("foo.bar")
	if err != nil {
		t.Fatalf("generateSelfSignedCert: %v", err)
	}
	if len(cert.Certificate) == 0 || cert.PrivateKey == nil {
		t.Fatalf("cert/key not populated")
	}
}

// TestSelfSteal_ReverseProxiesToUpstream (G1): with an upstream configured, a
// prober hitting the fallback over TLS gets the UPSTREAM's real content, not
// the stub landing page.
func TestSelfSteal_ReverseProxiesToUpstream(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "REAL UPSTREAM CONTENT")
	}))
	defer upstream.Close()

	var boundAddr string
	orig := selfStealListen
	selfStealListen = func(_ string) (net.Listener, error) {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return nil, err
		}
		boundAddr = ln.Addr().String()
		return ln, nil
	}
	defer func() { selfStealListen = orig }()

	sites := []selfStealSite{{names: []string{"node.example.com"}, upstream: upstream.URL}}
	srv, err := startSelfSteal(selfStealAddr, sites, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("startSelfSteal: %v", err)
	}
	defer func() { _ = srv.stop(context.Background()) }()
	if srv.key != selfStealKey(sites) {
		t.Errorf("server key = %q, want %q", srv.key, selfStealKey(sites))
	}

	client := &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true, ServerName: "node.example.com"},
		},
		Timeout: 2 * time.Second,
	}
	var body string
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		resp, derr := client.Get("https://" + boundAddr + "/")
		if derr != nil {
			time.Sleep(20 * time.Millisecond)
			continue
		}
		b, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		body = string(b)
		break
	}
	if !strings.Contains(body, "REAL UPSTREAM CONTENT") {
		t.Errorf("expected proxied upstream body, got %q", body)
	}
}

// TestBuildSelfStealHandler_Static: no upstream -> the benign static page.
func TestBuildSelfStealHandler_Static(t *testing.T) {
	h, err := buildSelfStealHandler("", slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("buildSelfStealHandler: %v", err)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if !strings.Contains(rec.Body.String(), "It works!") {
		t.Errorf("static handler body = %q", rec.Body.String())
	}
}

// TestBuildSelfStealHandler_RejectsInvalidUpstream: a non-http(s) or hostless
// upstream is refused at build time (the operator gets a clear failure).
func TestBuildSelfStealHandler_RejectsInvalidUpstream(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if _, err := buildSelfStealHandler("ftp://example.com", logger); err == nil {
		t.Errorf("expected error for non-http upstream scheme")
	}
	if _, err := buildSelfStealHandler("http://", logger); err == nil {
		t.Errorf("expected error for upstream with no host")
	}
}

// TestBuildSelfStealHandler_UpstreamErrorFallsBackToStatic (G1): an unreachable
// upstream must yield the static page, never a leaked Go proxy error that would
// flag the node to a prober.
func TestBuildSelfStealHandler_UpstreamErrorFallsBackToStatic(t *testing.T) {
	// 127.0.0.1:1 refuses connections.
	h, err := buildSelfStealHandler("http://127.0.0.1:1", slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("buildSelfStealHandler: %v", err)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if !strings.Contains(rec.Body.String(), "It works!") {
		t.Errorf("expected static fallback on upstream error, got %q", rec.Body.String())
	}
}
