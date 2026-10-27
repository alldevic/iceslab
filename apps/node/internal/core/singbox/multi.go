package singbox

import (
	"encoding/json"
	"fmt"
	"sort"
)

/*
Several inbounds of one protocol in one sing-box process (A-055, 22.10).

The adapter held ONE inbound: a second binding of the same protocol on the
same node replaced the first in silence, and its users stopped being served.
Now every inbound of the protocol is held by its push id and drawn into the
same config. Each is rendered the way it always was, alone, and the pieces
are joined: inbound tags (and the shadowtls detour to its inner shadowsocks)
take the id as a suffix so two of them cannot clash, the v2ray_api user list
is the union, and a managed shadowsocks gets one ssm-api server path per
inbound. A user scoped to some inbounds (AddUserOn) is rendered on those only.
*/

type heldInbound struct {
	id  string
	cfg InboundConfig
}

// sortedHeld is the inbounds in id order, so a render from the same state is
// byte-identical.
func sortedHeld(m map[string]InboundConfig) []heldInbound {
	out := make([]heldInbound, 0, len(m))
	for id, c := range m {
		out = append(out, heldInbound{id: id, cfg: c})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].id < out[j].id })
	return out
}

// ssmPath is the ssm-api server path of an inbound: "/" for the unnamed one
// (a push without ids), "/<id>" otherwise.
func ssmPath(id string) string {
	if id == "" {
		return "/"
	}
	return "/" + id
}

// tagSuffix keeps two inbounds' tags apart; none for the unnamed one, so a
// single inbound from an older panel renders as before.
func tagSuffix(id string) string {
	if id == "" {
		return ""
	}
	return "-" + id
}

// renderAll draws every held inbound into one config.
func (a *Adapter) renderAll(certPath, keyPath, statsListen string, held []heldInbound, users map[string]userEntry) ([]byte, error) {
	var base map[string]any
	var inbounds []any
	statsUsers := map[string]bool{}
	ssmServers := map[string]any{}
	var ssmService map[string]any
	for _, h := range held {
		mine := make(map[string]userEntry, len(users))
		for id, u := range users {
			if u.servesOn(h.id) {
				mine[id] = u
			}
		}
		blob, err := a.render(certPath, keyPath, statsListen, h.cfg, mine)
		if err != nil {
			return nil, err
		}
		var doc map[string]any
		if err := json.Unmarshal(blob, &doc); err != nil {
			return nil, fmt.Errorf("re-read rendered config: %w", err)
		}
		suffix := tagSuffix(h.id)
		ins, _ := doc["inbounds"].([]any)
		for _, raw := range ins {
			in, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			if tag, ok := in["tag"].(string); ok {
				in["tag"] = tag + suffix
			}
			if det, ok := in["detour"].(string); ok {
				in["detour"] = det + suffix
			}
			inbounds = append(inbounds, in)
		}
		if exp, ok := doc["experimental"].(map[string]any); ok {
			if v2, ok := exp["v2ray_api"].(map[string]any); ok {
				if st, ok := v2["stats"].(map[string]any); ok {
					if us, ok := st["users"].([]any); ok {
						for _, u := range us {
							if s, ok := u.(string); ok {
								statsUsers[s] = true
							}
						}
					}
				}
			}
		}
		if svcs, ok := doc["services"].([]any); ok && len(svcs) > 0 {
			if svc, ok := svcs[0].(map[string]any); ok {
				ssmService = svc
				ssmServers[ssmPath(h.id)] = "ss-in" + suffix
			}
		}
		if base == nil {
			base = doc
		}
	}
	if base == nil {
		return nil, fmt.Errorf("no inbound to render")
	}
	base["inbounds"] = inbounds
	if exp, ok := base["experimental"].(map[string]any); ok {
		if v2, ok := exp["v2ray_api"].(map[string]any); ok {
			if st, ok := v2["stats"].(map[string]any); ok {
				names := make([]string, 0, len(statsUsers))
				for n := range statsUsers {
					names = append(names, n)
				}
				sort.Strings(names)
				if len(names) > 0 {
					st["users"] = names
				} else {
					delete(st, "users")
				}
			}
		}
	}
	if ssmService != nil {
		ssmService["servers"] = ssmServers
		base["services"] = []any{ssmService}
	}
	return json.MarshalIndent(base, "", "  ")
}
