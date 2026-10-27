package amneziawg

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/icecompany-tech/iceslab/apps/node/internal/atomicfile"
)

/*
The interface's applied state, kept beside its config so an agent restart
starts from it.

A-114, 22.10: the kernel keeps an awg interface and its peers across an agent
restart, and the new agent knew none of it. Its first ApplyInbound compared the
pushed address against "" (classifyDiff: diffSubnet), took the live interface
down and brought it up with no [Peer] at all. A restart that cost the users
nothing was turned by the agent into all of them disconnected, back one by one
as the panel re-sent /addUser, or never, when the panel could not build the
node's push.

The config file alone cannot be read back into memory: a [Peer] carries a key
and an address, and the adapter needs the user id to remove a peer later. So
the inbound as applied and the peers by user id go here, 0600 like the config
(the server key is in both), written after every config write that succeeded.

⚠ A node whose agent predates this file has none on its first restart after
the update, and that restart still comes up with no peers, as before.
*/

type savedState struct {
	Inbound   InboundConfig `json:"inbound"`
	InboundID string        `json:"inboundId,omitempty"`
	// PeerSets: every peer of each user, a peer per device. Peers keeps one
	// per user, the first: what an agent older than devices reads, so a
	// downgrade comes back with a device per user rather than none.
	PeerSets map[string][]Peer `json:"peerSets,omitempty"`
	Peers    map[string]Peer   `json:"peers"`
}

// statePath sits beside the config, under a name awg-quick does not read
// (it reads <iface>.conf only).
func (a *Adapter) statePath() string {
	return strings.TrimSuffix(a.cfg.ConfigPath, ".conf") + ".state.json"
}

// saveState writes what memory holds now. Called with restartMu held and mu
// free, after the config write it follows. A failure is logged, not returned:
// the interface already runs the change, and only the next restart loses it.
func (a *Adapter) saveState() {
	a.mu.Lock()
	st := savedState{
		Inbound:   a.cfg.Inbound,
		InboundID: a.inboundID,
		PeerSets:  make(map[string][]Peer, len(a.peers)),
		Peers:     make(map[string]Peer, len(a.peers)),
	}
	for id, set := range a.peers {
		st.PeerSets[id] = append([]Peer(nil), set...)
		if len(set) > 0 {
			st.Peers[id] = set[0]
		}
	}
	a.mu.Unlock()
	body, err := json.MarshalIndent(st, "", "  ")
	if err == nil {
		err = atomicfile.Write(a.statePath(), body, 0o600)
	}
	if err != nil {
		a.logger.Error("amneziawg: state not saved, an agent restart will come up without these peers",
			"path", a.statePath(), "err", err)
	}
}

// loadState restores the state saved by the previous agent, before anything
// else touches the adapter. An inbound saved for another interface is not
// taken. The install-time hooks stay the ones this agent was started with.
// Every peer passes the same check addPeer makes, so a file edited by hand
// cannot put a line into the config that the panel could not.
func (a *Adapter) loadState() {
	body, err := os.ReadFile(a.statePath())
	if err != nil {
		if !os.IsNotExist(err) {
			a.logger.Warn("amneziawg: saved state unreadable, starting without it", "path", a.statePath(), "err", err)
		}
		return
	}
	var st savedState
	if err := json.Unmarshal(body, &st); err != nil {
		a.logger.Warn("amneziawg: saved state unparsable, starting without it", "path", a.statePath(), "err", err)
		return
	}
	if st.Inbound.Interface != a.cfg.Inbound.Interface {
		a.logger.Warn("amneziawg: saved state is for another interface, not taken",
			"saved", st.Inbound.Interface, "interface", a.cfg.Inbound.Interface)
		return
	}
	inbound := st.Inbound
	inbound.PostUp, inbound.PostDown = a.cfg.Inbound.PostUp, a.cfg.Inbound.PostDown
	if inbound.ListenPort == 0 {
		inbound.ListenPort = a.cfg.Inbound.ListenPort
	}
	// An agent older than devices saved one peer per user.
	sets := st.PeerSets
	if sets == nil {
		sets = make(map[string][]Peer, len(st.Peers))
		for id, p := range st.Peers {
			sets[id] = []Peer{p}
		}
	}
	peers := make(map[string][]Peer, len(sets))
	for id, set := range sets {
		for _, p := range set {
			if err := validatePeer(p); err != nil {
				a.logger.Warn("amneziawg: saved peer refused", "user", id, "err", err)
				continue
			}
			peers[id] = append(peers[id], p)
		}
	}
	a.cfg.Inbound = inbound
	a.inboundID = st.InboundID
	a.peers = peers
	a.logger.Info("amneziawg: state of the previous agent restored",
		"interface", inbound.Interface, "peers", len(peers), "configured", inbound.PrivateKey != "")
}

// validatePeer is what renderConfig would refuse about one peer, asked before
// the peer is kept (П-3).
func validatePeer(p Peer) error {
	if err := validateWGKey(p.PublicKey); err != nil {
		return fmt.Errorf("public key: %w", err)
	}
	if err := validateAllowedIP(p.AllowedIP); err != nil {
		return err
	}
	if p.PresharedKey != "" {
		if err := validateWGKey(p.PresharedKey); err != nil {
			return fmt.Errorf("preshared key: %w", err)
		}
	}
	return nil
}
