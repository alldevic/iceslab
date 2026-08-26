package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
)

// Which proto ufw opens for an inbound is decided twice in this repository, in
// two languages: here, where the node actually opens the port, and in the
// panel (nodes.exposure.ts, protosForProtocol) where it decides which allowed
// ports it EXPECTS to see. The panel's own comment said it mirrors this
// function, and a comment is not a check.
//
// Divergence is quiet in both directions. A proto this node opens and the
// panel does not expect is reported to the operator as a stray port on an
// otherwise clean node — the exact noise the exposure feature exists to
// remove. A proto the panel expects and this node never opens hides a real
// one. Neither shows up as an error anywhere.
//
// The vectors live in packages/shared and the panel has a test reading the
// same file, so a change on either side reddens on that side.

const protoVectorsRelPath = "../../../../packages/shared/testdata/inbound-proto-vectors.json"

type protoVector struct {
	Protocol string   `json:"protocol"`
	Protos   []string `json:"protos"`
}

func loadProtoVectors(t *testing.T) []protoVector {
	t.Helper()
	path, err := filepath.Abs(protoVectorsRelPath)
	if err != nil {
		t.Fatalf("resolve %s: %v", protoVectorsRelPath, err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v - the shared vectors are the contract between this file and the panel", path, err)
	}
	var doc struct {
		Vectors []protoVector `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	// The control: an empty or reshaped fixture would make every comparison
	// below pass by having nothing to compare.
	if len(doc.Vectors) < 11 {
		t.Fatalf("only %d vectors in %s; the fixture is empty or the shape changed", len(doc.Vectors), path)
	}
	return doc.Vectors
}

func TestProtoForInboundMatchesTheSharedVectors(t *testing.T) {
	for _, v := range loadProtoVectors(t) {
		if len(v.Protos) == 0 {
			t.Errorf("%s: the fixture lists no proto at all", v.Protocol)
			continue
		}
		got := protoForInbound(dto.ProtocolName(v.Protocol))
		want := append([]string(nil), v.Protos...)
		sort.Strings(got)
		sort.Strings(want)
		if len(got) != len(want) {
			t.Errorf("protoForInbound(%q) = %v, want %v - the panel reports the difference "+
				"to the operator as an unexpected open port", v.Protocol, got, want)
			continue
		}
		for i := range got {
			if got[i] != want[i] {
				t.Errorf("protoForInbound(%q) = %v, want %v", v.Protocol, got, want)
				break
			}
		}
	}
}

// The default arm is a deliberate policy — an unknown protocol gets TCP rather
// than nothing — and it is what makes a protocol added on one side only fail
// silently instead of loudly. Pinned so that changing it is a choice.
func TestProtoForInboundDefaultsToTCP(t *testing.T) {
	got := protoForInbound(dto.ProtocolName("something-invented-tomorrow"))
	if len(got) != 1 || got[0] != "tcp" {
		t.Errorf("unknown protocol got %v, want [tcp]", got)
	}
}
