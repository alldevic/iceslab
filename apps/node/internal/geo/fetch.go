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
)

// stallTimeout bounds how long a single attempt may go with NOTHING arriving —
// not how long it may take. It used to be `fetchTimeout`, a deadline on dial +
// transfer, and that made the bigger of the two geo databases impossible to
// pull. Measured 2026-08-28 against the real upstream: geoip.dat is 18 671 837
// bytes and geosite.dat is 73 703 302 — the latter needs a sustained ~20 Mbit/s
// to land inside 30 s, from a node whose whole reason for taking geo off the
// panel is that its own links are bad.
//
// A blackholed host still fails fast: that is the 10 s dial and 10 s TLS
// handshake in the transport below, not this. What this allows through is the
// slow-but-moving transfer, which is the case the feature exists for.
var stallTimeout = 30 * time.Second

// fetchBackoffBase is the first inter-attempt delay; it doubles each retry
// (1s, 2s). A var (not const) only so tests can shrink it - prod keeps 1s.
var fetchBackoffBase = time.Second

// fetchTotalBudget caps the WHOLE retry loop (all attempts + backoff). This
// bounds how long HTTPFetch can block: geopkg.Ensure calls it synchronously
// under the adapter's restartMu (regenerateAndRestart / liveUpdateUser), so
// without a shared cap a fetch would hold that lock and stall every queued
// apply. A var (not const) only so tests can shrink it.
//
// It was 60 s, which is less than the 74 s it takes to move geosite.dat at
// 1 MB/s — so on any link slower than about 10 Mbit/s the file could not land,
// ever, no matter how many times the panel re-pushed. Ten minutes covers
// ~1 Mbit/s for that file and still bounds the lock.
//
// Raising it does NOT make a dead host more expensive: a blackhole is bounded
// by the 10 s dial + 10 s handshake in the transport below (~33 s for all three
// attempts with backoff), and a silent-mid-transfer host by stallTimeout. This
// budget only ever bites a transfer that is actually moving.
var fetchTotalBudget = 10 * time.Minute

// httpClient fails a blackholed connection fast (short dial + TLS-handshake
// timeout) while still allowing a slow-but-live transfer to run as long as it
// keeps moving, so a SYN-dropped host (RU DPI) costs ~10s per attempt. Cloned
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
	// Cancel-on-silence rather than cancel-at-a-deadline: the timer is armed
	// before the request and pushed forward by every byte that arrives.
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	stall := time.AfterFunc(stallTimeout, cancel)
	defer stall.Stop()

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
	reader := &stallResetReader{r: io.LimitReader(resp.Body, maxDatBytes+1), timer: stall}
	b, err := io.ReadAll(reader)
	if err != nil {
		return nil, true, err // a mid-stream read error is transient -> retry
	}
	if len(b) > maxDatBytes {
		return nil, false, fmt.Errorf("geo fetch %s: body exceeds %d bytes", url, maxDatBytes)
	}
	return b, false, nil
}

// stallResetReader pushes the stall timer forward on every read that produced
// bytes. Reads that return nothing do not count: a server that keeps the
// connection open and sends nothing is exactly what the timer is for.
type stallResetReader struct {
	r     io.Reader
	timer *time.Timer
}

func (s *stallResetReader) Read(p []byte) (int, error) {
	n, err := s.r.Read(p)
	if n > 0 {
		s.timer.Reset(stallTimeout)
	}
	return n, err
}
