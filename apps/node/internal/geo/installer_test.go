package geo

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func sha(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func TestEnsure_DownloadsVerifiesAndWrites(t *testing.T) {
	dir := t.TempDir()
	body := []byte("geosite-custom-payload")
	fetch := func(url string) ([]byte, error) {
		if url != "https://p/geo-custom.dat" {
			t.Fatalf("unexpected url %q", url)
		}
		return body, nil
	}
	res, err := Ensure(dir, []Asset{{Name: "geo-custom.dat", URL: "https://p/geo-custom.dat", SHA256: sha(body)}}, fetch)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Errors) != 0 {
		t.Fatalf("unexpected errors: %v", res.Errors)
	}
	if len(res.Installed) != 1 || res.Installed[0] != "geo-custom.dat" {
		t.Fatalf("want installed [geo-custom.dat], got %v", res.Installed)
	}
	got, _ := os.ReadFile(filepath.Join(dir, "geo-custom.dat"))
	if string(got) != string(body) {
		t.Fatalf("file content mismatch")
	}
}

func TestEnsure_SkipsWhenAlreadyCorrect(t *testing.T) {
	dir := t.TempDir()
	body := []byte("already-here")
	if err := os.WriteFile(filepath.Join(dir, "geo.dat"), body, 0o644); err != nil {
		t.Fatal(err)
	}
	called := false
	fetch := func(string) ([]byte, error) { called = true; return nil, nil }
	res, _ := Ensure(dir, []Asset{{Name: "geo.dat", URL: "https://p/x", SHA256: sha(body)}}, fetch)
	if called {
		t.Fatal("fetch should not be called when the file already matches")
	}
	if len(res.Skipped) != 1 {
		t.Fatalf("want 1 skipped, got %v", res.Skipped)
	}
}

func TestEnsure_ShaMismatchKeepsLastGood(t *testing.T) {
	dir := t.TempDir()
	good := []byte("good-v1")
	path := filepath.Join(dir, "geo.dat")
	if err := os.WriteFile(path, good, 0o644); err != nil {
		t.Fatal(err)
	}
	// Panel advertises v2's sha, but the geo host serves corrupt bytes.
	fetch := func(string) ([]byte, error) { return []byte("corrupt"), nil }
	res, _ := Ensure(dir, []Asset{{Name: "geo.dat", URL: "https://p/x", SHA256: sha([]byte("good-v2"))}}, fetch)
	if _, bad := res.Errors["geo.dat"]; !bad {
		t.Fatal("want a sha-mismatch error")
	}
	// last-good file preserved
	got, _ := os.ReadFile(path)
	if string(got) != string(good) {
		t.Fatalf("last-good file was clobbered: %q", got)
	}
}

func TestEnsure_FetchErrorIsSoftAndPreservesFile(t *testing.T) {
	dir := t.TempDir()
	good := []byte("good")
	path := filepath.Join(dir, "geo.dat")
	os.WriteFile(path, good, 0o644)
	fetch := func(string) ([]byte, error) { return nil, os.ErrDeadlineExceeded }
	res, err := Ensure(dir, []Asset{{Name: "geo.dat", URL: "https://p/x", SHA256: sha([]byte("new"))}}, fetch)
	if err != nil {
		t.Fatalf("Ensure should not hard-fail on a per-asset fetch error: %v", err)
	}
	if _, bad := res.Errors["geo.dat"]; !bad {
		t.Fatal("want a fetch error recorded")
	}
	if got, _ := os.ReadFile(path); string(got) != "good" {
		t.Fatal("existing file must survive a failed fetch")
	}
}

func TestEnsure_RejectsUnsafeNamesAndBadSha(t *testing.T) {
	dir := t.TempDir()
	fetch := func(string) ([]byte, error) { t.Fatal("must not fetch"); return nil, nil }
	res, _ := Ensure(dir, []Asset{
		{Name: "../evil.dat", URL: "https://p/x", SHA256: sha([]byte("y"))},
		{Name: "sub/dir.dat", URL: "https://p/x", SHA256: sha([]byte("y"))},
		{Name: "ok.dat", URL: "https://p/x", SHA256: "not-hex"},
	}, fetch)
	for _, n := range []string{"../evil.dat", "sub/dir.dat", "ok.dat"} {
		if _, bad := res.Errors[n]; !bad {
			t.Fatalf("want error for %q", n)
		}
	}
}

func TestEnsure_ReinstallsOnShaChange(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "geo.dat")
	os.WriteFile(path, []byte("v1"), 0o644)
	v2 := []byte("v2-bigger-content")
	fetch := func(string) ([]byte, error) { return v2, nil }
	res, _ := Ensure(dir, []Asset{{Name: "geo.dat", URL: "https://p/x", SHA256: sha(v2)}}, fetch)
	if len(res.Installed) != 1 {
		t.Fatalf("want reinstall, got %v", res)
	}
	if got, _ := os.ReadFile(path); string(got) != string(v2) {
		t.Fatal("file not updated to v2")
	}
}
