package xray

import (
	"os"
	"path/filepath"
	"testing"
)

func TestVerifyExtAssets(t *testing.T) {
	dir := t.TempDir()
	// present asset
	if err := os.WriteFile(filepath.Join(dir, "geo-custom.dat"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	installed := map[string]bool{"geo-custom.dat": true}

	// config with no ext: refs -> always ok, even with no dir / no installs
	if err := verifyExtAssets([]byte(`{"domain":["geosite:youtube"]}`), "", nil); err != nil {
		t.Fatalf("standard-only config should pass: %v", err)
	}

	// ext: ref installed this round AND present on disk -> ok
	blob := []byte(`{"domain":["ext:geo-custom.dat:my-block","geosite:category-ru"]}`)
	if err := verifyExtAssets(blob, dir, installed); err != nil {
		t.Fatalf("installed+present ext file should pass: %v", err)
	}

	// ext: ref present on disk but NOT installed this round (stale/failed fetch)
	// -> error, even though os.Stat would succeed
	if err := verifyExtAssets(blob, dir, map[string]bool{}); err == nil {
		t.Fatal("ext file not installed this round must fail (stale-content guard)")
	}

	// ext: ref installed but missing on disk -> error
	missing := []byte(`{"domain":["ext:absent.dat:x"]}`)
	if err := verifyExtAssets(missing, dir, map[string]bool{"absent.dat": true}); err == nil {
		t.Fatal("missing ext file must fail the precondition")
	}

	// ext: ref but no dir configured -> error
	if err := verifyExtAssets(blob, "", installed); err == nil {
		t.Fatal("ext ref with no asset dir must fail")
	}

	// a value merely CONTAINING "ext:" mid-string is not an ext ref
	if err := verifyExtAssets([]byte(`{"domain":["context:absent.dat:x"]}`), dir, nil); err != nil {
		t.Fatalf("substring ext: must not be treated as a ref: %v", err)
	}
}

func TestGeoAssetsEqual(t *testing.T) {
	a := []GeoAssetSpec{{Name: "geo-custom.dat", URL: "u", SHA256: "s"}}
	b := []GeoAssetSpec{{Name: "geo-custom.dat", URL: "u", SHA256: "s"}}
	if !geoAssetsEqual(a, b) {
		t.Fatal("identical specs should be equal")
	}
	if geoAssetsEqual(a, []GeoAssetSpec{{Name: "geo-custom.dat", URL: "u", SHA256: "DIFFERENT"}}) {
		t.Fatal("a sha change must not compare equal (triggers re-render)")
	}
	if geoAssetsEqual(a, nil) {
		t.Fatal("different lengths must not be equal")
	}
}

func TestToGeoAssets(t *testing.T) {
	got := toGeoAssets([]GeoAssetSpec{{Name: "n", URL: "u", SHA256: "s"}})
	if len(got) != 1 || got[0].Name != "n" || got[0].URL != "u" || got[0].SHA256 != "s" {
		t.Fatalf("mapping wrong: %+v", got)
	}
}
