// Package certstore holds the agent's mTLS server certificate and renews it
// in place (A-124).
//
// A-124, 22.10: the node's server certificate is issued for a year and nothing
// renewed it. A year after its bootstrap every panel request to the node fails
// on the expired certificate, the node goes unreachable and drops out of every
// subscription while its cores keep running. The panel now hands the agent a
// new pair over the live channel ahead of time (POST /rotateCert); the agent
// checks it, serves it to new handshakes without a restart, and waits for the
// panel to confirm from a new connection (POST /rotateCert/confirm). With no
// confirm by the deadline it goes back to the old pair by itself, so a pair the
// panel cannot reach the node with never locks it out.
//
// On disk, in Dir (default /etc/iceslab-node/tls), 0600:
//
//	node.crt, node.key            the pair in force; on start it wins over
//	                              NODE_PAYLOAD, which keeps the bootstrap pair
//	node.crt.prev, node.key.prev  the pair before the last rotation
//	pending.json                  a rotation waiting for its confirm
package certstore

import (
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/atomicfile"
)

// DefaultDir is where the pair lives on a node.
const DefaultDir = "/etc/iceslab-node/tls"

// ConfirmWindow is how long a rotated pair waits for its confirm.
const ConfirmWindow = 10 * time.Minute

// ErrInvalid is a pair the checks refuse (400 CERT_INVALID).
var ErrInvalid = errors.New("certificate refused")

// ErrPending is a rotation while an earlier one waits (409
// CERT_ROTATION_PENDING).
var ErrPending = errors.New("an earlier rotation waits for its confirm")

// ErrNotPending is a confirm with nothing, or something else, waiting.
var ErrNotPending = errors.New("no rotation with this fingerprint waits for a confirm")

type pair struct {
	certPEM, keyPEM []byte
	cert            tls.Certificate
	leaf            *x509.Certificate
}

type pendingFile struct {
	Fingerprint string    `json:"fingerprint"`
	ConfirmBy   time.Time `json:"confirmBy"`
}

// Store serves the pair in force through GetCertificate.
type Store struct {
	dir    string
	ca     *x509.CertPool
	logger *slog.Logger
	now    func() time.Time
	window time.Duration

	mu      sync.Mutex
	current *pair
	prev    *pair
	pending *pendingFile
	timer   *time.Timer
}

// Config for Open. Now and Window are for tests.
type Config struct {
	Dir            string
	CACertPEM      string
	PayloadCertPEM string
	PayloadKeyPEM  string
	Logger         *slog.Logger
	Now            func() time.Time
	Window         time.Duration
}

// Open loads the pair in force: node.crt/node.key from Dir when they hold a
// valid pair that chains to the CA, else the payload's. A rotation that was
// waiting when the agent stopped is picked up: past its deadline it is rolled
// back now, otherwise its timer is armed again for what is left.
func Open(cfg Config) (*Store, error) {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Window == 0 {
		cfg.Window = ConfirmWindow
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	ca := x509.NewCertPool()
	if !ca.AppendCertsFromPEM([]byte(cfg.CACertPEM)) {
		return nil, errors.New("invalid CA pem in payload")
	}
	s := &Store{dir: cfg.Dir, ca: ca, logger: cfg.Logger, now: cfg.Now, window: cfg.Window}

	fromPayload, err := s.load([]byte(cfg.PayloadCertPEM), []byte(cfg.PayloadKeyPEM), pairOnly)
	if err != nil {
		return nil, fmt.Errorf("load node keypair from payload: %w", err)
	}
	s.current = fromPayload
	if s.dir == "" {
		return s, nil
	}
	if p, err := s.loadFiles("node.crt", "node.key"); err == nil {
		s.current = p
	} else if !os.IsNotExist(err) {
		s.logger.Error("certstore: the pair on disk is unusable, serving the payload's", "err", err)
	}
	if p, err := s.loadFiles("node.crt.prev", "node.key.prev"); err == nil {
		s.prev = p
	}
	if body, err := os.ReadFile(filepath.Join(s.dir, "pending.json")); err == nil {
		var pf pendingFile
		if json.Unmarshal(body, &pf) == nil && pf.Fingerprint == fingerprint(s.current.leaf) {
			s.pending = &pf
			s.mu.Lock()
			if !s.now().Before(pf.ConfirmBy) {
				s.rollbackLocked("the agent restarted past the confirm deadline")
			} else {
				s.armLocked(pf.ConfirmBy.Sub(s.now()))
			}
			s.mu.Unlock()
		} else {
			_ = os.Remove(filepath.Join(s.dir, "pending.json"))
		}
	}
	return s, nil
}

func (s *Store) loadFiles(certName, keyName string) (*pair, error) {
	c, err := os.ReadFile(filepath.Join(s.dir, certName))
	if err != nil {
		return nil, err
	}
	k, err := os.ReadFile(filepath.Join(s.dir, keyName))
	if err != nil {
		return nil, err
	}
	return s.load(c, k, chained)
}

type check int

const (
	// pairOnly: the key matches. The payload's pair, as the agent always
	// took it: an expired one still has to be served, or a node a year past
	// its bootstrap would not even start to be renewed.
	pairOnly check = iota
	// chained: and the leaf chains to this node's CA for server auth, at any
	// time of its life. The pair on disk, for the same reason.
	chained
	// strict: and it is in date now. A pair handed to Rotate.
	strict
)

// load is the pair a node may serve, checked as far as `c` asks.
func (s *Store) load(certPEM, keyPEM []byte, c check) (*pair, error) {
	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, fmt.Errorf("key and certificate are not a pair: %w", err)
	}
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		return nil, fmt.Errorf("parse certificate: %w", err)
	}
	if c >= chained {
		at := s.now()
		if c == chained {
			at = leaf.NotBefore.Add(time.Second)
		}
		if _, err := leaf.Verify(x509.VerifyOptions{
			Roots:       s.ca,
			CurrentTime: at,
			KeyUsages:   []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		}); err != nil {
			return nil, fmt.Errorf("does not chain to this node's CA for server auth, or is out of date: %w", err)
		}
	}
	cert.Leaf = leaf
	return &pair{certPEM: certPEM, keyPEM: keyPEM, cert: cert, leaf: leaf}, nil
}

// GetCertificate is tls.Config.GetCertificate: every new handshake gets the
// pair in force at that moment.
func (s *Store) GetCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.current.cert
	return &c, nil
}

// NotAfter of the pair in force, for /healthz.
func (s *Store) NotAfter() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.current.leaf.NotAfter
}

// Fingerprint of the pair in force.
func (s *Store) Fingerprint() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return fingerprint(s.current.leaf)
}

// Rotate checks a new pair, writes it beside the old one and serves it to new
// handshakes. The checks: the key matches, the leaf chains to this node's CA
// for server auth and is in date, and it names every name and address the
// pair in force does, so the panel still reaches the node by the address it
// dials.
func (s *Store) Rotate(certPEM, keyPEM string) (fp string, confirmBy time.Time, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pending != nil {
		return "", time.Time{}, ErrPending
	}
	next, err := s.load([]byte(certPEM), []byte(keyPEM), strict)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	if missing := missingNames(s.current.leaf, next.leaf); missing != "" {
		return "", time.Time{}, fmt.Errorf("%w: the new certificate does not name %s, which the one in force does", ErrInvalid, missing)
	}
	if s.dir != "" {
		// The old pair first: whatever happens after, it is on disk to go back to.
		if err := s.writePair(s.current, "node.crt.prev", "node.key.prev"); err != nil {
			return "", time.Time{}, err
		}
		if err := s.writePair(next, "node.crt", "node.key"); err != nil {
			return "", time.Time{}, err
		}
	}
	pf := &pendingFile{Fingerprint: fingerprint(next.leaf), ConfirmBy: s.now().Add(s.window).UTC().Truncate(time.Second)}
	if s.dir != "" {
		body, _ := json.Marshal(pf)
		if err := atomicfile.Write(filepath.Join(s.dir, "pending.json"), body, 0o600); err != nil {
			return "", time.Time{}, fmt.Errorf("write pending.json: %w", err)
		}
	}
	s.prev, s.current, s.pending = s.current, next, pf
	s.armLocked(s.window)
	s.logger.Info("certstore: new certificate in force, waiting for the panel's confirm",
		"fingerprint", pf.Fingerprint, "notAfter", next.leaf.NotAfter, "confirmBy", pf.ConfirmBy)
	return pf.Fingerprint, pf.ConfirmBy, nil
}

// Confirm ends the waiting rotation: the panel reached the node on the new
// pair from a new connection. The old pair stays on disk as .prev.
func (s *Store) Confirm(fp string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pending == nil || s.pending.Fingerprint != fp {
		return ErrNotPending
	}
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	s.pending = nil
	if s.dir != "" {
		if err := os.Remove(filepath.Join(s.dir, "pending.json")); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove pending.json: %w", err)
		}
	}
	s.logger.Info("certstore: rotation confirmed", "fingerprint", fp)
	return nil
}

func (s *Store) armLocked(after time.Duration) {
	if s.timer != nil {
		s.timer.Stop()
	}
	s.timer = time.AfterFunc(after, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.pending != nil {
			s.rollbackLocked("no confirm by the deadline")
		}
	})
}

// rollbackLocked puts the previous pair back in force and on disk.
func (s *Store) rollbackLocked(why string) {
	if s.prev == nil {
		s.logger.Error("certstore: rollback wanted and no previous pair to go back to", "why", why)
		s.pending = nil
		return
	}
	if s.dir != "" {
		if err := s.writePair(s.prev, "node.crt", "node.key"); err != nil {
			s.logger.Error("certstore: rollback could not write the previous pair", "err", err)
		}
		_ = os.Remove(filepath.Join(s.dir, "pending.json"))
	}
	refused := fingerprint(s.current.leaf)
	s.current, s.pending = s.prev, nil
	s.timer = nil
	s.logger.Warn("certstore: rotated certificate rolled back", "why", why,
		"refused", refused, "inForce", fingerprint(s.current.leaf))
}

// writePair writes the key and then the certificate, each atomically. Not
// one atomic step for both: a crash between them leaves a pair that does not
// load, and Open then serves the payload's pair, which the panel still trusts.
func (s *Store) writePair(p *pair, certName, keyName string) error {
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return fmt.Errorf("mkdir %s: %w", s.dir, err)
	}
	if err := atomicfile.Write(filepath.Join(s.dir, keyName), p.keyPEM, 0o600); err != nil {
		return fmt.Errorf("write %s: %w", keyName, err)
	}
	if err := atomicfile.Write(filepath.Join(s.dir, certName), p.certPEM, 0o600); err != nil {
		return fmt.Errorf("write %s: %w", certName, err)
	}
	return nil
}

// missingNames is the first DNS name or IP of `old` that `next` does not
// carry, empty when it carries them all.
func missingNames(old, next *x509.Certificate) string {
	names := make(map[string]bool, len(next.DNSNames))
	for _, n := range next.DNSNames {
		names[n] = true
	}
	for _, n := range old.DNSNames {
		if !names[n] {
			return n
		}
	}
	for _, ip := range old.IPAddresses {
		found := false
		for _, nip := range next.IPAddresses {
			if nip.Equal(ip) {
				found = true
				break
			}
		}
		if !found {
			return ip.String()
		}
	}
	return ""
}

func fingerprint(leaf *x509.Certificate) string {
	sum := sha256.Sum256(leaf.Raw)
	return hex.EncodeToString(sum[:])
}
