package singbox

import (
	"bytes"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"os"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// certCache: the fact of the certificate file as last read, and the file's
// mtime and size at that read. The healthcheck asks every 30 s and the file
// changes about never, so it is parsed again only when it changes.
type certCache struct {
	modTime time.Time
	size    int64
	fact    *core.TLSFact
}

// TLSFact implements core.TLSReporter: the certificate at CertPath, the one
// bootstrap-singbox.sh generated and every TLS protocol of this engine serves.
// Unlike native hysteria, the panel did not mint it and has no copy, so the
// fact carries what a client needs to pin it: the sha256 of the DER, the name
// in its SAN (clients check the name against the pinned certificate) and the
// certificate itself (sing-box clients take it as their trust anchor).
//
// nil when the adapter serves no certificate (xray family, shadowsocks,
// shadowtls), when the file cannot be read or parsed, and when the certificate
// is not self-signed: one a CA issued needs no pin and verifies by name.
func (a *Adapter) TLSFact() *core.TLSFact {
	if a.cfg.CertPath == "" {
		return nil
	}
	st, err := os.Stat(a.cfg.CertPath)
	if err != nil {
		return nil
	}
	a.mu.Lock()
	c := a.cert
	a.mu.Unlock()
	if c == nil || !c.modTime.Equal(st.ModTime()) || c.size != st.Size() {
		// Read with mu released: it is held for fast operations only.
		c = &certCache{modTime: st.ModTime(), size: st.Size(), fact: readCertFact(a.cfg.CertPath)}
		a.mu.Lock()
		a.cert = c
		a.mu.Unlock()
	}
	if c.fact == nil {
		return nil
	}
	f := *c.fact
	return &f
}

// readCertFact reads the first certificate of a PEM file. nil when there is
// none or it is not self-signed.
func readCertFact(path string) *core.TLSFact {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var block *pem.Block
	for rest := raw; ; {
		block, rest = pem.Decode(rest)
		if block == nil || block.Type == "CERTIFICATE" {
			break
		}
	}
	if block == nil {
		return nil
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil || !isSelfSigned(cert) {
		return nil
	}
	sum := sha256.Sum256(cert.Raw)
	return &core.TLSFact{
		Source:     "self-signed",
		CertSha256: hex.EncodeToString(sum[:]),
		NotAfter:   cert.NotAfter,
		ServerName: certName(cert),
		CertPem:    string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Raw})),
	}
}

func isSelfSigned(cert *x509.Certificate) bool {
	return bytes.Equal(cert.RawIssuer, cert.RawSubject) &&
		cert.CheckSignature(cert.SignatureAlgorithm, cert.RawTBSCertificate, cert.Signature) == nil
}

// certName is the name a client checks against the certificate: its first DNS
// SAN (bootstrap-singbox.sh writes SINGBOX_SNI there), else its first IP SAN,
// else the CN.
func certName(cert *x509.Certificate) string {
	if len(cert.DNSNames) > 0 {
		return cert.DNSNames[0]
	}
	if len(cert.IPAddresses) > 0 {
		return cert.IPAddresses[0].String()
	}
	return cert.Subject.CommonName
}
