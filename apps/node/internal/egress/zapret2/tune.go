package zapret2

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

// F3 self-tune. blockcheckw (bundled in ss-zapret2) probes a blocked domain
// against a corpus of DPI-bypass strategies and prints a JSON report of the
// ones that got through, ranked best-first. A systemd timer on the node runs it
// and drops the raw output in a file; the agent parses that file here and
// splices the winning strategy into the zapret2 config it writes.
//
// The node parses rather than the panel because the node is the one that has to
// APPLY the result: a strategy that works from this node's uplink is a property
// of that uplink, and shipping the raw report to the panel only to have it ship
// a rewritten config back would put two writers on one file. The panel is told
// which strategy won (see /healthz) so an operator can see it, compare nodes,
// and promote it into a preset later.
//
// Report shape captured from a real node behind RU DPI (rutracker.org,
// TLS1.3 blocked, ss-zapret2 v1.0.2, 2026-06-24):
//
//	{ "domain": "rutracker.org", "total": 42, "working": 3,
//	  "strategies": [ { "protocol": "HTTPS/TLS1.3",
//	                    "args": "--payload=tls_client_hello --lua-desync=tcpseg:pos=0,1:ip_id=rnd:repeats=1",
//	                    "coverage": 1 }, ... ] }
//
// When nothing is blocked, total/working are 0 and strategies is empty
// (example.com on the same node), which is a valid report and means "leave the
// configured strategy alone".

// Tune is the winning strategy from a scan, as the agent applies and reports it.
// The json tags are the wire shape the panel stores (nodes.egress_tune).
type Tune struct {
	// Domain the scan proved the strategy against.
	Domain string `json:"domain"`
	// Protocol label from blockcheckw, e.g. "HTTPS/TLS1.3".
	Protocol string `json:"protocol"`
	// Args is the nfqws2 strategy verbatim; it slots into an NFQWS2_OPT line
	// after a filter selector.
	Args string `json:"args"`
	// Coverage is blockcheckw's own score for the strategy, when it reports one.
	Coverage float64 `json:"coverage,omitempty"`
	// Total / Working are the scan's counts, kept so the panel can tell "no
	// strategy needed" (working=0 because nothing was blocked) from "scan found
	// nothing that works", which look the same from the strategy alone.
	Total   int `json:"total"`
	Working int `json:"working"`
}

type blockcheckReport struct {
	Domain     string `json:"domain"`
	Total      int    `json:"total"`
	Working    int    `json:"working"`
	Strategies []struct {
		Protocol string  `json:"protocol"`
		Args     string  `json:"args"`
		Coverage float64 `json:"coverage"`
	} `json:"strategies"`
}

// ParseBlockcheckReports reads one or more concatenated blockcheckw outputs
// (the scanner prints progress lines around its JSON, and the node scans
// several domains in one run) and returns the first ranked TLS strategy found.
// A nil Tune with a nil error means the scans ran and found nothing to apply,
// which is the ordinary outcome on an unfiltered uplink.
func ParseBlockcheckReports(raw []byte) (*Tune, error) {
	var lastErr error
	var parsedAny bool
	var best *Tune
	for _, chunk := range splitReports(raw) {
		obj := extractJSONObject(chunk)
		if obj == nil {
			continue
		}
		var rep blockcheckReport
		if err := json.Unmarshal(obj, &rep); err != nil {
			lastErr = fmt.Errorf("blockcheckw report is not valid JSON: %w", err)
			continue
		}
		parsedAny = true
		for _, s := range rep.Strategies {
			// blockcheckw ranks best-first, so the first TLS entry wins. Only
			// TLS: the http and quic lines in the config are static selectors
			// the panel owns, and a strategy proven for one protocol says
			// nothing about another.
			if s.Args == "" || !strings.Contains(strings.ToLower(s.Protocol), "tls") {
				continue
			}
			best = &Tune{
				Domain:   rep.Domain,
				Protocol: s.Protocol,
				Args:     strings.TrimSpace(s.Args),
				Coverage: s.Coverage,
				Total:    rep.Total,
				Working:  rep.Working,
			}
			break
		}
		if best != nil {
			return best, nil
		}
	}
	if !parsedAny && lastErr != nil {
		return nil, lastErr
	}
	if !parsedAny {
		return nil, fmt.Errorf("no JSON object found in blockcheckw output")
	}
	return nil, nil
}

// reportSeparator is what the node's scan script writes between per-domain
// reports. Absent (a single report), the whole input is one chunk.
const reportSeparator = "===REPORT-SEP==="

func splitReports(raw []byte) [][]byte {
	if !bytes.Contains(raw, []byte(reportSeparator)) {
		return [][]byte{raw}
	}
	return bytes.Split(raw, []byte(reportSeparator))
}

// extractJSONObject pulls the outermost {...} out of mixed stdout, or nil.
func extractJSONObject(raw []byte) []byte {
	start := bytes.IndexByte(raw, '{')
	end := bytes.LastIndexByte(raw, '}')
	if start == -1 || end <= start {
		return nil
	}
	return raw[start : end+1]
}

// MergeTunedTLS returns the config body with its TLS strategy replaced by the
// tuned one, leaving every other line of NFQWS2_OPT (the http and quic
// selectors the panel owns) untouched.
//
// This is the whole reason the tune and the pushed config can coexist: the
// panel owns the config, the node owns ONE line of it, and the merge happens
// where the file is written rather than by two processes racing to rewrite it.
// A nil tune, or a body with no TLS line to replace, returns the body unchanged
// so a node that never scanned renders exactly what the panel sent.
func MergeTunedTLS(body string, tune *Tune) string {
	if tune == nil || tune.Args == "" {
		return body
	}
	lines := strings.Split(body, "\n")
	for i, line := range lines {
		if !strings.Contains(line, "--filter-l7=tls") {
			continue
		}
		lines[i] = tunedLine(line, tune.Args)
		return strings.Join(lines, "\n")
	}
	return body
}

// tunedLine rebuilds one NFQWS2_OPT line: keep its leading selectors (which
// port and which L7 this line matches, plus any hostlist the operator set) and
// its trailing `--new` separator, and swap the strategy in between. Splicing
// rather than replacing the line keeps the config's structure the panel's.
func tunedLine(line, args string) string {
	fields := strings.Fields(line)
	head := make([]string, 0, len(fields))
	for _, f := range fields {
		if strings.HasPrefix(f, "--filter-") || strings.HasPrefix(f, "--hostlist") {
			head = append(head, f)
			continue
		}
		break
	}
	out := strings.Join(head, " ") + " " + args
	if strings.HasSuffix(strings.TrimSpace(line), "--new") {
		out += " --new"
	}
	return out
}
