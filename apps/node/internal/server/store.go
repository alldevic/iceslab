package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/icecompany-tech/iceslab/apps/node/internal/atomicfile"
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
	var out dto.ApplyInboundsRequest
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
// one. See acceptedPush.
func (s *Server) persistAccepted(req dto.ApplyInboundsRequest, o pushOutcome) error {
	s.storeMu.Lock()
	defer s.storeMu.Unlock()
	// No store yet, or one this agent cannot read: nothing to fall back to, so
	// a refused part is simply not stored.
	prev, _ := readPushStore(s.cfg.InboundsStorePath)
	return writePushStore(s.cfg.InboundsStorePath, acceptedPush(prev, req, o))
}

/*
acceptedPush is the push as the cores took it: what a restart has to come up on.

A part a core refused is left running its previous version (xray keeps the
running config, A-130; the chain process keeps its old process), so the store
keeps that previous version too, out of the push it was in before. A refused
inbound that had no previous version is not stored at all. A refused policy or
resolver keeps the stored one the same way. Everything else is the new push:
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
	if o.policyRefused {
		out.Policy = prev.Policy
	}
	if o.dnsRefused {
		out.Dns = prev.Dns
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
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", dir, err)
	}
	body, err := json.MarshalIndent(req, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	return atomicfile.Write(path, body, 0o600)
}
