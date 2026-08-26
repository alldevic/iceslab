package core

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// DeriveSsPassword is written twice in this repository, in two languages: here,
// for the SS config the node writes, and in the panel
// (apps/panel-backend/src/lib/credentials.ts) for the key it puts in the
// client's subscription URI. Nothing tied the two together.
//
// A disagreement is invisible from either side. The push succeeds, the node
// reports healthy, and every shadowsocks user fails authentication because the
// key in their URI is not the key the node is listening with. It is the same
// shape as the panel↔node wire scar, except the value in question is a
// credential.
//
// The vectors live in packages/shared and the panel has a test that reads the
// same file, so a change on either side reddens on that side.

const vectorsRelPath = "../../../../packages/shared/testdata/ss-password-vectors.json"

type ssVector struct {
	UUID   string `json:"uuid"`
	Method string `json:"method"`
	Key    string `json:"key"`
}

func loadVectors(t *testing.T) []ssVector {
	t.Helper()
	path, err := filepath.Abs(vectorsRelPath)
	if err != nil {
		t.Fatalf("resolve %s: %v", vectorsRelPath, err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v - the shared vectors are the contract between this file and the panel", path, err)
	}
	var doc struct {
		Vectors []ssVector `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	if len(doc.Vectors) < 6 {
		t.Fatalf("only %d vectors in %s; the fixture is empty or the shape changed", len(doc.Vectors), path)
	}
	return doc.Vectors
}

func TestDeriveSsPasswordMatchesTheSharedVectors(t *testing.T) {
	for _, v := range loadVectors(t) {
		got := DeriveSsPassword(v.UUID, v.Method)
		if got != v.Key {
			t.Errorf("DeriveSsPassword(%q, %q) = %q, want %q - the panel puts the wanted value "+
				"in the client's URI, so every shadowsocks user on this node would fail to authenticate",
				v.UUID, v.Method, got, v.Key)
		}
	}
}

// SS2022 rejects a key of the wrong length outright, which is at least loud.
// The dangerous half is a key of the right length and the wrong bytes, which is
// what the vectors above are for.
func TestDeriveSsPasswordSizesTheKeyToTheCipher(t *testing.T) {
	const uuid = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"

	short, err := base64.StdEncoding.DecodeString(DeriveSsPassword(uuid, "2022-blake3-aes-128-gcm"))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(short) != 16 {
		t.Errorf("aes-128-gcm key is %d bytes, want 16", len(short))
	}

	for _, method := range []string{
		"2022-blake3-aes-256-gcm",
		"2022-blake3-chacha20-poly1305",
		"anything-else",
	} {
		long, err := base64.StdEncoding.DecodeString(DeriveSsPassword(uuid, method))
		if err != nil {
			t.Fatalf("decode %s: %v", method, err)
		}
		if len(long) != 32 {
			t.Errorf("%s key is %d bytes, want 32", method, len(long))
		}
	}
}

// Standard base64, not the URL alphabet. The panel derives three OTHER
// passwords with base64url, so the temptation to make all four consistent is
// real - and it would produce a string the shadowsocks core refuses.
func TestDeriveSsPasswordUsesStandardBase64(t *testing.T) {
	key := DeriveSsPassword("9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d", "2022-blake3-aes-128-gcm")
	if _, err := base64.StdEncoding.DecodeString(key); err != nil {
		t.Errorf("key %q is not standard base64: %v", key, err)
	}
	for _, c := range key {
		if c == '-' || c == '_' {
			t.Errorf("key %q uses the url alphabet; SS2022 wants standard base64", key)
			break
		}
	}
}

// The uuid is the only thing separating one user's key from another's.
func TestDeriveSsPasswordIsPerUser(t *testing.T) {
	const method = "2022-blake3-aes-256-gcm"
	seen := map[string]string{}
	for _, uuid := range []string{
		"9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
		"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
		"00000000-0000-4000-8000-000000000001",
	} {
		key := DeriveSsPassword(uuid, method)
		if other, dup := seen[key]; dup {
			t.Fatalf("%s and %s got the same key", uuid, other)
		}
		seen[key] = uuid
		if key != DeriveSsPassword(uuid, method) {
			t.Errorf("%s: not deterministic", uuid)
		}
	}
}
