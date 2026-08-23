package xray

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"

	geopkg "github.com/icecompany-tech/iceslab/apps/node/internal/geo"
)

// GeoAssetSpec is one panel-pushed geo database to install on the node (mirrored
// in the CascadeFragments JSON). The panel computes the sha256 at build time so
// the node's integrity check is anchored to the trusted panel, not the geo host.
type GeoAssetSpec struct {
	Name   string `json:"name"`
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
}

func toGeoAssets(specs []GeoAssetSpec) []geopkg.Asset {
	out := make([]geopkg.Asset, 0, len(specs))
	for _, s := range specs {
		out = append(out, geopkg.Asset{Name: s.Name, URL: s.URL, SHA256: s.SHA256})
	}
	return out
}

func geoAssetsEqual(a, b []GeoAssetSpec) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// ext:<file>:<tag> geo-database references in a rendered xray config. A matcher
// is always a whole JSON string (`"ext:file.dat:cat"`), so anchor on the opening
// quote - a bare substring match would false-positive on values that merely
// contain "ext:" (e.g. a literal domain matcher "context:x:").
var extRef = regexp.MustCompile(`"ext:([A-Za-z0-9._-]+):`)

// verifyExtAssets ensures every `ext:<file>:` matcher in the rendered config has
// its <file> installed THIS round with the exact sha the panel pushed (present
// in `installed`) AND on disk. xray refuses to start if a referenced ext file is
// missing OR its content doesn't carry the referenced list, so the caller checks
// this BEFORE stopping the running xray and skips the restart on a miss - the old
// instance keeps serving. Requiring `installed` (not just os.Stat) catches a
// stale file: a failed/CDN-stale re-fetch leaves the PREVIOUS .dat on disk,
// which exists but may lack the newly-referenced category and would crash xray.
func verifyExtAssets(blob []byte, dir string, installed map[string]bool) error {
	seen := map[string]bool{}
	for _, m := range extRef.FindAllSubmatch(blob, -1) {
		name := string(m[1])
		if seen[name] {
			continue
		}
		seen[name] = true
		if dir == "" {
			return fmt.Errorf("config references ext:%s but no geo asset dir is configured", name)
		}
		if !installed[name] {
			return fmt.Errorf("geo asset %q referenced by config was not installed with the expected sha this round", name)
		}
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			return fmt.Errorf("geo asset %q referenced by config is missing: %w", name, err)
		}
	}
	return nil
}
