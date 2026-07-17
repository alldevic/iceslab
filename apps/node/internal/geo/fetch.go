package geo

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"time"
)

// maxDatBytes caps a downloaded geo database (geoip.dat runs ~20MB; the cap is
// generous but bounds a hostile/huge response).
const maxDatBytes = 128 << 20

// HTTPFetch is the default Fetcher: GET the URL, cap the body, return the bytes.
// Integrity (sha256) is verified by the installer against the panel-provided
// digest, so this does no verification of its own.
func HTTPFetch(url string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("geo fetch %s: HTTP %d", url, resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxDatBytes+1))
	if err != nil {
		return nil, err
	}
	if len(b) > maxDatBytes {
		return nil, fmt.Errorf("geo fetch %s: body exceeds %d bytes", url, maxDatBytes)
	}
	return b, nil
}
