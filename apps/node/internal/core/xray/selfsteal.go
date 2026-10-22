package xray

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"
)

// K9-B: REALITY self-steal local TLS fallback.
//
// Problem (field 2026-06-11): our REALITY default is "steal-from-others" -
// dest = an external site (cloudflare/samsung), serverName = that same site.
// The client sends the external site's SNI but connects to the NODE's IP, which
// doesn't belong to that site -> SNI-IP mismatch -> RU-DPI mangles the
// handshake ("failed to read client hello"). REALITY is useless in RU this way.
//
// Fix (steal-from-yourself): dest = 127.0.0.1:8443 (a TLS endpoint on the node
// itself) + serverNames = the node's own domain (which resolves to the node IP
// -> SNI and IP are consistent). This server is that local endpoint. xray
// forwards any non-REALITY (prober) handshake to it, so a prober sees a real
// TLS 1.3 site on the node's domain instead of a mismatch.
//
// The cert is self-signed for the domain (sanctioned by BACKLOG K9: "nginx/
// caddy с LE-сертом ... ИЛИ self-signed"). Self-signed is a weaker masquerade
// than a real LE cert (a prober sees an untrusted cert) but it fully fixes the
// SNI-IP-mismatch detection vector, which is the one RU-DPI actually uses. An
// operator wanting stronger probe-resistance can point dest at a real
// nginx+LE site instead; this is the zero-install default.

// selfStealAddr is where the local TLS fallback listens. Loopback only - it's
// reachable solely by the node's own xray process (REALITY's dest dial), never
// exposed externally.
const selfStealAddr = "127.0.0.1:8443"

// selfStealModeValue is the RealityMode wire value that turns this on.
const selfStealModeValue = "self-steal"

// selfStealLandingHTML is the benign page a prober sees. Deliberately generic -
// a plain default-install landing page, nothing that screams "proxy".
const selfStealLandingHTML = `<!DOCTYPE html>
<html>
<head><title>Welcome</title></head>
<body>
<h1>It works!</h1>
<p>This is the default web page for this server.</p>
</body>
</html>
`

// selfStealSite is what one self-steal inbound needs from the fallback: a
// certificate for its serverNames and the page behind it.
type selfStealSite struct {
	names    []string
	upstream string
}

// selfStealServer is the running local TLS fallback. key is the site set it
// was started with, so the adapter can tell a change and restart (fresh certs
// for new names, or a new realistic-fallback target).
//
// ONE listener for every self-steal inbound of the core, told apart by SNI.
// Every one of them renders dest = selfStealAddr, and REALITY hands the
// client's ClientHello to dest unchanged, so the SNI that arrives here is the
// serverName the client asked the inbound for. A-129, 22.10: the fallback was
// started from the install-time inbound alone; a pushed self-steal inbound
// (every one, on a panel-provisioned node) got dest = 127.0.0.1:8443 with
// nothing listening there, and REALITY, which dials dest at the start of every
// handshake (xtls/reality tls.go:168-172), closed every connection, honest
// clients included.
type selfStealServer struct {
	srv *http.Server
	key string
}

// selfStealKey is the identity of a site set: names and upstream, in order.
func selfStealKey(sites []selfStealSite) string {
	var b strings.Builder
	for _, s := range sites {
		b.WriteString(strings.Join(s.names, ","))
		b.WriteString("|")
		b.WriteString(s.upstream)
		b.WriteString(";")
	}
	return b.String()
}

// selfStealSites collects the sites of every self-steal inbound in render
// order. An inbound without a serverName has nothing to put on a certificate
// and is skipped, the same rule the single-inbound version had.
func selfStealSites(inbounds []InboundConfig) []selfStealSite {
	var out []selfStealSite
	for _, in := range inbounds {
		if in.RealityMode != selfStealModeValue || len(in.RealityServerNames) == 0 {
			continue
		}
		out = append(out, selfStealSite{
			names:    append([]string(nil), in.RealityServerNames...),
			upstream: in.RealityFallbackUpstream,
		})
	}
	return out
}

// selfStealConflict refuses two self-steal inbounds that claim one name with
// different pages behind it: the fallback tells sites apart by SNI only, so
// one of the two would silently serve the other's.
func selfStealConflict(inbounds []InboundConfig) error {
	upstreamOf := make(map[string]string)
	for _, s := range selfStealSites(inbounds) {
		for _, n := range s.names {
			n = strings.ToLower(n)
			if prev, ok := upstreamOf[n]; ok && prev != s.upstream {
				return fmt.Errorf("two self-steal inbounds name %s with different fallback upstreams (%q and %q)", n, prev, s.upstream)
			}
			upstreamOf[n] = s.upstream
		}
	}
	return nil
}

// generateSelfSignedCert builds an ECDSA P-256 self-signed leaf for `domain`
// and any further names, valid ~10y. Used as the local fallback's TLS identity.
func generateSelfSignedCert(domain string, more ...string) (tls.Certificate, error) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("gen key: %w", err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("gen serial: %w", err)
	}
	tmpl := x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: domain},
		DNSNames:              append([]string{domain}, more...),
		NotBefore:             time.Now().Add(-1 * time.Hour),
		NotAfter:              time.Now().AddDate(10, 0, 0),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &priv.PublicKey, priv)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("create cert: %w", err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: priv}, nil
}

// writeStaticLanding serves the benign default-install page: the zero-config
// fallback when no realistic upstream is set, and the safety net when a
// configured upstream is unreachable.
func writeStaticLanding(w http.ResponseWriter) {
	w.Header().Set("Server", "nginx")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = io.WriteString(w, selfStealLandingHTML)
}

// buildSelfStealHandler decides what a prober sees. With no upstream it's the
// static landing page (G1 off, the K9-B default - self-signed cert + stub).
// With an upstream (G1 realistic fallback) it reverse-proxies probe requests to
// a real site, so a deep prober sees genuine content instead of a stub - the
// cheapest strong lift against active probing. Any upstream error falls back to
// the static page rather than leaking a Go proxy error that would flag the node.
func buildSelfStealHandler(upstream string, logger *slog.Logger) (http.Handler, error) {
	if upstream == "" {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			writeStaticLanding(w)
		}), nil
	}
	target, err := url.Parse(upstream)
	if err != nil || (target.Scheme != "http" && target.Scheme != "https") || target.Host == "" {
		return nil, fmt.Errorf("invalid self-steal upstream %q", upstream)
	}
	rp := httputil.NewSingleHostReverseProxy(target)
	baseDirector := rp.Director
	rp.Director = func(req *http.Request) {
		baseDirector(req)
		// Send the upstream's own Host so it serves the intended vhost.
		req.Host = target.Host
	}
	rp.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, perr error) {
		logger.Warn("xray self-steal upstream failed; serving static landing",
			"upstream", upstream, "err", perr)
		writeStaticLanding(w)
	}
	return rp, nil
}

// startSelfSteal launches the local TLS 1.3 fallback on `addr`, one self-signed
// cert per site, picked by the SNI. MinVersion is pinned to TLS 1.3 because
// REALITY requires its dest to negotiate 1.3 (a 1.2 fallback would make the
// borrowed handshake detectable). Each site's handler is the static landing
// page, or a reverse proxy to its upstream when set (G1 realistic fallback).
// An SNI no site names (a prober that sent none) gets the first site.
//
// `selfStealListen` is injectable so tests can bind an ephemeral port.
func startSelfSteal(addr string, sites []selfStealSite, logger *slog.Logger) (*selfStealServer, error) {
	if len(sites) == 0 {
		return nil, errors.New("self-steal: no site to serve")
	}
	certs := make([]tls.Certificate, len(sites))
	handlers := make([]http.Handler, len(sites))
	byName := make(map[string]int)
	for i, s := range sites {
		cert, err := generateSelfSignedCert(s.names[0], s.names[1:]...)
		if err != nil {
			return nil, fmt.Errorf("self-steal cert: %w", err)
		}
		h, err := buildSelfStealHandler(s.upstream, logger)
		if err != nil {
			return nil, err
		}
		certs[i], handlers[i] = cert, h
		for _, n := range s.names {
			if _, taken := byName[strings.ToLower(n)]; !taken {
				byName[strings.ToLower(n)] = i
			}
		}
	}
	siteOf := func(sni string) int {
		if i, ok := byName[strings.ToLower(sni)]; ok {
			return i
		}
		return 0
	}
	srv := &http.Server{
		Addr: addr,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			sni := ""
			if r.TLS != nil {
				sni = r.TLS.ServerName
			}
			handlers[siteOf(sni)].ServeHTTP(w, r)
		}),
		TLSConfig: &tls.Config{
			MinVersion: tls.VersionTLS13,
			GetCertificate: func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
				return &certs[siteOf(hello.ServerName)], nil
			},
		},
		ReadHeaderTimeout: 5 * time.Second,
	}
	ln, err := selfStealListen(addr)
	if err != nil {
		return nil, err
	}
	key := selfStealKey(sites)
	go func() {
		logger.Info("xray self-steal TLS fallback listening", "addr", addr, "sites", key)
		// Certs are supplied via TLSConfig, so the cert/key file args are empty.
		if err := srv.ServeTLS(ln, "", ""); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("xray self-steal fallback failed", "err", err)
		}
	}()
	return &selfStealServer{srv: srv, key: key}, nil
}

// selfStealListen is split out so tests can swap in an ephemeral listener.
var selfStealListen = func(addr string) (net.Listener, error) {
	return net.Listen("tcp", addr)
}

func (s *selfStealServer) stop(ctx context.Context) error {
	if s == nil || s.srv == nil {
		return nil
	}
	shutCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	return s.srv.Shutdown(shutCtx)
}
