package dto

import (
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// The panel↔node wire is two files in two languages held together by a comment
// that says "json tags match exactly". Nothing checked that claim, and the way
// it breaks is silent: a key the panel sends and the Go struct has no tag for
// is dropped by encoding/json without a word. The push succeeds, the node comes
// up healthy, and the feature the panel shows as enabled is simply not there.
// The project already has that scar (the sing-box adapter decoding a narrow
// subset), which is why this compares the whole shape rather than one field.
//
// Failing here does not always mean the Go side is wrong - it means the two
// sides disagree, and somebody has to say which one moved.

const tsRelPath = "../../../../packages/shared/src/transport.ts"

// Every struct on this wire, paired with the TypeScript interface the panel
// builds it from. A pair missing from this table is a shape nothing compares,
// so add one whenever a new request or response joins the protocol.
func wirePairs() []struct {
	ts  string
	go_ any
} {
	return []struct {
		ts  string
		go_ any
	}{
		// The credentials are the sharpest edge: a dropped key here means a
		// user who paid for a protocol cannot authenticate to it.
		{"ProtocolCredentials", ProtocolCredentials{}},
		{"AddUserRequest", AddUserRequest{}},
		{"AddUserResponse", AddUserResponse{}},
		{"InboundDto", InboundDto{}},
		{"ApplyInboundsRequest", ApplyInboundsRequest{}},
		{"ApplyInboundsResponse", ApplyInboundsResponse{}},
		{"ApplyEgressRequest", ApplyEgressRequest{}},
		{"ApplyEgressResponse", ApplyEgressResponse{}},
		{"GenerateKeysRequest", GenerateKeysRequest{}},
		{"GenerateKeysResponse", GenerateKeysResponse{}},
		{"RemoveUserRequest", RemoveUserRequest{}},
		{"RemoveUserResponse", RemoveUserResponse{}},
		{"UserStats", UserStats{}},
		{"GetStatsResponse", GetStatsResponse{}},
		{"CoreRestarts", CoreRestartsDto{}},
		{"CoreStatus", CoreStatus{}},
		{"HealthcheckResponse", HealthcheckResponse{}},
		{"EgressTune", EgressTuneDto{}},
		{"CPUMetricsDto", CPUMetricsDto{}},
		{"MemoryMetricsDto", MemoryMetricsDto{}},
		{"DiskMetricsDto", DiskMetricsDto{}},
		{"HostMetricsResponse", HostMetricsResponse{}},
		{"UfwPortDto", UfwPortDto{}},
		{"UfwPortsResponse", UfwPortsResponse{}},
		{"NodeErrorResponse", ErrorResponse{}},
	}
}

func TestWireShapesMatchTheSharedTypescript(t *testing.T) {
	ts := parseTypescriptInterfaces(t)

	for _, pair := range wirePairs() {
		t.Run(pair.ts, func(t *testing.T) {
			want, ok := ts[pair.ts]
			if !ok {
				t.Fatalf("no `export interface %s` in %s - the panel side was renamed or moved, "+
					"and this Go struct is now talking to nobody", pair.ts, tsRelPath)
			}
			got := jsonTagNames(reflect.TypeOf(pair.go_))

			for _, k := range want {
				if !contains(got, k) {
					t.Errorf("the panel sends %s.%s and no Go field carries that json tag: "+
						"encoding/json drops it silently, so the node comes up healthy "+
						"without the thing the panel thinks it enabled", pair.ts, k)
				}
			}
			for _, k := range got {
				if !contains(want, k) {
					t.Errorf("the Go struct expects %q on %s and the panel never sends it: "+
						"the field is dead, or the panel side spells it differently", k, pair.ts)
				}
			}
		})
	}
}

// Control: the comparison must be able to fail. A parser that quietly returned
// nothing would make every pair above pass by vacuum.
func TestTheTypescriptParserActuallyReadsFields(t *testing.T) {
	ts := parseTypescriptInterfaces(t)
	if len(ts) < 20 {
		t.Fatalf("parsed %d interfaces from %s, expected the whole transport contract", len(ts), tsRelPath)
	}
	creds, ok := ts["ProtocolCredentials"]
	if !ok || len(creds) < 10 {
		t.Fatalf("ProtocolCredentials parsed as %v; the parser is not reading property names", creds)
	}
	// A property whose comment mentions another name must not be mistaken for
	// a property: the credentials block is full of prose naming other fields.
	if contains(creds, "AllowedIPs") || contains(creds, "users") {
		t.Errorf("parser picked names out of doc comments: %v", creds)
	}
}

func contains(hay []string, needle string) bool {
	for _, h := range hay {
		if h == needle {
			return true
		}
	}
	return false
}

// jsonTagNames returns the wire names of a struct's fields, i.e. exactly what
// encoding/json will look for on the way in and emit on the way out.
func jsonTagNames(t reflect.Type) []string {
	var out []string
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		tag := f.Tag.Get("json")
		if tag == "-" {
			continue
		}
		name, _, _ := strings.Cut(tag, ",")
		if name == "" {
			name = f.Name // encoding/json falls back to the Go name
		}
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

var (
	blockComment = regexp.MustCompile(`(?s)/\*.*?\*/`)
	lineComment  = regexp.MustCompile(`(?m)//.*$`)
	ifaceHead    = regexp.MustCompile(`export interface (\w+)[^{]*\{`)
	propLine     = regexp.MustCompile(`^\s*(\w+)\??\s*:`)
)

// parseTypescriptInterfaces reads the shared transport contract and returns the
// property names of each `export interface`, top level only (a nested object
// literal's keys are not wire names of the interface itself).
func parseTypescriptInterfaces(t *testing.T) map[string][]string {
	t.Helper()
	path, err := filepath.Abs(tsRelPath)
	if err != nil {
		t.Fatalf("resolve %s: %v", tsRelPath, err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v - the shared contract is where the panel side of this wire lives", path, err)
	}
	src := lineComment.ReplaceAllString(blockComment.ReplaceAllString(string(raw), ""), "")

	out := map[string][]string{}
	for _, m := range ifaceHead.FindAllStringSubmatchIndex(src, -1) {
		name := src[m[2]:m[3]]
		depth := 1
		var props []string
		for _, line := range strings.Split(src[m[1]:], "\n") {
			if depth == 1 {
				if p := propLine.FindStringSubmatch(line); p != nil {
					props = append(props, p[1])
				}
			}
			depth += strings.Count(line, "{") - strings.Count(line, "}")
			if depth <= 0 {
				break
			}
		}
		sort.Strings(props)
		out[name] = props
	}
	return out
}

// The unions, which the struct comparison above does not reach.
//
// `ProtocolName` says in its own comment that it mirrors the union in
// transport.ts, and it had stopped: mtproto and mieru were protocols the panel
// could save and this file had no constant for. Nothing broke, because the
// dispatcher compares strings and NativeEngine falls through to the protocol's
// own name — which is exactly why it went unnoticed, and exactly the kind of
// gap that stops being harmless the first time a protocol needs a native engine
// that is not called after itself.
func tsUnion(t *testing.T, name string) []string {
	t.Helper()
	src, err := os.ReadFile(tsRelPath)
	if err != nil {
		t.Fatalf("read transport.ts: %v", err)
	}
	i := strings.Index(string(src), "export type "+name+" =")
	if i < 0 {
		t.Fatalf("union %s was renamed or moved in transport.ts", name)
	}
	body := string(src)[i:]
	body = body[:strings.Index(body, ";")]
	var out []string
	for _, m := range regexp.MustCompile(`'([a-z0-9]+)'`).FindAllStringSubmatch(body, -1) {
		out = append(out, m[1])
	}
	sort.Strings(out)
	return out
}

// goConsts reads the values of a const block of the given Go type out of this
// package's source, rather than listing them here — a list written twice is the
// thing being tested.
func goConsts(t *testing.T, typeName string) []string {
	t.Helper()
	src, err := os.ReadFile("dto.go")
	if err != nil {
		t.Fatalf("read dto.go: %v", err)
	}
	re := regexp.MustCompile(`(?m)^\s*\w+\s+` + typeName + `\s*=\s*"([a-z0-9]+)"`)
	var out []string
	for _, m := range re.FindAllStringSubmatch(string(src), -1) {
		out = append(out, m[1])
	}
	sort.Strings(out)
	return out
}

func TestTheProtocolAndEngineUnionsMatchTheSharedTypescript(t *testing.T) {
	for _, u := range []string{"ProtocolName", "EngineName"} {
		ts := tsUnion(t, u)
		// Control: an empty parse on either side would make the comparison of
		// two empty sets pass.
		if len(ts) < 3 {
			t.Fatalf("%s parsed out of transport.ts as %v; the union's shape changed", u, ts)
		}
		got := goConsts(t, u)
		if len(got) < 3 {
			t.Fatalf("%s parsed out of dto.go as %v; the const block's shape changed", u, got)
		}
		if !reflect.DeepEqual(ts, got) {
			t.Errorf("%s disagrees between the two languages:\n  transport.ts: %v\n  dto.go:       %v", u, ts, got)
		}
	}
}
