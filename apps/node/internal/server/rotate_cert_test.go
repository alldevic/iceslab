package server

import (
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
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/certstore"
	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
	"github.com/icecompany-tech/iceslab/apps/node/internal/payload"
)

// A-124, 22.10: the wire of /rotateCert, /rotateCert/confirm and the two
// healthz fields. The checks themselves are certstore's tests.

func issue(t *testing.T, caCert *x509.Certificate, caKey *ecdsa.PrivateKey, notAfter time.Time) (string, string) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	serial, _ := rand.Int(rand.Reader, big.NewInt(1<<62))
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "node"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     notAfter,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"n1.example.test"},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, caCert, &key.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	kder, _ := x509.MarshalECPrivateKey(key)
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})),
		string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kder}))
}

func post(t *testing.T, s *Server, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	b, _ := json.Marshal(body)
	rr := httptest.NewRecorder()
	s.routes().ServeHTTP(rr, httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(b))))
	return rr
}

func TestRotateCertOverTheWire(t *testing.T) {
	caKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	caTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "ca"},
		NotBefore: time.Now().Add(-48 * time.Hour), NotAfter: time.Now().Add(24 * 365 * time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	caDER, _ := x509.CreateCertificate(rand.Reader, caTmpl, caTmpl, &caKey.PublicKey, caKey)
	caCert, _ := x509.ParseCertificate(caDER)
	caPEM := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}))

	oldAfter := time.Now().Add(20 * 24 * time.Hour).UTC().Truncate(time.Second)
	oldC, oldK := issue(t, caCert, caKey, oldAfter)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	certs, err := certstore.Open(certstore.Config{Dir: t.TempDir(), CACertPEM: caPEM, PayloadCertPEM: oldC, PayloadKeyPEM: oldK, Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	s, err := New(Config{Logger: logger, Payload: &payload.Payload{}, Certs: certs, AgentVersion: "v0.3.0-test"})
	if err != nil {
		t.Fatal(err)
	}

	h := healthOf(t, s)
	if h.CertNotAfter != oldAfter.Format(time.RFC3339) || h.AgentVersion != "v0.3.0-test" {
		t.Fatalf("healthz certNotAfter=%q agentVersion=%q", h.CertNotAfter, h.AgentVersion)
	}

	// Refused: a pair whose key is not its own.
	badC, _ := issue(t, caCert, caKey, time.Now().Add(365*24*time.Hour))
	if rr := post(t, s, "/rotateCert", dto.RotateCertRequest{CertPEM: badC, KeyPEM: oldK}); rr.Code != http.StatusBadRequest || !strings.Contains(rr.Body.String(), "CERT_INVALID") {
		t.Fatalf("mismatched pair: %d %s", rr.Code, rr.Body.String())
	}

	newAfter := time.Now().Add(365 * 24 * time.Hour).UTC().Truncate(time.Second)
	newC, newK := issue(t, caCert, caKey, newAfter)
	rr := post(t, s, "/rotateCert", dto.RotateCertRequest{CertPEM: newC, KeyPEM: newK})
	if rr.Code != http.StatusOK {
		t.Fatalf("rotate: %d %s", rr.Code, rr.Body.String())
	}
	var resp dto.RotateCertResponse
	_ = json.Unmarshal(rr.Body.Bytes(), &resp)
	if !resp.OK || len(resp.Fingerprint) != 64 {
		t.Fatalf("rotate response %+v", resp)
	}
	if _, err := time.Parse(time.RFC3339, resp.ConfirmBy); err != nil {
		t.Fatalf("confirmBy %q: %v", resp.ConfirmBy, err)
	}
	if h := healthOf(t, s); h.CertNotAfter != newAfter.Format(time.RFC3339) {
		t.Fatalf("healthz certNotAfter %q, want the new pair's", h.CertNotAfter)
	}

	// A second one before the confirm.
	c2, k2 := issue(t, caCert, caKey, newAfter)
	if rr := post(t, s, "/rotateCert", dto.RotateCertRequest{CertPEM: c2, KeyPEM: k2}); rr.Code != http.StatusConflict || !strings.Contains(rr.Body.String(), "CERT_ROTATION_PENDING") {
		t.Fatalf("second rotation: %d %s", rr.Code, rr.Body.String())
	}
	if rr := post(t, s, "/rotateCert/confirm", dto.ConfirmCertRequest{Fingerprint: resp.Fingerprint}); rr.Code != http.StatusOK {
		t.Fatalf("confirm: %d %s", rr.Code, rr.Body.String())
	}
	if rr := post(t, s, "/rotateCert/confirm", dto.ConfirmCertRequest{Fingerprint: resp.Fingerprint}); rr.Code != http.StatusConflict {
		t.Fatalf("a second confirm: %d, want 409", rr.Code)
	}
}
