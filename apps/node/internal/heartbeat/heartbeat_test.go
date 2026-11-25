package heartbeat

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// The heartbeat decides whether a node keeps running at all, and the panel side
// decides subscription visibility from the same liveness: a node the panel
// considers unreachable is dropped from every subscription it serves. So both
// failure directions are expensive and neither is visible from the panel:
// honouring a "gone" that isn't one wipes a live node, and refusing to honour a
// real one leaves an orphan serving traffic after the operator deleted it.
//
// Nothing exercised this package before (measured: `go test ./... -coverpkg`
// reported 0.0% for every function in it), so the tests below ask the loop
// itself, through a real net/http server, what it does.

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

type reply struct {
	code int
	body string
}

func active() reply   { return reply{http.StatusOK, `{"status":"active"}`} }
func disabled() reply { return reply{http.StatusOK, `{"status":"disabled"}`} }
func gone() reply     { return reply{http.StatusGone, `{"error":"NODE_GONE"}`} }

type loopResult struct {
	goneFired  bool
	goneReason string
	requests   []*http.Request
	polls      int
}

// runLoop drives Run against a real HTTP server that answers `replies` in order
// and then repeats the last one forever. It stops at the first OnGone, or once
// the script has been served with two polls to spare - so a guard that was
// supposed to hold has actually been given the chance to break.
func runLoop(t *testing.T, cfg Config, replies ...reply) loopResult {
	t.Helper()

	// Buffered and never blocking: a handler left waiting on a full channel
	// would hang srv.Close(), which is a stall in the harness and reads like a
	// stall in the loop under test.
	served := make(chan *http.Request, 512)
	var mu sync.Mutex
	n := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		rep := replies[len(replies)-1]
		if n < len(replies) {
			rep = replies[n]
		}
		n++
		mu.Unlock()
		w.WriteHeader(rep.code)
		_, _ = io.WriteString(w, rep.body)
		select {
		case served <- r:
		default:
		}
	}))
	defer srv.Close()

	goneCh := make(chan string, 1)
	cfg.PanelURL = srv.URL
	if cfg.HeartbeatToken == "" {
		cfg.HeartbeatToken = "tok"
	}
	cfg.HTTPClient = srv.Client()
	if cfg.Interval <= 0 {
		cfg.Interval = time.Millisecond
	}
	cfg.OnGone = func(reason string) { goneCh <- reason }

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		Run(ctx, cfg, quietLogger())
		close(done)
	}()

	var res loopResult
	deadline := time.After(10 * time.Second)
	wantPolls := len(replies) + 2
	for {
		select {
		case reason := <-goneCh:
			res.goneFired = true
			res.goneReason = reason
			cancel()
			<-done
			return res
		case r := <-served:
			res.requests = append(res.requests, r)
			res.polls++
			if res.polls >= wantPolls {
				// Give the loop a moment to act on the last reply before we
				// conclude that it did not.
				select {
				case reason := <-goneCh:
					res.goneFired = true
					res.goneReason = reason
				case <-time.After(200 * time.Millisecond):
				}
				cancel()
				<-done
				return res
			}
		case <-deadline:
			cancel()
			t.Fatalf("heartbeat loop made only %d polls in 10s", res.polls)
		}
	}
}

// The cold-boot MITM: an attacker holding a public-CA cert for the panel
// hostname answers 410 to every poll a fresh agent makes. Without the
// seenActive gate that wipes the fleet as fast as the agents can poll.
func TestGoneIsIgnoredUntilThePanelHasOnceSaidActive(t *testing.T) {
	res := runLoop(t, Config{GoneThreshold: 2}, gone(), gone(), gone(), gone())
	if res.goneFired {
		t.Fatalf("OnGone fired after %d polls that were 410 from the very first contact; "+
			"the agent must never self-destruct on a panel it never saw alive", res.polls)
	}
}

func TestGoneIsHonouredAfterActive(t *testing.T) {
	res := runLoop(t, Config{GoneThreshold: 3}, active(), gone(), gone(), gone())
	if !res.goneFired {
		t.Fatal("OnGone did not fire on three consecutive 410s after an active poll")
	}
	if !strings.Contains(res.goneReason, "410") {
		t.Errorf("OnGone reason = %q, want it to name the 410 that caused it", res.goneReason)
	}
	// Fires ON the threshold, not before it and not after: 1 active + 3 gone.
	if res.polls != 4 {
		t.Errorf("OnGone fired on poll %d, want the 4th (1 active + threshold 3)", res.polls)
	}
}

// A panel restart shows up as a couple of 410s only if something is badly
// wrong; a couple of them below the threshold must not be enough.
func TestGoneBelowThresholdDoesNotFire(t *testing.T) {
	res := runLoop(t, Config{GoneThreshold: 3}, active(), gone(), gone(), active())
	if res.goneFired {
		t.Fatal("OnGone fired on two 410s with a threshold of three")
	}
}

// The counter must be consecutive, not cumulative. A node that flaps - 410,
// active, 410 - is a node with a flaky path to the panel, not a deleted one.
func TestActiveResetsTheGoneCounter(t *testing.T) {
	res := runLoop(t, Config{GoneThreshold: 3},
		active(), gone(), gone(), active(), gone(), gone(), active())
	if res.goneFired {
		t.Fatalf("OnGone fired after four non-consecutive 410s (threshold 3); "+
			"the counter must reset on every active, reason=%q", res.goneReason)
	}
}

// Everything that is not an explicit 410 must leave the counter alone. This is
// the whole "deliberately conservative" policy in one test: a panel that is
// down, misconfigured, or handing out 401s to the entire fleet must not be able
// to delete the fleet.
func TestOnlyAnExplicit410Counts(t *testing.T) {
	for _, tc := range []struct {
		name string
		rep  reply
	}{
		{"500", reply{http.StatusInternalServerError, "boom"}},
		{"502", reply{http.StatusBadGateway, "boom"}},
		{"401", reply{http.StatusUnauthorized, `{"error":"UNAUTHORIZED"}`}},
		{"404", reply{http.StatusNotFound, "no route"}},
		{"200 with an unknown status field", reply{http.StatusOK, `{"status":"banana"}`}},
		{"200 with an unparseable body", reply{http.StatusOK, `not json`}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			res := runLoop(t, Config{GoneThreshold: 2}, active(), tc.rep, tc.rep, tc.rep)
			if res.goneFired {
				t.Fatalf("OnGone fired on repeated %s responses; only 410 may count", tc.name)
			}
		})
	}
}

// `disabled` is an admin soft-pause: the node stays alive. It is also a real
// answer from the real panel, so it must satisfy the seenActive gate - an agent
// that only ever saw `disabled` and is then deleted still has to hear it.
func TestDisabledKeepsTheAgentAliveAndCountsAsContact(t *testing.T) {
	stay := runLoop(t, Config{GoneThreshold: 2}, disabled(), disabled(), disabled())
	if stay.goneFired {
		t.Fatal("OnGone fired on a disabled node; disabled is a soft pause, not a deletion")
	}
	after := runLoop(t, Config{GoneThreshold: 2}, disabled(), gone(), gone())
	if !after.goneFired {
		t.Fatal("OnGone did not fire after disabled + threshold 410s: " +
			"a panel that answered at all has been seen alive")
	}
}

// The panel authenticates the poll by token and detects agent restarts by the
// start-time header (it re-pushes inbounds + users when the value changes).
// A poll that dropped either would be answered 401, or would silently stop the
// re-push that closes the "agent restarted, users vanished" gap.
func TestEveryPollCarriesTokenPathAndStartTime(t *testing.T) {
	res := runLoop(t, Config{
		GoneThreshold:  9,
		HeartbeatToken: "s3cret",
		AgentStartTime: "1747000000000000000",
	}, active(), active())
	if len(res.requests) == 0 {
		t.Fatal("no polls recorded")
	}
	for i, r := range res.requests {
		if got := r.Header.Get("Authorization"); got != "Bearer s3cret" {
			t.Errorf("poll %d: Authorization = %q, want %q", i, got, "Bearer s3cret")
		}
		if got := r.Header.Get("X-Agent-Start-Time"); got != "1747000000000000000" {
			t.Errorf("poll %d: X-Agent-Start-Time = %q, want the agent start stamp", i, got)
		}
		if r.URL.Path != "/api/internal/nodes/me/status" {
			t.Errorf("poll %d: path = %q, want /api/internal/nodes/me/status", i, r.URL.Path)
		}
	}
}

// A PanelURL an operator typed with a trailing slash must not produce a double
// slash: the panel routes on the exact path and answers 404 to `//api/...`,
// which pollOnce reports as an error, so the node would poll forever and never
// reach seenActive.
func TestTrailingSlashInPanelURLDoesNotDoubleTheSeparator(t *testing.T) {
	served := make(chan string, 8)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		served <- r.URL.Path
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, `{"status":"active"}`)
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		Run(ctx, Config{
			PanelURL:       srv.URL + "/",
			HeartbeatToken: "tok",
			HTTPClient:     srv.Client(),
			Interval:       time.Millisecond,
		}, quietLogger())
		close(done)
	}()
	select {
	case path := <-served:
		if path != "/api/internal/nodes/me/status" {
			t.Errorf("path = %q, want /api/internal/nodes/me/status", path)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no poll arrived")
	}
	cancel()
	<-done
}

// Run must return immediately - not poll, not block - when the payload cannot
// support a heartbeat. Each of these is a real payload state: a node bootstrapped
// before the field existed, or one whose install never got a panel URL.
func TestRunRefusesToStartOnAnIncompletePayload(t *testing.T) {
	polled := make(chan struct{}, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		polled <- struct{}{}
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, `{"status":"active"}`)
	}))
	defer srv.Close()

	for _, tc := range []struct {
		name string
		cfg  Config
	}{
		{"no panel url", Config{HeartbeatToken: "tok", HTTPClient: srv.Client()}},
		{"no token", Config{PanelURL: srv.URL, HTTPClient: srv.Client()}},
		// No injected client and no CA in the payload: the loop builds its own
		// client, and refuses to run rather than fall back to system-only trust.
		{"no CA and no client", Config{PanelURL: srv.URL, HeartbeatToken: "tok"}},
		{"unparseable CA", Config{PanelURL: srv.URL, HeartbeatToken: "tok", CACertPem: "-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			done := make(chan struct{})
			go func() {
				Run(context.Background(), tc.cfg, quietLogger())
				close(done)
			}()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("Run did not return; it must refuse this payload, not loop on it")
			}
			select {
			case <-polled:
				t.Fatal("Run polled the panel on a payload it should have refused")
			default:
			}
		})
	}
}

func TestBuildHybridClientRejectsWhatItCannotTrust(t *testing.T) {
	// Empty PEM is the legacy payload: no client, no error, and the caller
	// (Run) turns that into a refusal.
	c, err := buildHybridClient("")
	if c != nil || err != nil {
		t.Errorf("buildHybridClient(\"\") = (%v, %v), want (nil, nil)", c, err)
	}

	if _, err := buildHybridClient("garbage, not a PEM"); err == nil {
		t.Error("buildHybridClient accepted a non-PEM string; a corrupted payload must not " +
			"silently demote the node to system-only trust")
	}
}

// The client the loop builds is asked the only question that matters: does a
// TLS handshake against a panel served by the payload's CA succeed, and does it
// still hold the system roots a Let's-Encrypt-served panel needs?
//
// Both halves are scars. Pinning to the payload CA alone (pre-wave-13) made
// every LE-served panel fail the handshake, so seenActive stayed false forever
// and deleted nodes were never collected. Dropping the payload CA would leave
// the CA-only deployments unable to poll at all.
func TestHybridClientTrustsThePayloadCAAndKeepsSystemRoots(t *testing.T) {
	caPem, serverCert := mintCA(t)

	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, `{"status":"active"}`)
	}))
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{serverCert}}
	srv.StartTLS()
	defer srv.Close()

	client, err := buildHybridClient(string(caPem))
	if err != nil {
		t.Fatalf("buildHybridClient(valid PEM): %v", err)
	}
	if client == nil {
		t.Fatal("buildHybridClient(valid PEM) returned no client")
	}
	if client.Timeout == 0 {
		t.Error("client has no timeout: one hung poll would stall the loop forever")
	}

	resp, err := client.Get(srv.URL)
	if err != nil {
		t.Fatalf("handshake against a panel served by the payload CA failed: %v", err)
	}
	_ = resp.Body.Close()

	// Control: the same server is NOT reachable from a client that was given
	// no CA at all, so the success above is the payload CA doing the work and
	// not a trust store that would have accepted anything.
	bare := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: x509.NewCertPool()}}}
	if _, err := bare.Get(srv.URL); err == nil {
		t.Fatal("a client with an empty root pool trusted the test panel; the check above proves nothing")
	}

	tr, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("transport is %T, want *http.Transport", client.Transport)
	}
	onlyCA := x509.NewCertPool()
	onlyCA.AppendCertsFromPEM(caPem)
	if tr.TLSClientConfig.RootCAs.Equal(onlyCA) {
		t.Error("root pool holds the payload CA and nothing else: system roots were dropped, " +
			"which is exactly what orphaned every panel served by a public CA")
	}
}

// mintCA returns a self-signed CA in PEM form plus a leaf certificate for
// 127.0.0.1 signed by it. Minted per run rather than pasted in as a fixture: a
// hard-coded certificate expires, and this test would then fail for a reason
// that has nothing to do with the heartbeat.
func mintCA(t *testing.T) ([]byte, tls.Certificate) {
	t.Helper()

	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("ca key: %v", err)
	}
	caTmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "iceslab-test-ca"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
	}
	caDer, err := x509.CreateCertificate(rand.Reader, caTmpl, caTmpl, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatalf("ca cert: %v", err)
	}
	caCert, err := x509.ParseCertificate(caDer)
	if err != nil {
		t.Fatalf("parse ca: %v", err)
	}

	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("leaf key: %v", err)
	}
	leafTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "panel.test"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
	}
	leafDer, err := x509.CreateCertificate(rand.Reader, leafTmpl, caCert, &leafKey.PublicKey, caKey)
	if err != nil {
		t.Fatalf("leaf cert: %v", err)
	}

	caPem := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDer})
	return caPem, tls.Certificate{
		Certificate: [][]byte{leafDer, caDer},
		PrivateKey:  leafKey,
	}
}
