package geo

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// fastBackoff shrinks the retry backoff for a test so it doesn't sleep ~3s of
// real wall-clock; restored on cleanup.
func fastBackoff(t *testing.T) {
	t.Helper()
	prev := fetchBackoffBase
	fetchBackoffBase = time.Millisecond
	t.Cleanup(func() { fetchBackoffBase = prev })
}

func serveStatus(status int, body string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
}

// §3.9: a single attempt classifies transient (retryable) vs permanent failures.
func TestHTTPFetchOnce_Classification(t *testing.T) {
	cases := []struct {
		name          string
		status        int
		wantErr       bool
		wantRetryable bool
	}{
		{"200 ok", http.StatusOK, false, false},
		{"503 transient", http.StatusServiceUnavailable, true, true},
		{"429 too many", http.StatusTooManyRequests, true, true},
		{"500 transient", http.StatusInternalServerError, true, true},
		{"404 permanent", http.StatusNotFound, true, false},
		{"403 permanent", http.StatusForbidden, true, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv := serveStatus(c.status, "body")
			defer srv.Close()
			_, retryable, err := httpFetchOnce(context.Background(), srv.URL)
			if (err != nil) != c.wantErr {
				t.Fatalf("err=%v, wantErr=%v", err, c.wantErr)
			}
			if retryable != c.wantRetryable {
				t.Errorf("retryable=%v, want %v", retryable, c.wantRetryable)
			}
		})
	}
}

// §3.9: a transport-level failure (dial refused / connection reset) must classify
// as retryable - this is the load-bearing branch for a SYN-dropped host under RU
// DPI, which the status-code cases above don't exercise.
func TestHTTPFetchOnce_TransportErrorRetryable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := srv.URL
	srv.Close() // port now closed -> dial is refused == a transport error
	_, retryable, err := httpFetchOnce(context.Background(), url)
	if err == nil {
		t.Fatal("expected a transport error against a closed server")
	}
	if !retryable {
		t.Error("a transport error must classify as retryable")
	}
}

// §3.9: HTTPFetch retries a transient failure and returns the body once the
// upstream recovers (the GitHub CDN flaps from RU).
func TestHTTPFetch_RetriesTransientThenSucceeds(t *testing.T) {
	fastBackoff(t)
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if atomic.AddInt32(&hits, 1) < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte("geo-bytes"))
	}))
	defer srv.Close()

	b, err := HTTPFetch(srv.URL)
	if err != nil {
		t.Fatalf("HTTPFetch after transient failures: %v", err)
	}
	if string(b) != "geo-bytes" {
		t.Errorf("body = %q, want geo-bytes", b)
	}
	if got := atomic.LoadInt32(&hits); got != 3 {
		t.Errorf("expected 3 attempts (2 retries), got %d", got)
	}
}

// §3.9: the shared total budget caps a blackholed host so HTTPFetch (called
// under the adapter's restartMu) can't block for attempts*per-attempt. Without
// the shared budget this would run ~3x30s; the budget caps it near-immediately.
func TestHTTPFetch_TotalBudgetCapsBlackhole(t *testing.T) {
	prevBackoff, prevBudget := fetchBackoffBase, fetchTotalBudget
	fetchBackoffBase, fetchTotalBudget = time.Millisecond, 100*time.Millisecond
	t.Cleanup(func() { fetchBackoffBase, fetchTotalBudget = prevBackoff, prevBudget })

	block := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		select {
		case <-block:
		case <-r.Context().Done(): // release when the client aborts (budget hit)
		}
	}))
	defer srv.Close()
	defer close(block)

	start := time.Now()
	if _, err := HTTPFetch(srv.URL); err == nil {
		t.Fatal("expected an error when the server never responds")
	}
	// Generous bound: the 100ms budget caps it; without a shared budget it would
	// be ~3*fetchTimeout (90s). 5s is nowhere near either flaky edge.
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("HTTPFetch took %v; total budget must cap it well below attempts*per-attempt", elapsed)
	}
}

// A permanent failure returns immediately without burning the retry budget.
func TestHTTPFetch_PermanentFailureDoesNotRetry(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	if _, err := HTTPFetch(srv.URL); err == nil {
		t.Fatal("expected error on 404")
	}
	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Errorf("404 should not retry, got %d attempts", got)
	}
}
