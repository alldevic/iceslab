package amneziawg

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The obfuscation block is written twice, in two languages, for the two ends of
// the same tunnel: here for the SERVER config, and in the panel
// (core-adapters/amneziawg/wgconf.ts) for the client .conf the buyer imports.
// Both read the same pushed values, so the NUMBERS agree by construction. What
// does not agree by construction is which keys each side emits and how it
// spells them — and AmneziaWG hashes these parameters into the handshake, so a
// mismatch does not warn, does not log and does not fail a healthcheck. The
// tunnel simply never decrypts, for every user of that inbound.
//
// Measured before writing: this side was observed by NOTHING. Renaming `Jmin`
// to `JMin`, dropping the I1-I5 loop, and dropping S3/S4 each passed the whole
// Go suite in silence. (A fourth attempt was rejected by the compiler and
// therefore proved nothing; it was rewritten into a form that builds.)
//
// The vectors live in packages/shared and the panel reads the same file.

const obfVectorsRelPath = "../../../../../packages/shared/testdata/awg-obfuscation-vectors.json"

type obfVector struct {
	Name   string `json:"name"`
	Params struct {
		Jc, Jmin, Jmax     int
		S1, S2, S3, S4     int
		H1, H2, H3, H4     uint32
		I1, I2, I3, I4, I5 string
	} `json:"params"`
	Server []string `json:"server"`
}

func loadObfVectors(t *testing.T) []obfVector {
	t.Helper()
	path, err := filepath.Abs(obfVectorsRelPath)
	if err != nil {
		t.Fatalf("resolve %s: %v", obfVectorsRelPath, err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v - the shared vectors are the contract between this file and the panel", path, err)
	}
	var doc struct {
		Vectors []obfVector `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	// The control: an empty or reshaped fixture would make the comparison below
	// pass by having nothing to compare.
	if len(doc.Vectors) < 2 {
		t.Fatalf("only %d vector(s) in %s; the fixture is empty or the shape changed", len(doc.Vectors), path)
	}
	for _, v := range doc.Vectors {
		if len(v.Server) < 11 {
			t.Fatalf("vector %q lists only %d server line(s); an AWG interface has at least 11", v.Name, len(v.Server))
		}
	}
	return doc.Vectors
}

func TestRenderObfuscationMatchesTheSharedVectors(t *testing.T) {
	for _, v := range loadObfVectors(t) {
		cfg := InboundConfig{
			Jc: v.Params.Jc, Jmin: v.Params.Jmin, Jmax: v.Params.Jmax,
			S1: v.Params.S1, S2: v.Params.S2, S3: v.Params.S3, S4: v.Params.S4,
			H1: v.Params.H1, H2: v.Params.H2, H3: v.Params.H3, H4: v.Params.H4,
			I1: v.Params.I1, I2: v.Params.I2, I3: v.Params.I3, I4: v.Params.I4, I5: v.Params.I5,
		}
		var b strings.Builder
		renderObfuscation(&b, cfg)

		got := strings.Split(strings.TrimRight(b.String(), "\n"), "\n")
		if len(got) != len(v.Server) {
			t.Errorf("%s: rendered %d line(s), the contract says %d\n got: %v\nwant: %v",
				v.Name, len(got), len(v.Server), got, v.Server)
			continue
		}
		for i := range got {
			if got[i] != v.Server[i] {
				t.Errorf("%s: line %d is %q, the contract says %q - the client half of this "+
					"tunnel is built from the same contract, and AmneziaWG hashes these into "+
					"the handshake, so a mismatch is a tunnel that never decrypts",
					v.Name, i+1, got[i], v.Server[i])
			}
		}
	}
}

// S3/S4 are the one deliberate difference between the two sides: the server
// emits them always, the client omits them at zero (AmneziaVPN iOS cannot
// parse the keys at all). Pinned on this side so that "always" stays a
// decision rather than something a later edit quietly drops — the fixture's
// first vector is the zero case precisely because it is the one that differs.
func TestRenderObfuscationEmitsZeroS3S4(t *testing.T) {
	var b strings.Builder
	renderObfuscation(&b, InboundConfig{Jc: 1, Jmin: 2, Jmax: 3, S1: 4, S2: 5})
	out := b.String()
	for _, want := range []string{"S3 = 0", "S4 = 0"} {
		if !strings.Contains(out, want) {
			t.Errorf("server config omits %q; the client omits it on purpose, this side must not", want)
		}
	}
}
