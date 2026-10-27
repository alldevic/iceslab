package xray

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

/*
applyRoutingLive hands a config whose only change is its routing to the running
core, without a restart (A-134, 22.10).

A policy rule or a cascade's entry rules changed, and the core was restarted for
it: every open connection on the node dropped for a rule that touches none of
them. `xray api adrules` without -append replaces the router's rules and
balancers in the running process (Xray-core v26.3.27, app/router/router.go
ReloadRules: !shouldAppend resets r.rules and r.balancers; the CLI,
main/commands/all/api/rules_add.go, takes a file in the config format with a
"routing" key). The domain strategy is not reloaded by it, which is part of the
routing block: a change there is not "routing only" for this purpose and takes
the restart.

Order, all of it already decided before here or inside:
 1. The full new config passed `xray -test` (regenerateAndRestart does that
    first, and a refusal never reaches this function).
 2. The running config is the file on disk: since A-130 it is written only with
    what the core took. Everything but "routing" has to be byte-identical to
    it; anything else is a restart.
 3. The new routing must keep the API inbound's rule. A replace without it
    takes the rule away, and the next adu/rmu/adrules can no longer reach the
    core at all, so it is refused, not applied.
 4. adrules. A refusal there may leave the router half replaced (ReloadRules
    clears before it builds and does not restore), so a failure is never
    left standing: the caller restarts from the full config.
 5. Only then the file.

Answers (true, nil) when applied live, (false, nil) when the restart is the
way, and an error only for a routing it refuses.
*/
func (a *Adapter) applyRoutingLive(ctx context.Context, blob []byte, apiPort int, geo string) (bool, error) {
	a.mu.Lock()
	cfgPath := a.cfg.ConfigPath
	binPath := a.cfg.BinaryPath
	run := a.cfg.RunCmd
	proc := a.proc
	// A geo file replaced under the running core is read again only by a
	// restart (core.GeoReceiver); a live routing change would leave it stale.
	geoCurrent := geo == a.geoRunning
	a.mu.Unlock()
	if cfgPath == "" || binPath == "" || run == nil || proc == nil || !proc.Running() || !geoCurrent {
		return false, nil
	}
	running, err := os.ReadFile(cfgPath)
	if err != nil {
		return false, nil
	}
	routing, ok := routingOnlyChange(running, blob)
	if !ok {
		return false, nil
	}
	if !keepsAPIRule(routing) {
		return false, &refusedError{fmt.Errorf("xray routing without the API inbound's rule: replacing it live would cut the agent off the core")}
	}

	doc, err := json.Marshal(map[string]json.RawMessage{"routing": routing})
	if err != nil {
		return false, nil
	}
	tmp, err := os.CreateTemp("", "ice-xray-adrules-*.json")
	if err != nil {
		return false, nil
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	_, werr := tmp.Write(doc)
	cerr := tmp.Close()
	if werr != nil || cerr != nil {
		return false, nil
	}
	cctx, cancel := context.WithTimeout(ctx, apiCallTimeout)
	defer cancel()
	out, err := runLiveOp(cctx, run, binPath, "api", "adrules", fmt.Sprintf("--server=127.0.0.1:%d", apiPort), tmpPath)
	if err != nil {
		a.logger.Warn("xray api adrules failed; restarting from the full config",
			"err", err, "out", strings.TrimSpace(string(out)))
		return false, nil
	}
	if err := writeConfig(cfgPath, blob); err != nil {
		// The core runs the new rules and the file says the old ones: the
		// restart writes the file and runs it, so both agree again.
		a.logger.Warn("xray: routing replaced live, config write failed; restarting", "err", err)
		return false, nil
	}
	a.logger.Info("xray routing replaced live (no restart)")
	return true, nil
}

// routingOnlyChange: the new config's "routing", when it is the only top-level
// key that differs from the running one. Both are rendered by the same
// MarshalIndent, so equal sections are equal bytes.
func routingOnlyChange(running, next []byte) (json.RawMessage, bool) {
	var was, is map[string]json.RawMessage
	if json.Unmarshal(running, &was) != nil || json.Unmarshal(next, &is) != nil {
		return nil, false
	}
	if len(was) != len(is) {
		return nil, false
	}
	for k, v := range is {
		w, ok := was[k]
		if !ok {
			return nil, false
		}
		if k == "routing" {
			continue
		}
		if !bytes.Equal(compact(w), compact(v)) {
			return nil, false
		}
	}
	routing, ok := is["routing"]
	if !ok || bytes.Equal(compact(was["routing"]), compact(routing)) {
		return nil, false
	}
	// The domain strategy is not reloaded by adrules.
	var r1, r2 struct {
		DomainStrategy string `json:"domainStrategy"`
	}
	_ = json.Unmarshal(was["routing"], &r1)
	_ = json.Unmarshal(routing, &r2)
	if r1.DomainStrategy != r2.DomainStrategy {
		return nil, false
	}
	return routing, true
}

// keepsAPIRule: the routing still sends the management inbound to the api
// outbound, the rule renderMultiConfig always puts first.
func keepsAPIRule(routing json.RawMessage) bool {
	var r struct {
		Rules []struct {
			InboundTag  []string `json:"inboundTag"`
			OutboundTag string   `json:"outboundTag"`
		} `json:"rules"`
	}
	if json.Unmarshal(routing, &r) != nil {
		return false
	}
	for _, rule := range r.Rules {
		if rule.OutboundTag != "api" {
			continue
		}
		for _, tag := range rule.InboundTag {
			if tag == "api-in" {
				return true
			}
		}
	}
	return false
}

func compact(b []byte) []byte {
	var buf bytes.Buffer
	if json.Compact(&buf, b) != nil {
		return b
	}
	return buf.Bytes()
}
