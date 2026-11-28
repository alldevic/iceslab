package singbox

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

/*
The hand-off to the chain process (11.5, the sing-box half of 11.4's contract).

A sing-box instance that is the entry of a cascade sends EVERY connection of its
inbounds into the chain's loopback socks listener, and has no other way out:
the config then holds that one socks outbound and route.final names it. No
"direct" outbound is drawn at all, so with the chain process down or every exit
dead the connection is refused, never made from this node (the leak this whole
phase exists to prevent).

Without a hand-off nothing here is drawn and the config is byte for byte what
it always was.

For shadowtls the inbound detours into an inner shadowsocks inbound on loopback;
the decrypted traffic is routed from THAT inbound, and route.final covers it.
*/

// ChainHandoff is where this instance's users go: the chain's socks listener on
// this machine. A PORT and not an address, so a push cannot point the core
// anywhere but another port on 127.0.0.1.
type ChainHandoff struct {
	Port     int
	Username string
	Password string
	// Closed is no hand-off at all but its refusal, 19.15: an entry whose
	// hand-off was not accepted and which holds none. It is drawn closed (every
	// connection rejected), never with a `direct` way out. Why is the reason.
	Closed bool
	Why    string
}

// chainHandoffWire mirrors NodeChain.userCore.socks in shared/transport.ts.
type chainHandoffWire struct {
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
}

const chainOutboundTag = "chain"

var _ core.CascadeReceiver = (*Adapter)(nil)

// ApplyCascade implements core.CascadeReceiver: the node-level hand-off to the
// chain. The server calls it on EVERY push and only on the instance whose
// protocol the block names; every other instance gets nil.
//
// nil takes the hand-off away and brings back the "direct" outbound. A hand-off
// that repeats is a no-op: re-rendering would restart the core and drop every
// live connection of the node on each push. A hand-off the renderer refuses is
// not stored, so the next render does not run against it.
func (a *Adapter) ApplyCascade(raw json.RawMessage) error {
	var handoff *ChainHandoff
	if len(raw) > 0 && string(raw) != "null" {
		var wire chainHandoffWire
		if err := json.Unmarshal(raw, &wire); err != nil {
			return a.refuseHandoff(fmt.Errorf("singbox ApplyCascade: %w", err))
		}
		handoff = &ChainHandoff{Port: wire.Port, Username: wire.Username, Password: wire.Password}
		if err := handoff.validate(); err != nil {
			return a.refuseHandoff(err)
		}
	}

	a.mu.Lock()
	if handoffEqual(a.chain, handoff) && !a.lastStartFailed {
		a.mu.Unlock()
		return nil
	}
	prev := a.chain
	a.chain = handoff
	nothingRuns := len(a.inbounds) == 0
	a.mu.Unlock()
	// No inbound yet: remembered for the render that comes (the inbounds of
	// this same push are applied after this call).
	if nothingRuns {
		return nil
	}
	err := a.regenerateAndRestart()
	var refused *refusedError
	if errors.As(err, &refused) {
		a.mu.Lock()
		if handoffEqual(a.chain, handoff) {
			a.chain = prev
		}
		a.mu.Unlock()
		// The hand-off was the push's; a refusal that leaves no hand-off must not
		// leave a `direct` one.
		return a.refuseHandoff(err)
	}
	if err == nil {
		a.logger.Info("singbox ApplyCascade: hand-off to the chain changed",
			"protocol", a.protocol, "chain", handoff != nil)
	}
	return err
}

var _ core.CascadeCloser = (*Adapter)(nil)

// CloseCascade implements core.CascadeCloser.
func (a *Adapter) CloseCascade(reason string) error {
	return a.refuseHandoff(errors.New(reason))
}

// CascadeClosed implements core.CascadeCloser.
func (a *Adapter) CascadeClosed() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.chain != nil && a.chain.Closed {
		return a.chain.Why
	}
	return ""
}

// refuseHandoff is the answer to a hand-off this instance cannot take (19.15):
// with none held, the core is drawn closed, so its users get nothing instead
// of leaving through the entry; one already held is kept, as before. The error
// goes back to the caller either way.
func (a *Adapter) refuseHandoff(cause error) error {
	a.mu.Lock()
	if a.chain != nil {
		a.mu.Unlock()
		return cause
	}
	a.chain = &ChainHandoff{Closed: true, Why: "cascade entry closed: " + cause.Error()}
	nothingRuns := len(a.inbounds) == 0
	a.mu.Unlock()
	if nothingRuns {
		return cause
	}
	if err := a.regenerateAndRestart(); err != nil {
		a.logger.Error("singbox: drawing the closed cascade entry failed", "protocol", a.protocol, "err", err)
	} else {
		a.logger.Warn("singbox: no hand-off to the chain, the entry rejects every connection",
			"protocol", a.protocol, "why", cause)
	}
	return cause
}

func (h *ChainHandoff) validate() error {
	if h.Port < 1 || h.Port > 65535 {
		return fmt.Errorf("singbox chain hand-off: port %d is not a port", h.Port)
	}
	// The chain's socks listeners are authenticated even on loopback: a VPS has
	// other users.
	if h.Username == "" || h.Password == "" {
		return fmt.Errorf("singbox chain hand-off: username and password are required")
	}
	return nil
}

func handoffEqual(a, b *ChainHandoff) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// outbound is the one way out of an entry: socks5 to the chain's listener.
func (h *ChainHandoff) outbound() map[string]any {
	return map[string]any{
		"type":        "socks",
		"tag":         chainOutboundTag,
		"server":      "127.0.0.1",
		"server_port": h.Port,
		"version":     "5",
		"username":    h.Username,
		"password":    h.Password,
	}
}
