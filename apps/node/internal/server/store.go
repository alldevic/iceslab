package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/icecompany-tech/iceslab/apps/node/internal/atomicfile"
	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
)

// The last push, kept on disk so a node-agent restart does not need the panel.
//
// It used to hold the inbound ARRAY alone, and only the firewall ever read it
// back. Everything else, the cores included, started from nothing: on 2026-09-22
// four agents were restarted, the old process stopped xray cleanly, the new one
// logged "no REALITY key yet, waiting for ApplyInbound from panel" and sat
// there. Two of the four were cascade entries whose push the panel could not
// build (a direction pointed at a deleted node), so nothing ever came, and they
// served nobody for over an hour with `pgrep xray` empty.
//
// So the WHOLE request is stored now, not just the inbounds. Storing only the
// inbounds would have restored the listeners and silently dropped the node's
// routing policy and its resolver, which is the same class of quiet wrong the
// restore exists to end.
//
// ⚠ The old shape is still read: a file written by an agent before this change
// is a bare JSON array. Refusing it would mean a node that restarts during the
// rollout restores nothing, which is exactly the situation being fixed.
func readPushStore(path string) (dto.ApplyInboundsRequest, error) {
	st, err := readStored(path)
	return st.ApplyInboundsRequest, err
}

// storeFile is the file: the push as the cores took it, plus the policy and
// resolver of each core that kept an older one (A-185). Agent-local, not the
// contract: the wire never carries the two maps.
type storeFile struct {
	dto.ApplyInboundsRequest
	// By coreKey: the block a core runs on when it refused the push's one.
	// A JSON null is "none", which is what it ran before it had one.
	PolicyByCore map[string]json.RawMessage `json:"policyByCore,omitempty"`
	DnsByCore    map[string]json.RawMessage `json:"dnsByCore,omitempty"`
}

// coreKey names a core in the stored maps: the protocol and the engine, which
// together tell the registered adapters apart.
func coreKey(adapter core.CoreAdapter) string {
	return adapter.Name() + "@" + adapter.Engine()
}

func readStored(path string) (storeFile, error) {
	var out storeFile
	body, err := os.ReadFile(path)
	if err != nil {
		return out, err
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return out, fmt.Errorf("empty store")
	}
	if trimmed[0] == '[' {
		// Legacy: the array of inbounds, with no node-level blocks. They stay
		// zero, which is what the node did before those blocks existed.
		var inbounds []dto.InboundDto
		if err := json.Unmarshal(trimmed, &inbounds); err != nil {
			return out, fmt.Errorf("parse legacy inbound array: %w", err)
		}
		out.Inbounds = inbounds
		return out, nil
	}
	if err := json.Unmarshal(trimmed, &out); err != nil {
		return out, fmt.Errorf("parse push store: %w", err)
	}
	return out, nil
}

// persistAccepted writes what the cores took from this push over the stored
// one (see acceptedPush), and says the inbounds the cores ran before it and
// run after it, for the firewall (closeDroppedPorts).
func (s *Server) persistAccepted(req dto.ApplyInboundsRequest, o pushOutcome) (before, after []dto.InboundDto, err error) {
	s.storeMu.Lock()
	defer s.storeMu.Unlock()
	// No store yet, or one this agent cannot read: nothing to fall back to, so
	// a refused part is simply not stored.
	prev, _ := readStored(s.cfg.InboundsStorePath)
	out := storeFile{ApplyInboundsRequest: acceptedPush(prev.ApplyInboundsRequest, req, o)}
	out.Policy, out.PolicyByCore = acceptedBlock(prev.Policy, prev.PolicyByCore, req.Policy, o.policyRefusedBy, o.policyTaken)
	out.Dns, out.DnsByCore = acceptedBlock(prev.Dns, prev.DnsByCore, req.Dns, o.dnsRefusedBy, o.dnsTaken)
	if err := writeStored(s.cfg.InboundsStorePath, out); err != nil {
		return nil, nil, err
	}
	return prev.Inbounds, out.Inbounds, nil
}

/*
acceptedBlock is a node-level block (policy or resolver) as the cores took it,
core by core (A-185, 22.10). It was one flag for all: one core refusing put the
previous block in the store for every core, and a restart took the new one
away from the core that had accepted it.

  - nobody refused: the push's block, no exceptions;
  - nobody took it (every core that renders it refused): the stored block and
    the stored exceptions stay as they were;
  - some took it: the push's block, and each core that refused keeps, as an
    exception, the block it ran before (its own exception, or the stored one).
*/
func acceptedBlock(prev json.RawMessage, prevBy map[string]json.RawMessage, pushed json.RawMessage,
	refusedBy map[string]bool, taken bool) (json.RawMessage, map[string]json.RawMessage) {
	if len(refusedBy) == 0 {
		return pushed, nil
	}
	if !taken {
		return prev, prevBy
	}
	by := make(map[string]json.RawMessage, len(refusedBy))
	for key := range refusedBy {
		if old, ok := prevBy[key]; ok {
			by[key] = old
		} else {
			by[key] = prev
		}
	}
	return pushed, by
}

// blockFor is the block a core is given on a restore: its exception, or the
// stored one. A stored null is no block.
func blockFor(key string, stored json.RawMessage, by map[string]json.RawMessage) json.RawMessage {
	b, ok := by[key]
	if !ok {
		return stored
	}
	if bytes.Equal(bytes.TrimSpace(b), []byte("null")) {
		return nil
	}
	return b
}

/*
acceptedPush is the push as the cores took it: what a restart has to come up on.

A part a core refused is left running its previous version (xray keeps the
running config, A-130; the chain process keeps its old process), so the store
keeps that previous version too, out of the push it was in before. A refused
inbound that had no previous version is not stored at all. The policy and the
resolver go core by core, see acceptedBlock. Everything else is the new push:
the parts that applied, the deletions it made, and the node-level blocks the
cores took.

A-113, 22.10: the push was stored whole before it was applied, and a restart
brought up exactly the version the cores had refused, on a node that was
serving fine on the one before it.
*/
func acceptedPush(prev, req dto.ApplyInboundsRequest, o pushOutcome) dto.ApplyInboundsRequest {
	out := req
	prevByID := make(map[string]dto.InboundDto, len(prev.Inbounds))
	for _, ib := range prev.Inbounds {
		if ib.ID != "" {
			prevByID[ib.ID] = ib
		}
	}
	out.Inbounds = make([]dto.InboundDto, 0, len(req.Inbounds))
	for i, ib := range req.Inbounds {
		if !o.refused[i] {
			out.Inbounds = append(out.Inbounds, ib)
			continue
		}
		if old, ok := prevByID[ib.ID]; ok && ib.ID != "" {
			out.Inbounds = append(out.Inbounds, old)
		}
	}
	switch {
	case o.chainRefused:
		// What the chain runs on and the cores were drawn to, so a restart
		// rebuilds that same pair.
		out.Chain = o.chainInForce
	case o.userCoreRefused && req.Chain != nil:
		// The chain process took the new block; the cores were told nothing and
		// kept the hand-off they had.
		c := *req.Chain
		c.UserCore = nil
		if prev.Chain != nil {
			c.UserCore = prev.Chain.UserCore
		}
		out.Chain = &c
	}
	return out
}

// writePushStore persists the whole push atomically (fsync(file)+fsync(dir)).
//
// Mode 0600 because the configs embed REALITY private keys, WireGuard server
// keys and the cascade's link credentials.
func writePushStore(path string, req dto.ApplyInboundsRequest) error {
	return writeStored(path, storeFile{ApplyInboundsRequest: req})
}

func writeStored(path string, st storeFile) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", dir, err)
	}
	body, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	return atomicfile.Write(path, body, 0o600)
}
