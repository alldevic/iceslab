package server

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"

	"github.com/icecompany-tech/iceslab/apps/node/internal/atomicfile"
	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
)

// chainFwRule is one ufw rule opened for a chain's link port. Src "" is the
// rule open to anyone, which a leg gets when no name of its previous hop
// resolved (firewall.AllowFrom's fail-open, kept on purpose: a closed link
// port silently breaks the cascade, and the leg is still key-gated).
type chainFwRule struct {
	Port  int    `json:"port"`
	Proto string `json:"proto"`
	Src   string `json:"src,omitempty"`
}

// chainFwFile is where the rules opened for the block in force are kept,
// beside the stored push. Without it a restart would not know what the last
// process opened, and could close nothing.
func (s *Server) chainFwFile() string {
	if s.cfg.InboundsStorePath == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(s.cfg.InboundsStorePath), "chain-firewall.json")
}

func (s *Server) loadChainFw() map[chainFwRule]bool {
	out := map[chainFwRule]bool{}
	path := s.chainFwFile()
	if path == "" {
		return out
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	var rules []chainFwRule
	if json.Unmarshal(body, &rules) == nil {
		for _, r := range rules {
			out[r] = true
		}
	}
	return out
}

func (s *Server) saveChainFw(rules map[chainFwRule]bool) {
	path := s.chainFwFile()
	if path == "" {
		return
	}
	list := make([]chainFwRule, 0, len(rules))
	for r := range rules {
		list = append(list, r)
	}
	sort.Slice(list, func(i, j int) bool {
		a, b := list[i], list[j]
		if a.Port != b.Port {
			return a.Port < b.Port
		}
		if a.Proto != b.Proto {
			return a.Proto < b.Proto
		}
		return a.Src < b.Src
	})
	body, _ := json.Marshal(list)
	if err := atomicfile.Write(path, body, 0o600); err != nil {
		s.logger.Warn("chain: cannot keep the link-port rules", "path", path, "err", err)
	}
}

/*
ensureChainFirewall brings the ufw rules of the chain's link ports to what the
block in force names (A-111), each restricted to the previous hops.

Until this the only opening was ensureCascadeFirewall, which reads the legacy
xray fragments a node with a chain does not get, so a hy2 or tuic leg, or any
leg into a node whose chain already ran, met a closed port.

It is a reconcile, not an open:
  - the rules for the block are opened first, then every rule opened for an
    earlier block and not named now is closed: a hop that moved leaves no
    ALLOW from its old address (an address that may not be ours a month on);
  - a nil block (the cascade taken off the node) closes everything;
  - names are resolved on every call, so a rule that fell open to anyone
    because a hop's name did not resolve is replaced by the per-source rules
    the moment it does, and the wide one closed. Comparing the panel's lists
    alone would not see that: port, transport and name are the same;
  - a port with no source named is not opened at all.

The caller passes the block in force: a refused push keeps the earlier one, so
it closes nothing.
*/
func (s *Server) ensureChainFirewall(ctx context.Context, chain *dto.NodeChain) {
	s.chainFwMu.Lock()
	defer s.chainFwMu.Unlock()

	want := map[chainFwRule]bool{}
	if chain != nil {
		for _, in := range chain.LinkIngress {
			if len(in.AllowFrom) == 0 {
				s.logger.Warn("chain: link port with no source named, not opened", "port", in.Port)
				continue
			}
			srcs, unresolved := fwResolve(ctx, s.logger, in.AllowFrom)
			if len(unresolved) > 0 && len(srcs) > 0 {
				s.logger.Warn("chain: some previous hops did not resolve, the link port is open to the rest",
					"port", in.Port, "unresolved", unresolved)
			}
			for _, proto := range in.Transports {
				if proto != "tcp" && proto != "udp" {
					continue
				}
				if len(srcs) == 0 {
					s.logger.Warn("chain: no previous hop resolved, link port opened to anyone",
						"port", in.Port, "proto", proto, "unresolved", unresolved)
					want[chainFwRule{Port: in.Port, Proto: proto}] = true
					continue
				}
				for _, src := range srcs {
					want[chainFwRule{Port: in.Port, Proto: proto, Src: src}] = true
				}
			}
		}
	}

	for r := range want {
		if r.Src == "" {
			fwAllow(ctx, s.logger, r.Port, r.Proto)
		} else {
			fwAllowSource(ctx, s.logger, r.Port, r.Proto, r.Src)
		}
	}
	for r := range s.loadChainFw() {
		if want[r] {
			continue
		}
		if r.Src == "" {
			fwClose(ctx, s.logger, r.Port, r.Proto)
		} else {
			fwCloseSource(ctx, s.logger, r.Port, r.Proto, r.Src)
		}
	}
	s.saveChainFw(want)
}
