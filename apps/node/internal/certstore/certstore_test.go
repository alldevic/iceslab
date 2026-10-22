package certstore

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"io"
	"log/slog"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

type testCA struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
	pem  string
}

func newCA(t *testing.T) testCA {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "test ca"},
		NotBefore:             time.Now().Add(-48 * time.Hour),
		NotAfter:              time.Now().Add(10 * 365 * 24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	return testCA{cert: cert, key: key, pem: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))}
}

type leafOpts struct {
	notBefore, notAfter time.Time
	dns                 []string
	ips                 []net.IP
}

func (ca testCA) leaf(t *testing.T, o leafOpts) (certPEM, keyPEM string) {
	t.Helper()
	if o.notBefore.IsZero() {
		o.notBefore = time.Now().Add(-time.Hour)
	}
	if o.notAfter.IsZero() {
		o.notAfter = time.Now().Add(365 * 24 * time.Hour)
	}
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	serial, _ := rand.Int(rand.Reader, big.NewInt(1<<62))
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "node"},
		NotBefore:    o.notBefore,
		NotAfter:     o.notAfter,
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
		DNSNames:     o.dns,
		IPAddresses:  o.ips,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.cert, &key.PublicKey, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	kder, _ := x509.MarshalECPrivateKey(key)
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})),
		string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kder}))
}

var nodeNames = leafOpts{dns: []string{"n1.example.test"}, ips: []net.IP{net.ParseIP("203.0.113.7")}}

func open(t *testing.T, ca testCA, dir, certPEM, keyPEM string, window time.Duration) *Store {
	t.Helper()
	s, err := Open(Config{
		Dir: dir, CACertPEM: ca.pem, PayloadCertPEM: certPEM, PayloadKeyPEM: keyPEM,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Window: window,
	})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return s
}

func served(t *testing.T, s *Store) string {
	t.Helper()
	c, err := s.GetCertificate(nil)
	if err != nil {
		t.Fatal(err)
	}
	return fingerprint(c.Leaf)
}

func TestARotatedPairIsServedAndSurvivesARestartOnceConfirmed(t *testing.T) {
	ca := newCA(t)
	dir := t.TempDir()
	oldC, oldK := ca.leaf(t, nodeNames)
	s := open(t, ca, dir, oldC, oldK, time.Hour)
	oldFP := served(t, s)

	newC, newK := ca.leaf(t, nodeNames)
	fp, confirmBy, err := s.Rotate(newC, newK)
	if err != nil {
		t.Fatalf("Rotate: %v", err)
	}
	if served(t, s) != fp || fp == oldFP {
		t.Fatal("the new pair is not what new handshakes get")
	}
	if time.Until(confirmBy) <= 0 {
		t.Fatalf("confirmBy %v is not ahead", confirmBy)
	}
	for _, name := range []string{"node.crt", "node.key", "node.crt.prev", "node.key.prev", "pending.json"} {
		st, err := os.Stat(filepath.Join(dir, name))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if st.Mode().Perm() != 0o600 {
			t.Errorf("%s mode %o, want 0600", name, st.Mode().Perm())
		}
	}
	if err := s.Confirm(fp); err != nil {
		t.Fatalf("Confirm: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "pending.json")); !os.IsNotExist(err) {
		t.Fatal("pending.json stayed after the confirm")
	}

	// A restart: the payload still carries the old pair, the disk wins.
	again := open(t, ca, dir, oldC, oldK, time.Hour)
	if served(t, again) != fp {
		t.Fatal("after a restart the agent went back to the payload's pair")
	}
}

func TestWithoutAConfirmTheAgentGoesBackByItself(t *testing.T) {
	ca := newCA(t)
	dir := t.TempDir()
	oldC, oldK := ca.leaf(t, nodeNames)
	s := open(t, ca, dir, oldC, oldK, 50*time.Millisecond)
	oldFP := served(t, s)
	newC, newK := ca.leaf(t, nodeNames)
	if _, _, err := s.Rotate(newC, newK); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for served(t, s) != oldFP && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if served(t, s) != oldFP {
		t.Fatal("no confirm and the new pair is still served")
	}
	onDisk, _ := os.ReadFile(filepath.Join(dir, "node.crt"))
	if string(onDisk) != oldC {
		t.Fatal("the rollback did not put the old pair back on disk")
	}
	if _, err := os.Stat(filepath.Join(dir, "pending.json")); !os.IsNotExist(err) {
		t.Fatal("pending.json stayed after the rollback")
	}
	// And a confirm after the rollback is refused.
	if err := s.Confirm(fingerprintPEM(t, newC)); !errors.Is(err, ErrNotPending) {
		t.Fatalf("confirm after rollback: %v, want ErrNotPending", err)
	}
}

func TestARestartPastTheDeadlineRollsBackAndOneBeforeItWaits(t *testing.T) {
	ca := newCA(t)
	oldC, oldK := ca.leaf(t, nodeNames)
	newC, newK := ca.leaf(t, nodeNames)

	// Past the deadline: the agent was down when it ran out.
	dir := t.TempDir()
	s := open(t, ca, dir, oldC, oldK, time.Hour)
	if _, _, err := s.Rotate(newC, newK); err != nil {
		t.Fatal(err)
	}
	pf := pendingFile{Fingerprint: fingerprintPEM(t, newC), ConfirmBy: time.Now().Add(-time.Minute)}
	writeJSON(t, filepath.Join(dir, "pending.json"), pf)
	after := open(t, ca, dir, oldC, oldK, time.Hour)
	if served(t, after) != fingerprintPEM(t, oldC) {
		t.Fatal("a restart past the deadline kept the unconfirmed pair")
	}

	// Before the deadline: it keeps serving the new pair and still waits.
	dir2 := t.TempDir()
	s2 := open(t, ca, dir2, oldC, oldK, time.Hour)
	fp, _, err := s2.Rotate(newC, newK)
	if err != nil {
		t.Fatal(err)
	}
	again := open(t, ca, dir2, oldC, oldK, time.Hour)
	if served(t, again) != fp {
		t.Fatal("a restart inside the window dropped the new pair")
	}
	if err := again.Confirm(fp); err != nil {
		t.Fatalf("the rotation is no longer waiting after a restart: %v", err)
	}
}

func TestTheChecksRefuseWhatThePanelCouldNotReachTheNodeWith(t *testing.T) {
	ca := newCA(t)
	other := newCA(t)
	oldC, oldK := ca.leaf(t, nodeNames)
	cases := map[string]func() (string, string){
		"key of another pair": func() (string, string) {
			c, _ := ca.leaf(t, nodeNames)
			_, k := ca.leaf(t, nodeNames)
			return c, k
		},
		"another CA": func() (string, string) { return other.leaf(t, nodeNames) },
		"expired": func() (string, string) {
			o := nodeNames
			o.notBefore, o.notAfter = time.Now().Add(-48*time.Hour), time.Now().Add(-time.Hour)
			return ca.leaf(t, o)
		},
		"not yet valid": func() (string, string) {
			o := nodeNames
			o.notBefore = time.Now().Add(time.Hour)
			return ca.leaf(t, o)
		},
		"drops the address": func() (string, string) {
			return ca.leaf(t, leafOpts{dns: nodeNames.dns})
		},
		"drops the name": func() (string, string) {
			return ca.leaf(t, leafOpts{ips: nodeNames.ips})
		},
		"not PEM": func() (string, string) { return "junk", "junk" },
	}
	for name, mk := range cases {
		t.Run(name, func(t *testing.T) {
			s := open(t, ca, t.TempDir(), oldC, oldK, time.Hour)
			c, k := mk()
			if _, _, err := s.Rotate(c, k); !errors.Is(err, ErrInvalid) {
				t.Fatalf("got %v, want ErrInvalid", err)
			}
			if served(t, s) != fingerprintPEM(t, oldC) {
				t.Fatal("a refused pair replaced the one in force")
			}
		})
	}
}

func TestASecondRotationWaitsForTheFirstConfirm(t *testing.T) {
	ca := newCA(t)
	oldC, oldK := ca.leaf(t, nodeNames)
	s := open(t, ca, t.TempDir(), oldC, oldK, time.Hour)
	c1, k1 := ca.leaf(t, nodeNames)
	if _, _, err := s.Rotate(c1, k1); err != nil {
		t.Fatal(err)
	}
	c2, k2 := ca.leaf(t, nodeNames)
	if _, _, err := s.Rotate(c2, k2); !errors.Is(err, ErrPending) {
		t.Fatalf("got %v, want ErrPending", err)
	}
	if err := s.Confirm("not-the-fingerprint"); !errors.Is(err, ErrNotPending) {
		t.Fatalf("a confirm with another fingerprint: %v, want ErrNotPending", err)
	}
}

// A node a year past its bootstrap still starts: the expired payload pair is
// served, which is what lets the panel renew it at all.
func TestAnExpiredPayloadPairStillStarts(t *testing.T) {
	ca := newCA(t)
	o := nodeNames
	o.notBefore, o.notAfter = time.Now().Add(-400*24*time.Hour), time.Now().Add(-35*24*time.Hour)
	c, k := ca.leaf(t, o)
	s := open(t, ca, t.TempDir(), c, k, time.Hour)
	if !s.NotAfter().Before(time.Now()) {
		t.Fatal("NotAfter is not the expired one")
	}
}

// Live: a real TLS listener on GetCertificate. The connection before the
// rotation sees the old pair, the one after it the new one, no restart.
func TestANewHandshakeGetsTheRotatedPairWithoutARestart(t *testing.T) {
	ca := newCA(t)
	oldC, oldK := ca.leaf(t, nodeNames)
	s := open(t, ca, t.TempDir(), oldC, oldK, time.Hour)

	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{GetCertificate: s.GetCertificate, MinVersion: tls.VersionTLS12})
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	var accepted atomic.Int32
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			accepted.Add(1)
			go func() { _ = c.(*tls.Conn).Handshake(); _ = c.Close() }()
		}
	}()
	pool := x509.NewCertPool()
	pool.AddCert(ca.cert)
	dial := func() string {
		c, err := tls.Dial("tcp", ln.Addr().String(), &tls.Config{RootCAs: pool, ServerName: "n1.example.test"})
		if err != nil {
			t.Fatalf("dial: %v", err)
		}
		defer c.Close()
		return fingerprint(c.ConnectionState().PeerCertificates[0])
	}

	if dial() != fingerprintPEM(t, oldC) {
		t.Fatal("before the rotation the old pair is not served")
	}
	newC, newK := ca.leaf(t, nodeNames)
	fp, _, err := s.Rotate(newC, newK)
	if err != nil {
		t.Fatal(err)
	}
	if got := dial(); got != fp {
		t.Fatalf("a new handshake after the rotation saw %s, want %s", got, fp)
	}
}

func fingerprintPEM(t *testing.T, certPEM string) string {
	t.Helper()
	b, _ := pem.Decode([]byte(certPEM))
	c, err := x509.ParseCertificate(b.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	return fingerprint(c)
}

func writeJSON(t *testing.T, path string, v pendingFile) {
	t.Helper()
	body := []byte(`{"fingerprint":"` + v.Fingerprint + `","confirmBy":"` + v.ConfirmBy.UTC().Format(time.RFC3339) + `"}`)
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
}
