package singbox

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"io"
	"log/slog"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

var _ core.TLSReporter = (*Adapter)(nil)

// issue makes a certificate for name, self-signed when parent is nil.
func issue(t *testing.T, name string, parent *x509.Certificate, parentKey *ecdsa.PrivateKey) (*x509.Certificate, *ecdsa.PrivateKey, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(time.Now().UnixNano()),
		Subject:               pkix.Name{CommonName: name},
		DNSNames:              []string{name},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour).Truncate(time.Second),
		IsCA:                  parent == nil,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
	}
	signer, signerKey := tmpl, key
	if parent != nil {
		signer, signerKey = parent, parentKey
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, signer, &key.PublicKey, signerKey)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return cert, key, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

func tlsAdapter(protocol, certPath string) *Adapter {
	return New(Config{Protocol: protocol, CertPath: certPath}, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func TestTLSFactSelfSigned(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cert.pem")
	cert, _, certPem := issue(t, "www.bing.com", nil, nil)
	if err := os.WriteFile(path, certPem, 0o644); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(cert.Raw)

	f := tlsAdapter("hysteria", path).TLSFact()
	if f == nil {
		t.Fatal("TLSFact() = nil for a self-signed certificate")
	}
	if f.Source != "self-signed" || f.CertSha256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("fact = %+v, want self-signed %x", f, sum)
	}
	if f.ServerName != "www.bing.com" || f.CertPem != string(certPem) || !f.NotAfter.Equal(cert.NotAfter) {
		t.Fatalf("fact = %+v, want the SAN name, the PEM and NotAfter %v", f, cert.NotAfter)
	}
}

// The file is read again when it changes: a bootstrap that regenerated the
// certificate is seen on the next healthcheck, not after a restart.
func TestTLSFactFollowsTheFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cert.pem")
	_, _, first := issue(t, "a.example", nil, nil)
	if err := os.WriteFile(path, first, 0o644); err != nil {
		t.Fatal(err)
	}
	a := tlsAdapter("tuic", path)
	if f := a.TLSFact(); f == nil || f.ServerName != "a.example" {
		t.Fatalf("first fact = %+v", f)
	}
	_, _, second := issue(t, "b.example.org", nil, nil)
	if err := os.WriteFile(path, second, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, time.Now(), time.Now().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if f := a.TLSFact(); f == nil || f.ServerName != "b.example.org" {
		t.Fatalf("fact after the file changed = %+v", f)
	}
}

func TestTLSFactNone(t *testing.T) {
	dir := t.TempDir()
	caCert, caKey, _ := issue(t, "ca.example", nil, nil)
	_, _, leaf := issue(t, "hy.example.com", caCert, caKey)
	issued := filepath.Join(dir, "issued.pem")
	garbage := filepath.Join(dir, "garbage.pem")
	if err := os.WriteFile(issued, leaf, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(garbage, []byte("not a certificate"), 0o644); err != nil {
		t.Fatal(err)
	}
	for name, a := range map[string]*Adapter{
		"no cert path (xray family)": tlsAdapter("xray", ""),
		"missing file":               tlsAdapter("hysteria", filepath.Join(dir, "absent.pem")),
		"not a certificate":          tlsAdapter("hysteria", garbage),
		"issued by a CA":             tlsAdapter("hysteria", issued),
	} {
		if f := a.TLSFact(); f != nil {
			t.Errorf("%s: TLSFact() = %+v, want nil", name, f)
		}
	}
}
