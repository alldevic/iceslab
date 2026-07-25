package geo

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"
)

// maxDatBytes caps a downloaded geo database (geoip.dat runs ~20MB; the cap is
// generous but bounds a hostile/huge response).
const maxDatBytes = 128 << 20

const (
	// fetchAttempts bounds the retry loop. A GET is idempotent, so a transient
	// failure (the GitHub release CDN flaps from RU; a panel restart mid-fetch)
	// is worth retrying instead of leaving the node on stale/bundled geo until
	// the panel next re-pushes (which only happens when the content changes).
	fetchAttempts = 3
	// fetchTimeout caps a SINGLE attempt (dial + transfer).
	fetchTimeout = 30 * time.Second
)

// fetchBackoffBase is the first inter-attempt delay; it doubles each retry
// (1s, 2s). A var (not const) only so tests can shrink it - prod keeps 1s.
var fetchBackoffBase = time.Second

// fetchTotalBudget caps the WHOLE retry loop (all attempts + backoff). This
// bounds how long HTTPFetch can block: geopkg.Ensure calls it synchronously
// under the adapter's restartMu (regenerateAndRestart / liveUpdateUser), so
// without a shared cap a blackholed host would hold that lock for
// attempts x per-attempt-timeout and stall every queued apply. A var (not const)
// only so tests can shrink it - prod keeps 60s.
var fetchTotalBudget = 60 * time.Second

// httpClient fails a blackholed connection fast (short dial + TLS-handshake
// timeout) while still allowing a slow-but-live transfer up to fetchTimeout, so
// a SYN-dropped host (RU DPI) costs ~10s per attempt, not the full 30s. Cloned
// from http.DefaultTransport's defaults with tightened dial/handshake timeouts.
var httpClient = &http.Client{
	Transport: &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: time.Second,
	},
}

// HTTPFetch is the default Fetcher: GET the URL, cap the body, return the bytes.
// Retries a transient failure (transport error, 5xx, 429) with exponential
// backoff, under a shared total budget. Integrity (sha256) is verified by the
// installer against the panel-provided digest, so this does no verification.
func HTTPFetch(url string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), fetchTotalBudget)
	defer cancel()

	var lastErr error
	for attempt := 0; attempt < fetchAttempts; attempt++ {
		if attempt > 0 {
			select {
			case <-time.After(fetchBackoffBase << (attempt - 1)):
			case <-ctx.Done():
				return nil, fmt.Errorf("geo fetch %s: %w", url, ctx.Err())
			}
		}
		b, retryable, err := httpFetchOnce(ctx, url)
		if err == nil {
			return b, nil
		}
		lastErr = err
		if !retryable || ctx.Err() != nil {
			break // permanent failure, or the shared budget is spent
		}
	}
	return nil, fmt.Errorf("geo fetch %s: after %d attempts: %w", url, fetchAttempts, lastErr)
}

// httpFetchOnce performs one GET under a per-attempt timeout derived from parent
// (so it never outlives the total budget). retryable is true for a transient
// failure; false for a permanent one (4xx other than 429, or an over-cap body).
func httpFetchOnce(parent context.Context, url string) (body []byte, retryable bool, err error) {
	ctx, cancel := context.WithTimeout(parent, fetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, false, err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, true, err // transport error (timeout, reset, DNS) -> retry
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		// Retry a transient server state; a 4xx (bad URL/token) is permanent.
		retry := resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests
		return nil, retry, fmt.Errorf("geo fetch %s: HTTP %d", url, resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxDatBytes+1))
	if err != nil {
		return nil, true, err // a mid-stream read error is transient -> retry
	}
	if len(b) > maxDatBytes {
		return nil, false, fmt.Errorf("geo fetch %s: body exceeds %d bytes", url, maxDatBytes)
	}
	return b, false, nil
}
