package mtprotoproxy

import (
	"bufio"
	"fmt"
	"strconv"
	"strings"
)

// Metric names mtprotoproxy exports, with its default METRICS_PREFIX. The
// prefix is configurable upstream but this adapter never changes it, and the
// parser matches the full name so a prefix change fails loudly (zero rows,
// Degraded) instead of silently attributing nothing.
//
// From mtprotoproxy.py:1815-1840, `user_metrics_desc`:
//
//	user_octets_from  counter  octets_from_client   -> bytes the CLIENT sent
//	user_octets_to    counter  octets_to_client     -> bytes sent TO the client
//	user_octets       counter  from+to combined     -> deliberately unused here
//
// Each is emitted once per user as `name{user="<name>"} <value>`.
const (
	metricOctetsFrom = "mtprotoproxy_user_octets_from"
	metricOctetsTo   = "mtprotoproxy_user_octets_to"
)

// userTraffic is one user's counters as scraped.
type userTraffic struct {
	// BytesIn is traffic the client sent us (octets_from_client) — "in" from
	// the node's point of view, which is the direction the panel calls upload.
	BytesIn int64
	// BytesOut is traffic we sent the client (octets_to_client).
	BytesOut int64
}

// parseUserMetrics reads mtprotoproxy's Prometheus text and returns per-user
// counters keyed by the `user` label.
//
// The counters are CUMULATIVE since the process started, so the caller must
// report Stats.Cumulative and let the panel diff against its snapshot. Getting
// that backwards would double-bill every poll — and a SIGUSR2 reload does NOT
// reset them (it re-reads the config, it does not restart), while a crash-restart
// does. That asymmetry is the panel's problem to handle via the restart tally,
// not something this parser can paper over.
//
// Unknown metrics, HELP/TYPE lines and blank lines are skipped rather than
// treated as errors: upstream adds metrics, and a parser that fails on an
// unrecognised line would break on a routine version bump.
func parseUserMetrics(body string) (map[string]*userTraffic, error) {
	out := make(map[string]*userTraffic)
	sc := bufio.NewScanner(strings.NewReader(body))
	// Prometheus lines are short, but a hostile/garbled body should not be able
	// to make the scanner allocate without bound.
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		name, labels, value, ok := splitMetricLine(line)
		if !ok {
			continue
		}
		var field *int64
		switch name {
		case metricOctetsFrom, metricOctetsTo:
		default:
			continue
		}
		user, ok := labelValue(labels, "user")
		if !ok || user == "" {
			// A user metric with no user label cannot be attributed. Dropping it
			// is right: adding it to a total would inflate somebody's bill.
			continue
		}
		v, err := strconv.ParseFloat(value, 64)
		if err != nil {
			continue
		}
		if _, seen := out[user]; !seen {
			out[user] = &userTraffic{}
		}
		if name == metricOctetsFrom {
			field = &out[user].BytesIn
		} else {
			field = &out[user].BytesOut
		}
		*field = int64(v)
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("scan metrics: %w", err)
	}
	return out, nil
}

// splitMetricLine breaks `name{labels} value` (or `name value`) apart. Returns
// ok=false for anything that is not shaped like a sample.
func splitMetricLine(line string) (name, labels, value string, ok bool) {
	brace := strings.IndexByte(line, '{')
	if brace >= 0 {
		close := strings.LastIndexByte(line, '}')
		if close < brace {
			return "", "", "", false
		}
		name = line[:brace]
		labels = line[brace+1 : close]
		value = strings.TrimSpace(line[close+1:])
	} else {
		sp := strings.LastIndexByte(line, ' ')
		if sp < 0 {
			return "", "", "", false
		}
		name = line[:sp]
		value = strings.TrimSpace(line[sp+1:])
	}
	name = strings.TrimSpace(name)
	if name == "" || value == "" {
		return "", "", "", false
	}
	return name, labels, value, true
}

// labelValue pulls one label out of a Prometheus label set.
//
// mtprotoproxy escapes `"` inside a label value as `\"` (mtprotoproxy.py:1757)
// and escapes nothing else, so a value can contain a comma. Splitting the label
// set on commas would therefore truncate a user name containing one — our names
// are panel ids and cannot, but the parser should not depend on the writer's
// good behaviour, so this walks the string and tracks quoting instead.
func labelValue(labels, want string) (string, bool) {
	i := 0
	for i < len(labels) {
		eq := strings.IndexByte(labels[i:], '=')
		if eq < 0 {
			return "", false
		}
		key := strings.TrimSpace(labels[i : i+eq])
		j := i + eq + 1
		if j >= len(labels) || labels[j] != '"' {
			return "", false
		}
		j++ // past the opening quote
		var val strings.Builder
		for j < len(labels) {
			if labels[j] == '\\' && j+1 < len(labels) {
				val.WriteByte(labels[j+1])
				j += 2
				continue
			}
			if labels[j] == '"' {
				break
			}
			val.WriteByte(labels[j])
			j++
		}
		if j >= len(labels) {
			return "", false // unterminated
		}
		if key == want {
			return val.String(), true
		}
		j++ // past the closing quote
		for j < len(labels) && (labels[j] == ',' || labels[j] == ' ') {
			j++
		}
		i = j
	}
	return "", false
}
