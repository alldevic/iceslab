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
//
// This compares the whole shape, in both directions, so a dead Go field is
// caught alongside a dropped panel key. Failing here does not always mean the
// Go side is wrong - it means the two sides disagree, and somebody has to say
// which one moved. A change to a field belongs in dto.go and transport.ts in
// ONE pull request.
//
// Not covered: the inbound configs (XrayInboundCfg and the like). The agent
// mirrors them in private structs of the adapters, outside this package.

const tsRelPath = "../../../../packages/shared/src/transport.ts"

// wirePair is one Go struct and where its shape lives in transport.ts. ts is
// an `export interface` or `export type X = {...} | {...}` name; "A|B" is the
// union of interfaces A and B (a Go struct with optional halves); "I.p" is the
// object type written inline on property p of interface I.
type wirePair struct {
	ts  string
	go_ any
}

// Every struct of dto.go is here or in wireExcluded: a struct in neither is a
// shape nothing compares, so add it whenever a new request or response joins
// the protocol.
func wirePairs() []wirePair {
	return []wirePair{
		{"ProtocolCredentials", ProtocolCredentials{}},
		{"AddUserRequest", AddUserRequest{}},
		{"AddUserResponse", AddUserResponse{}},
		{"AddUsersRequest", AddUsersRequest{}},
		{"AddUsersResponse", AddUsersResponse{}},
		{"AddUsersResult", AddUsersResult{}},
		{"InboundDto", InboundDto{}},
		{"NodePolicy", NodePolicy{}},
		{"NodePolicyRule", NodePolicyRule{}},
		{"NodePolicyMatch", NodePolicyMatch{}},
		{"NodePolicyAction", NodePolicyAction{}},
		{"DnsCfg", DnsCfg{}},
		{"DnsServer", DnsServer{}},
		{"ApplyInboundsRequest", ApplyInboundsRequest{}},
		{"NodeGeo", NodeGeo{}},
		{"NodeGeoFile", NodeGeoFile{}},
		{"GeoFileDto", GeoFileDto{}},
		{"GeoAssetsResponse", GeoAssetsResponse{}},
		{"GeoStatus", GeoStatusDto{}},
		{"NodeChain", NodeChain{}},
		{"ChainLinkIngress", ChainLinkIngress{}},
		{"ChainTunnel", ChainTunnel{}},
		// Optional halves in Go, a union of three interfaces in TypeScript.
		{"ChainUserCoreXray|ChainUserCoreHysteria|ChainUserCoreAmneziawg", ChainUserCore{}},
		{"ChainUserCoreTProxy", ChainUserCoreTProxy{}},
		{"ChainUserCoreSocks", ChainUserCoreSocks{}},
		{"ChainSocks", ChainSocks{}},
		{"NodeCascade", NodeCascade{}},
		{"ApplyInboundsResponse", ApplyInboundsResponse{}},
		{"RemoveUserRequest", RemoveUserRequest{}},
		{"RemoveUserResponse", RemoveUserResponse{}},
		{"UserStats", UserStats{}},
		{"CoreTrafficTotal", CoreTrafficTotal{}},
		{"GetStatsResponse", GetStatsResponse{}},
		{"LingeringUser", LingeringUser{}},
		{"CoreRestarts", CoreRestartsDto{}},
		{"ReservedPort", ReservedPortDto{}},
		{"CoreStatus", CoreStatus{}},
		{"CoreTls", CoreTLSDto{}},
		{"ChainStatus", ChainStatusDto{}},
		{"HealthcheckResponse", HealthcheckResponse{}},
		{"NodePolicyDrawn", PolicyDrawn{}},
		{"PortHopping", PortHopDto{}},
		// Written inline on the property in TypeScript, never named.
		{"NodePolicyDrawn.notDrawn", PolicyNotDrawn{}},
		{"RotateCertRequest", RotateCertRequest{}},
		{"RotateCertResponse", RotateCertResponse{}},
		{"ConfirmCertRequest", ConfirmCertRequest{}},
		{"ConfirmCertResponse", ConfirmCertResponse{}},
		{"CPUMetricsDto", CPUMetricsDto{}},
		{"MemoryMetricsDto", MemoryMetricsDto{}},
		{"DiskMetricsDto", DiskMetricsDto{}},
		{"HostMetricsResponse", HostMetricsResponse{}},
		{"UfwPortDto", UfwPortDto{}},
		{"UfwPortsResponse", UfwPortsResponse{}},
		{"ConnLogSourceCheck", ConnLogSourceCheck{}},
		{"ConnLogTraceResponse", ConnLogTraceResponse{}},
		{"ConnLogClearStep", ConnLogClearStep{}},
		{"ConnLogClearResult", ConnLogClearResult{}},
		{"ConnLogClearResponse", ConnLogClearResponse{}},
		{"NodeErrorResponse", ErrorResponse{}},
	}
}

// wireExcluded is the structs deliberately not compared, with the reason.
var wireExcluded = map[string]string{
	"GeoMissingResponse": "no interface in transport.ts: the panel reads this 409 body ad hoc " +
		"(ErrorResponse plus files); its keys are pinned by contract-mirror.test.ts in the panel",
	"AwgHandoff": "agent-internal: the amneziawg adapter's own view of ChainUserCoreAmneziawg " +
		"(1.x hand-off flattened to port/mark), built in dto.go from a ChainUserCore, never on the wire",
}

func TestWireShapesMatchTheSharedTypescript(t *testing.T) {
	ts := parseTypescript(t)

	for _, pair := range wirePairs() {
		goType := reflect.TypeOf(pair.go_)
		t.Run(goType.Name(), func(t *testing.T) {
			want, err := ts.keys(pair.ts)
			if err != nil {
				t.Fatalf("%v in %s - the panel side was renamed or moved, "+
					"and this Go struct is now talking to nobody", err, tsRelPath)
			}
			got := jsonTagNames(goType)

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

// The table must account for every struct of dto.go, and name nothing that is
// gone: a struct added without a pair would compare against nothing.
func TestEveryDtoStructIsPairedOrExcluded(t *testing.T) {
	src, err := os.ReadFile("dto.go")
	if err != nil {
		t.Fatalf("read dto.go: %v", err)
	}
	declared := map[string]bool{}
	for _, m := range regexp.MustCompile(`(?m)^type (\w+) struct`).FindAllStringSubmatch(string(src), -1) {
		declared[m[1]] = true
	}
	if len(declared) < 50 {
		t.Fatalf("found %d structs in dto.go, expected the whole contract", len(declared))
	}

	seen := map[string]bool{}
	for _, pair := range wirePairs() {
		seen[reflect.TypeOf(pair.go_).Name()] = true
	}
	for name := range wireExcluded {
		if seen[name] {
			t.Errorf("%s is both paired and excluded", name)
		}
		seen[name] = true
	}
	for name := range declared {
		if !seen[name] {
			t.Errorf("dto.%s is neither compared with transport.ts nor excluded with a reason", name)
		}
	}
	for name := range seen {
		if !declared[name] {
			t.Errorf("%s is in the wire table but is not a struct of dto.go", name)
		}
	}
}

// Control: the comparison must be able to fail. A parser that quietly returned
// nothing would make every pair above pass by vacuum.
func TestTheTypescriptParserActuallyReadsFields(t *testing.T) {
	ts := parseTypescript(t)
	if len(ts.ifaces) < 70 {
		t.Fatalf("parsed %d interfaces from %s, expected the whole transport contract (75 when written)",
			len(ts.ifaces), tsRelPath)
	}
	creds, err := ts.keys("ProtocolCredentials")
	if err != nil || len(creds) < 10 {
		t.Fatalf("ProtocolCredentials parsed as %v (%v); the parser is not reading property names", creds, err)
	}
	// A property whose comment mentions another name must not be mistaken for
	// a property: the credentials block is full of prose naming other fields.
	for _, k := range creds {
		if !regexp.MustCompile(`^[a-z][A-Za-z0-9]*$`).MatchString(k) {
			t.Errorf("parser picked %q out of a doc comment: %v", k, creds)
		}
	}
	// An interface that extends another is read for its own members only.
	if own, err := ts.keys("NodeCoreRestarts"); err != nil || len(own) == 0 || contains(own, "crash") {
		t.Errorf("NodeCoreRestarts parsed as %v (%v), want its own members and not CoreRestarts's", own, err)
	}
	// The three shapes that are not a plain `export interface`.
	for spec, must := range map[string][]string{
		"NodePolicyAction":                         {"kind", "exit", "users"},
		"NodePolicyDrawn.notDrawn":                 {"exit", "direction"},
		"ChainUserCoreXray|ChainUserCoreAmneziawg": {"engine", "fragments", "tproxy", "tproxy3"},
	} {
		got, err := ts.keys(spec)
		if err != nil {
			t.Errorf("%s: %v", spec, err)
			continue
		}
		for _, k := range must {
			if !contains(got, k) {
				t.Errorf("%s parsed as %v, missing %q", spec, got, k)
			}
		}
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
	lineComment  = regexp.MustCompile(`(?m)(^|\s)//.*$`)
	ifaceHead    = regexp.MustCompile(`(?m)^export interface (\w+)[^{\n]*\{`)
	aliasHead    = regexp.MustCompile(`(?m)^export type (\w+)\s*=`)
	memberName   = regexp.MustCompile(`^\s*(?:readonly\s+)?(\w+)\??\s*:`)
)

// tsContract is transport.ts reduced to what the wire test needs: for each
// `export interface`, its own top-level members and their type text, and for
// each `export type`, the text after the `=`.
type tsContract struct {
	ifaces  map[string]map[string]string
	aliases map[string]string
}

// keys resolves a wirePair.ts spec to the sorted property names it stands for.
func (c tsContract) keys(spec string) ([]string, error) {
	set := map[string]bool{}
	add := func(members map[string]string) {
		for k := range members {
			set[k] = true
		}
	}
	switch {
	case strings.Contains(spec, "."):
		name, prop, _ := strings.Cut(spec, ".")
		typ, ok := c.ifaces[name][prop]
		if !ok {
			return nil, errNoSuch("property " + spec)
		}
		for _, obj := range objectLiterals(typ) {
			add(members(obj))
		}
	case strings.Contains(spec, "|"):
		for _, name := range strings.Split(spec, "|") {
			m, ok := c.ifaces[name]
			if !ok {
				return nil, errNoSuch("export interface " + name)
			}
			add(m)
		}
	default:
		if m, ok := c.ifaces[spec]; ok {
			add(m)
		} else if text, ok := c.aliases[spec]; ok {
			for _, obj := range objectLiterals(text) {
				add(members(obj))
			}
		} else {
			return nil, errNoSuch("export interface or type " + spec)
		}
	}
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out, nil
}

type errNoSuch string

func (e errNoSuch) Error() string { return "no `" + string(e) + "`" }

func parseTypescript(t *testing.T) tsContract {
	t.Helper()
	path, err := filepath.Abs(tsRelPath)
	if err != nil {
		t.Fatalf("resolve %s: %v", tsRelPath, err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v - the shared contract is where the panel side of this wire lives", path, err)
	}
	src := lineComment.ReplaceAllString(blockComment.ReplaceAllString(string(raw), ""), "$1")

	c := tsContract{ifaces: map[string]map[string]string{}, aliases: map[string]string{}}
	for _, m := range ifaceHead.FindAllStringSubmatchIndex(src, -1) {
		body, _ := balanced(src[m[1]-1:])
		c.ifaces[src[m[2]:m[3]]] = members(body)
	}
	for _, m := range aliasHead.FindAllStringSubmatchIndex(src, -1) {
		c.aliases[src[m[2]:m[3]]] = untilSemicolon(src[m[1]:])
	}
	return c
}

// balanced takes text starting at an opening brace and returns what is between
// it and its match.
func balanced(s string) (inner, rest string) {
	depth := 0
	for i, r := range s {
		switch r {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return s[1:i], s[i+1:]
			}
		}
	}
	return s[1:], ""
}

// untilSemicolon returns s up to the first `;` outside any brackets.
func untilSemicolon(s string) string {
	depth := 0
	for i, r := range s {
		switch r {
		case '{', '[', '(':
			depth++
		case '}', ']', ')':
			depth--
		case ';':
			if depth == 0 {
				return s[:i]
			}
		}
	}
	return s
}

// objectLiterals returns the bodies of the `{...}` groups at the top level of a
// type expression: the members of a union, or the element type of `{...}[]`.
func objectLiterals(typ string) []string {
	var out []string
	for i := 0; i < len(typ); i++ {
		if typ[i] != '{' {
			continue
		}
		inner, rest := balanced(typ[i:])
		out = append(out, inner)
		i = len(typ) - len(rest) - 1
	}
	return out
}

// members splits an object type's body into its top-level `name: type`
// members. A member ends at `;`, `,` or a newline outside any brackets or
// quotes, so a nested object, a one-line inline type and a multi-line union all
// belong to the member that opened them, and only the first-level names count.
func members(body string) map[string]string {
	out := map[string]string{}
	flush := func(part string) {
		if m := memberName.FindStringSubmatch(part); m != nil {
			out[m[1]] = part[len(m[0]):]
		}
	}
	depth, start := 0, 0
	var quote rune
	for i, r := range body {
		switch {
		case quote != 0:
			if r == quote {
				quote = 0
			}
		case r == '\'' || r == '"' || r == '`':
			quote = r
		case r == '{' || r == '[' || r == '(':
			depth++
		case r == '}' || r == ']' || r == ')':
			depth--
		case depth == 0 && (r == ';' || r == ',' || r == '\n'):
			flush(body[start:i])
			start = i + 1
		}
	}
	flush(body[start:])
	return out
}
