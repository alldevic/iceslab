package xray

import (
	"encoding/json"
	"io"
	"log/slog"
	"path/filepath"
	"testing"
)

// Multi-inbound: the panel pushes inbounds one call at a time, and the adapter
// has to ACCUMULATE them. Before this it kept a single one, so the second push
// silently replaced the first and its users simply stopped being served.

func multiAdapter(t *testing.T) *Adapter {
	t.Helper()
	dir := t.TempDir()
	return New(Config{
		ConfigPath: filepath.Join(dir, "config.json"), // config-only mode: no binary
		Inbound:    validInbound(),
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func inboundWire(t *testing.T, id string, port int) []byte {
	t.Helper()
	return []byte(`{
		"inboundId": "` + id + `",
		"realityDest": "www.cloudflare.com:443",
		"realityServerNames": ["www.cloudflare.com"],
		"realityPrivateKey": "aGVsbG8td29ybGQtdGhpcy1pcy1hLWZha2Uta2V5MDA",
		"realityShortIds": ["0123456789abcdef"]
	}`)
}

func renderedInbounds(t *testing.T, a *Adapter) []map[string]any {
	t.Helper()
	blob, err := renderMultiConfig(currentInbounds(a), sortedClients(a.users), a.cascade)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	var cfg struct {
		Inbounds []map[string]any `json:"inbounds"`
	}
	if err := json.Unmarshal(blob, &cfg); err != nil {
		t.Fatalf("unmarshal rendered config: %v", err)
	}
	return cfg.Inbounds
}

// currentInbounds mirrors what regenerateAndRestart feeds the renderer.
func currentInbounds(a *Adapter) []InboundConfig {
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.inbounds) == 0 {
		return []InboundConfig{a.cfg.Inbound}
	}
	out := make([]InboundConfig, 0, len(a.inbounds))
	for _, id := range sortedKeys(a.inbounds) {
		out = append(out, a.inbounds[id])
	}
	return out
}

func sortedKeys(m map[string]InboundConfig) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	// insertion sort: the map is tiny and this avoids importing sort here
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	return keys
}

// The whole point: a second inbound must not evict the first.
func TestSecondInboundIsHeldAlongsideTheFirst(t *testing.T) {
	a := multiAdapter(t)
	if err := a.ApplyInbound(443, inboundWire(t, "aaaaaaaa-1111-4000-8000-000000000001", 443)); err != nil {
		t.Fatalf("first ApplyInbound: %v", err)
	}
	if err := a.ApplyInbound(8443, inboundWire(t, "bbbbbbbb-2222-4000-8000-000000000002", 8443)); err != nil {
		t.Fatalf("second ApplyInbound: %v", err)
	}

	a.mu.Lock()
	held := len(a.inbounds)
	a.mu.Unlock()
	if held != 2 {
		t.Fatalf("adapter holds %d inbounds, want 2 (the second replaced the first)", held)
	}

	ins := renderedInbounds(t, a)
	// Two user inbounds plus the management one.
	if len(ins) != 3 {
		t.Fatalf("rendered %d inbounds, want 3 (two user + api)", len(ins))
	}
}

// Tags must be unique, because xray rejects the WHOLE config on a clash - the
// node would lose every inbound, not just the duplicate.
func TestEachInboundGetsItsOwnTag(t *testing.T) {
	a := multiAdapter(t)
	_ = a.ApplyInbound(443, inboundWire(t, "aaaaaaaa-1111-4000-8000-000000000001", 443))
	_ = a.ApplyInbound(8443, inboundWire(t, "bbbbbbbb-2222-4000-8000-000000000002", 8443))

	seen := map[string]bool{}
	for _, in := range renderedInbounds(t, a) {
		tag, _ := in["tag"].(string)
		if seen[tag] {
			t.Fatalf("duplicate inbound tag %q: xray would refuse the entire config", tag)
		}
		seen[tag] = true
	}
}

// A tag is derived from the inbound id and must not drift between pushes:
// traffic counters carry it, so a changed tag reads as a new inbound and zeroes
// this node's accounting for those users.
func TestInboundTagIsStableAcrossPushes(t *testing.T) {
	id := "aaaaaaaa-1111-4000-8000-000000000001"
	first := inboundTagFor(id, "vless-in")
	second := inboundTagFor(id, "vless-in")
	if first != second {
		t.Fatalf("tag drifted between calls: %q vs %q", first, second)
	}
	if other := inboundTagFor("bbbbbbbb-2222-4000-8000-000000000002", "vless-in"); other == first {
		t.Fatalf("two different inbounds derived the same tag %q", first)
	}
}

// Two inbounds on one port is a configuration error worth naming: xray would
// otherwise reject the whole file with a parser message that points nowhere.
func TestPortClashIsRefusedByName(t *testing.T) {
	a := multiAdapter(t)
	_ = a.ApplyInbound(443, inboundWire(t, "aaaaaaaa-1111-4000-8000-000000000001", 443))
	_ = a.ApplyInbound(443, inboundWire(t, "bbbbbbbb-2222-4000-8000-000000000002", 443))

	_, err := renderMultiConfig(currentInbounds(a), nil, nil)
	if err == nil {
		t.Fatal("expected a port clash to be refused")
	}
}

// An older panel sends no id; that path must behave exactly as before.
func TestUnidentifiedInboundKeepsLegacyBehaviour(t *testing.T) {
	a := multiAdapter(t)
	wire := []byte(`{
		"realityDest": "www.cloudflare.com:443",
		"realityServerNames": ["www.cloudflare.com"],
		"realityPrivateKey": "aGVsbG8td29ybGQtdGhpcy1pcy1hLWZha2Uta2V5MDA",
		"realityShortIds": ["0123456789abcdef"]
	}`)
	if err := a.ApplyInbound(443, wire); err != nil {
		t.Fatalf("ApplyInbound: %v", err)
	}
	a.mu.Lock()
	held := len(a.inbounds)
	tag := a.cfg.Inbound.Tag
	a.mu.Unlock()
	if held != 0 {
		t.Fatalf("unidentified inbound went into the map (%d entries); it must stay the single legacy one", held)
	}
	if tag != validInbound().Tag {
		t.Fatalf("legacy inbound tag changed to %q", tag)
	}
}
