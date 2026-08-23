// Package geo installs panel-managed geo databases (geosite.dat / geoip.dat and
// composed ext: custom .dat files) into xray's asset directory. The panel pushes
// a spec {name, url, sha256}; the node downloads, verifies the sha256 the panel
// computed at build time (integrity anchored to the trusted panel, not the geo
// host), and atomically swaps the file in. A file already matching its sha256 is
// left untouched (no fetch). Failures are soft: the last-good file stays and the
// error is reported, so a geo-host hiccup never takes routing down (xray keeps
// serving the previous / bundled databases).
package geo

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Asset is one geo file to place in the asset dir.
type Asset struct {
	// Name is the bare filename (e.g. "geo-custom.dat"). No path separators.
	Name string
	URL  string
	// SHA256 is the lowercase hex digest the panel computed for the artifact.
	SHA256 string
}

// Fetcher downloads a URL's bytes. Injected so the installer is testable and the
// HTTP policy (timeout, size cap) lives at the call site.
type Fetcher func(url string) ([]byte, error)

var (
	safeName = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)
	hexSha   = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// Result reports what Ensure did.
type Result struct {
	// Installed are assets that were (re)written this call.
	Installed []string
	// Skipped are assets already present with the right sha256 (no fetch).
	Skipped []string
	// Errors keys each failed asset name to its error (fetch/sha/write); the
	// on-disk file for a failed asset is left as it was (last-good).
	Errors map[string]error
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// fileSha returns the sha256 of a file, or "" if it is missing/unreadable.
func fileSha(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return sha256Hex(b)
}

// Ensure makes each asset present in dir with the expected sha256. It never
// touches files not listed (bundled geosite.dat/geoip.dat stay), and is
// fail-soft per asset. The returned error is non-nil only for a dir-level
// failure (e.g. the asset dir cannot be created).
func Ensure(dir string, assets []Asset, fetch Fetcher) (Result, error) {
	res := Result{Errors: map[string]error{}}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return res, fmt.Errorf("geo: mkdir asset dir: %w", err)
	}
	for _, a := range assets {
		skipped, err := ensureOne(dir, a, fetch)
		switch {
		case err != nil:
			res.Errors[a.Name] = err
		case skipped:
			res.Skipped = append(res.Skipped, a.Name)
		default:
			res.Installed = append(res.Installed, a.Name)
		}
	}
	return res, nil
}

func ensureOne(dir string, a Asset, fetch Fetcher) (skipped bool, err error) {
	if !safeName.MatchString(a.Name) || strings.Contains(a.Name, "..") {
		return false, fmt.Errorf("unsafe asset name %q", a.Name)
	}
	want := strings.ToLower(a.SHA256)
	if !hexSha.MatchString(want) {
		return false, fmt.Errorf("bad sha256 %q", a.SHA256)
	}
	path := filepath.Join(dir, a.Name)

	if fileSha(path) == want {
		return true, nil // already correct; no fetch
	}

	body, err := fetch(a.URL)
	if err != nil {
		return false, fmt.Errorf("fetch: %w", err)
	}
	if got := sha256Hex(body); got != want {
		return false, fmt.Errorf("sha256 mismatch: got %s want %s", got, want)
	}

	// Atomic swap: write a temp file in the same dir, then rename over the
	// target (rename is atomic within a filesystem, so a concurrent xray read
	// sees either the whole old file or the whole new one).
	tmp, err := os.CreateTemp(dir, a.Name+".*.tmp")
	if err != nil {
		return false, fmt.Errorf("temp: %w", err)
	}
	tmpName := tmp.Name()
	if _, werr := tmp.Write(body); werr != nil {
		tmp.Close()
		os.Remove(tmpName)
		return false, fmt.Errorf("write: %w", werr)
	}
	// fsync the bytes before the rename so a crash right after can't leave the
	// target present-but-empty/partial (rename is atomic for the name, not for
	// the data). verifyExtAssets only checks that the file EXISTS, so a
	// zero-length survivor would otherwise pass the precondition and crash xray.
	if serr := tmp.Sync(); serr != nil {
		tmp.Close()
		os.Remove(tmpName)
		return false, fmt.Errorf("sync: %w", serr)
	}
	if cerr := tmp.Close(); cerr != nil {
		os.Remove(tmpName)
		return false, fmt.Errorf("close: %w", cerr)
	}
	if rerr := os.Rename(tmpName, path); rerr != nil {
		os.Remove(tmpName)
		return false, fmt.Errorf("rename: %w", rerr)
	}
	return false, nil
}
