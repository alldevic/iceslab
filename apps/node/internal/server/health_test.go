package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
	"github.com/icecompany-tech/iceslab/apps/node/internal/core/hysteria"
	"github.com/icecompany-tech/iceslab/apps/node/internal/core/singbox"
	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
	"github.com/icecompany-tech/iceslab/apps/node/internal/payload"
)

// The installer registers an adapter for every protocol the operator might
// switch on later, so a node normally runs with several cores idle, waiting for
// an inbound that may never come. Counting those as failures made every healthy
// node report `degraded` permanently (all four of the field fleet did), which
// meant the status no longer changed when a core actually died.

// fakeCore is the smallest adapter that satisfies the interface. It does not
// implement Provisionable, so it stands for the pre-existing behaviour.
type fakeCore struct {
	name    string
	engine  string
	running bool
}

func (f *fakeCore) Name() string { return f.name }
func (f *fakeCore) Engine() string {
	if f.engine != "" {
		return f.engine
	}
	return f.name
}
func (f *fakeCore) Start(context.Context) error             { return nil }
func (f *fakeCore) Stop(context.Context) error              { return nil }
func (f *fakeCore) AddUser(core.User) error                 { return nil }
func (f *fakeCore) RemoveUser(string) error                 { return nil }
func (f *fakeCore) GetStats() (*core.Stats, error)          { return &core.Stats{}, nil }
func (f *fakeCore) Healthy() bool                           { return f.running }
func (f *fakeCore) ApplyInbound(int, json.RawMessage) error { return nil }

// provisionableCore additionally reports whether it was ever configured.
type provisionableCore struct {
	fakeCore
	provisioned bool
}

func (p *provisionableCore) Provisioned() bool { return p.provisioned }

// healthBody is the raw JSON, for the assertions that are about the WIRE rather
// than about the decoded struct: a decoder cannot tell an absent key from an
// empty list once it has filled a slice in.
func healthBody(t *testing.T, adapters ...core.CoreAdapter) string {
	t.Helper()
	s, err := New(Config{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Payload:  &payload.Payload{},
		Adapters: adapters,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	rec := httptest.NewRecorder()
	s.handleHealth(rec, httptest.NewRequest("GET", "/healthz", nil))
	return rec.Body.String()
}

func health(t *testing.T, adapters ...core.CoreAdapter) dto.HealthcheckResponse {
	t.Helper()
	s, err := New(Config{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Payload:  &payload.Payload{},
		Adapters: adapters,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	rec := httptest.NewRecorder()
	s.handleHealth(rec, httptest.NewRequest("GET", "/healthz", nil))
	var out dto.HealthcheckResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode /healthz: %v (body %s)", err, rec.Body.String())
	}
	return out
}

// An engine that is not installed is a ROW, not a gap: installed false, idle
// rather than down, and holding no port, said as an empty list.
func TestAnAbsentEngineIsReportedAsNotInstalledAndHoldsNothing(t *testing.T) {
	body := healthBody(t,
		&provisionableCore{fakeCore{name: "xray", engine: "xray", running: true}, true},
		core.NewAbsent("tuic", "singbox"),
	)
	var got dto.HealthcheckResponse
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatal(err)
	}
	if got.Status != "ok" {
		t.Fatalf("status = %q: an engine that is not installed must not degrade the node", got.Status)
	}
	var sb *dto.CoreStatus
	for i := range got.Cores {
		if got.Cores[i].Engine == "singbox" {
			sb = &got.Cores[i]
		}
	}
	if sb == nil {
		t.Fatalf("the absent engine has no row: %s", body)
	}
	if sb.Installed == nil || *sb.Installed {
		t.Errorf("installed = %v, want false", sb.Installed)
	}
	if sb.Provisioned == nil || *sb.Provisioned {
		t.Errorf("provisioned = %v, want false", sb.Provisioned)
	}
	if sb.Running {
		t.Error("an absent engine reports itself running")
	}
	if !strings.Contains(body, `"engine":"singbox"`) || !strings.Contains(body, `"reservedPorts":[]`) {
		t.Errorf("an absent binary holds no port and must say so as []: %s", body)
	}
}

func TestUnconfiguredCoreDoesNotDegradeTheNode(t *testing.T) {
	got := health(t,
		&provisionableCore{fakeCore{name: "xray", running: true}, true},
		&provisionableCore{fakeCore{name: "shadowsocks", running: false}, false},
	)
	if got.Status != "ok" {
		t.Fatalf("status = %q, want ok: a core nobody configured is idle, not broken", got.Status)
	}
}

func TestConfiguredCoreThatIsDownDegradesTheNode(t *testing.T) {
	got := health(t,
		&provisionableCore{fakeCore{name: "xray", running: false}, true},
		&provisionableCore{fakeCore{name: "shadowsocks", running: false}, false},
	)
	if got.Status != "degraded" {
		t.Fatalf("status = %q, want degraded: a configured core is down", got.Status)
	}
}

// policyCore renders the node-level policy and resolver; xray is the only real
// adapter that does today, and that is the whole point of reporting it.
type policyCore struct {
	provisionableCore
}

func (p *policyCore) ApplyPolicy(json.RawMessage) error { return nil }
func (p *policyCore) ApplyDns(json.RawMessage) error    { return nil }

// The operator's policy is applied by the CORE, not by the node. Until the node
// said which of its cores render it, the panel showed the policy attached to a
// node whose cores ignore it, with nothing anywhere to say so.
func TestEachCoreReportsWhetherItRendersThePolicy(t *testing.T) {
	got := health(t,
		&policyCore{provisionableCore{fakeCore{name: "xray", engine: "xray", running: true}, true}},
		&provisionableCore{fakeCore{name: "tuic", engine: "singbox", running: true}, true},
		&fakeCore{name: "hysteria", engine: "hysteria", running: true},
	)
	byName := map[string]dto.CoreStatus{}
	for _, c := range got.Cores {
		byName[string(c.Name)] = c
	}
	if p := byName["xray"].RendersPolicy; p == nil || !*p {
		t.Error("xray renders the policy and has to say so")
	}
	if p := byName["tuic"].RendersPolicy; p == nil || *p {
		t.Error("tuic on sing-box renders no policy and has to say so, not stay silent")
	}
	if d := byName["xray"].RendersDns; d == nil || !*d {
		t.Error("the resolver has the same shape and the same answer for xray")
	}
	// hysteria here is a stand-in with no DnsReceiver at all; the real
	// adapter's answer per setting is TestHysteriaReportsWhatItExecutesOfTheResolver.
	if d := byName["hysteria"].RendersDns; d == nil || *d {
		t.Error("a core with no resolver receiver has to say it renders none")
	}
	// The engine, not only the protocol: one node can serve tuic and vless both
	// through sing-box, and the capability belongs to the engine.
	if e := byName["tuic"].Engine; e != "singbox" {
		t.Errorf("engine = %q, want singbox", e)
	}
	if e := byName["xray"].Engine; e != "xray" {
		t.Errorf("engine = %q, want xray", e)
	}
}

// 19.13: the real sing-box adapter, not a stand-in, reports that it renders the
// node's resolver, for every protocol it serves; the panel's "the core does not
// run it" mark goes by this field alone. Hysteria's own binary still does not.
func TestSingboxCoresReportThatTheyRenderTheResolver(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	var adapters []core.CoreAdapter
	for _, p := range []string{"tuic", "anytls", "xray", "hysteria", "shadowsocks", "shadowtls"} {
		adapters = append(adapters, singbox.New(singbox.Config{Protocol: p}, log))
	}
	adapters = append(adapters, &fakeCore{name: "hysteria", engine: "hysteria", running: true})
	got := health(t, adapters...)
	sb := 0
	for _, c := range got.Cores {
		if c.Engine == "singbox" {
			sb++
			if c.RendersDns == nil || !*c.RendersDns {
				t.Errorf("%s on sing-box does not report the resolver", c.Name)
			}
		}
	}
	if sb == 0 {
		t.Fatal("no sing-box core in the report")
	}
}

// versionedCore answers a module version and a tools version, as AmneziaWG does.
type versionedCore struct {
	fakeCore
	version, tools string
}

func (v *versionedCore) CoreVersion() string  { return v.version }
func (v *versionedCore) ToolsVersion() string { return v.tools }

// The AmneziaWG module and its tools come from different upstream tags, so they
// travel in two fields; a core with no separate tools says nothing about them.
func TestToolsVersionTravelsBesideTheCoreVersion(t *testing.T) {
	body := healthBody(t,
		&versionedCore{fakeCore{name: "amneziawg", running: true}, "1.0.20260611", "1.0.20260618-2"},
		&fakeCore{name: "hysteria", running: true},
	)
	if !strings.Contains(body, `"version":"1.0.20260611"`) ||
		!strings.Contains(body, `"toolsVersion":"1.0.20260618-2"`) {
		t.Errorf("module and tools versions must both be on the wire: %s", body)
	}
	if strings.Count(body, `"toolsVersion"`) != 1 {
		t.Errorf("only the core with separate tools reports a tools version: %s", body)
	}
}

// generationCore answers the AmneziaWG module generation, as the adapter does.
type generationCore struct {
	fakeCore
	generation int
}

func (g *generationCore) AwgProtocol() int      { return g.generation }
func (g *generationCore) AwgGenerations() []int { return []int{1, 3} }

// t07-1: the module generation travels on the amneziawg row, and a core that
// cannot tell (0) sends no key, so the panel reads "unknown" and not 1.
func TestAwgProtocolTravelsOnlyWhenKnown(t *testing.T) {
	body := healthBody(t,
		&generationCore{fakeCore{name: "amneziawg", running: true}, 3},
		&fakeCore{name: "hysteria", running: true},
	)
	if !strings.Contains(body, `"awgProtocol":3`) || strings.Count(body, `"awgProtocol"`) != 1 {
		t.Errorf("the generation belongs on the amneziawg row alone: %s", body)
	}
	// t07-6: and what the agent can carry, beside it.
	if !strings.Contains(body, `"awgGenerations":[1,3]`) || strings.Count(body, `"awgGenerations"`) != 1 {
		t.Errorf("the agent's interface generations belong on the amneziawg row: %s", body)
	}
	body = healthBody(t, &generationCore{fakeCore{name: "amneziawg", running: true}, 0})
	if strings.Contains(body, `"awgProtocol"`) {
		t.Errorf("an unknown generation must not travel: %s", body)
	}
}

// ipv6Core answers the awgIpv6 fact the way the adapter does: from a check it
// is given, in place of an `ip6tables -t nat -S` on the machine running the test.
type ipv6Core struct {
	fakeCore
	nat6 func() bool
}

func (c *ipv6Core) AwgIpv6() bool { return c.nat6() }

// Milestone 18.10: the amneziawg row carries awgIpv6 when the host can NAT
// IPv6, and says nothing when it cannot (the panel reads absent as no).
func TestAwgIpv6TravelsOnTheAmneziawgRowOnlyWhenTheHostCanNat(t *testing.T) {
	yes := healthBody(t,
		&ipv6Core{fakeCore{name: "amneziawg", running: true}, func() bool { return true }},
		&fakeCore{name: "hysteria", running: true},
	)
	if !strings.Contains(yes, `"awgIpv6":true`) || strings.Count(yes, `"awgIpv6"`) != 1 {
		t.Errorf("the fact belongs on the amneziawg row, true: %s", yes)
	}
	no := healthBody(t, &ipv6Core{fakeCore{name: "amneziawg", running: true}, func() bool { return false }})
	if strings.Contains(no, `"awgIpv6"`) {
		t.Errorf("a host without IPv6 NAT must send no fact: %s", no)
	}
	// An agent that cannot tell (a core that does not report it) sends none.
	if body := healthBody(t, &generationCore{fakeCore{name: "amneziawg", running: true}, 3}); strings.Contains(body, `"awgIpv6"`) {
		t.Errorf("a core that does not report the fact sent it: %s", body)
	}
}

// The machine's arch travels with every health answer: the panel's update
// command needs it to pick a release file and its sha256.
func TestHealthNamesTheMachineArch(t *testing.T) {
	got := health(t, &fakeCore{name: "xray", running: true})
	if got.Arch != core.MachineArch() {
		t.Errorf("arch = %q, want %q", got.Arch, core.MachineArch())
	}
}

// Adapters that don't report provisioning keep counting, so adding the field
// cannot silently hide a core that was being watched before.
func TestCoreThatDoesNotReportProvisioningStillCounts(t *testing.T) {
	got := health(t, &fakeCore{name: "hysteria", running: false})
	if got.Status != "degraded" {
		t.Fatalf("status = %q, want degraded: a non-reporting core must be assumed configured", got.Status)
	}
}

// The panel needs the per-core flag, not only the aggregate: it names the cores
// that are down, and must leave the idle ones out of that list.
func TestPerCoreFlagIsReported(t *testing.T) {
	got := health(t,
		&provisionableCore{fakeCore{name: "xray", running: true}, true},
		&provisionableCore{fakeCore{name: "shadowsocks", running: false}, false},
		&fakeCore{name: "hysteria", running: true},
	)
	byName := map[string]*bool{}
	for _, c := range got.Cores {
		byName[string(c.Name)] = c.Provisioned
	}
	if p := byName["xray"]; p == nil || !*p {
		t.Error("xray should report provisioned=true")
	}
	if p := byName["shadowsocks"]; p == nil || *p {
		t.Error("shadowsocks should report provisioned=false")
	}
	// Absent, not false: the panel must be able to tell "does not report" from
	// "not configured", or an older agent would look fully unconfigured.
	if p := byName["hysteria"]; p != nil {
		t.Error("a core that cannot report provisioning must omit the field")
	}
}

// portHoldingCore stands for a real adapter: it knows where its binary is and
// which sockets it opens for itself.
type portHoldingCore struct {
	fakeCore
	installed bool
	reserved  []core.ReservedPort
}

func (p *portHoldingCore) Installed() bool                    { return p.installed }
func (p *portHoldingCore) ReservedPorts() []core.ReservedPort { return p.reserved }

// A node holds ports nobody asked it to: the hysteria auth callback, the
// loopback gRPC sockets xray and sing-box open for per-user counters. The panel
// knew none of them, so a profile could be saved onto one and the node would
// then fail to bring one of the two listeners up, in its journal, hours later.
func TestCoresReportTheirOwnPorts(t *testing.T) {
	got := health(t, &portHoldingCore{
		fakeCore:  fakeCore{name: "hysteria", engine: "hysteria", running: true},
		installed: true,
		reserved: []core.ReservedPort{
			{Owner: "hysteria-auth", Port: 8080},
			{Owner: "hysteria-stats", Port: 9999},
		},
	})
	if len(got.Cores) != 1 {
		t.Fatalf("cores = %d, want 1", len(got.Cores))
	}
	c := got.Cores[0]
	if c.ReservedPorts == nil || len(*c.ReservedPorts) != 2 {
		t.Fatalf("reservedPorts = %+v, want both", c.ReservedPorts)
	}
	held := *c.ReservedPorts
	// The OWNER is a key, not a sentence: the panel is bilingual and writes the
	// words itself.
	if held[0].Owner != "hysteria-auth" || held[0].Port != 8080 {
		t.Errorf("first reserved port = %+v", held[0])
	}
	// And the transport travels rather than being assumed panel-side, the same
	// rule the port key follows: 443/TCP and 443/UDP are different sockets.
	if held[1].Transport != "tcp" {
		t.Errorf("transport = %q, want tcp", held[1].Transport)
	}
	if c.Installed == nil || !*c.Installed {
		t.Error("a core that knows its binary is present has to say so")
	}
}

// Absent is not false. An adapter that does not implement the interfaces must
// leave both fields out, so a panel can tell "this agent does not report" from
// "this core holds nothing" and refuse to promise a port on the strength of it.
func TestACoreThatDoesNotReportPortsStaysSilent(t *testing.T) {
	got := health(t, &fakeCore{name: "xray", running: true})
	c := got.Cores[0]
	if c.ReservedPorts != nil {
		t.Errorf("reservedPorts = %+v, want absent", c.ReservedPorts)
	}
	if c.Installed != nil {
		t.Errorf("installed = %v, want absent", *c.Installed)
	}
}

// A core that is configured but NOT on the machine renders nothing, and the
// panel used to show such a node applying the operator's routing policy.
func TestInstalledIsSeparateFromProvisioned(t *testing.T) {
	got := health(t, &portHoldingCore{
		fakeCore:  fakeCore{name: "xray", engine: "xray", running: false},
		installed: false,
	})
	c := got.Cores[0]
	if c.Installed == nil || *c.Installed {
		t.Fatal("a core whose binary is missing has to say installed:false, not stay silent")
	}
	// It implements the interface and holds nothing, and that is an ANSWER: the
	// empty list travels. Silence is what a core says when it cannot speak, and
	// the panel treats the two differently on purpose, or a node running only
	// cores that reserve nothing could never be answered about with certainty.
	if c.ReservedPorts == nil {
		t.Fatal("an adapter that reserves nothing must say so with [], not stay silent")
	}
	if len(*c.ReservedPorts) != 0 {
		t.Errorf("reservedPorts = %+v, want empty", *c.ReservedPorts)
	}
}

// The empty list has to survive the JSON, not just the struct: `[]` and a
// missing key are the two states this whole field exists to tell apart, and a
// stray omitempty would collapse them again without failing anything else.
func TestAnEmptyReservationTravelsAsAListAndSilenceAsNothing(t *testing.T) {
	body := healthBody(t,
		&portHoldingCore{fakeCore: fakeCore{name: "naive", running: true}, installed: true},
	)
	if !strings.Contains(body, `"reservedPorts":[]`) {
		t.Errorf("an adapter holding nothing must send an empty list: %s", body)
	}

	body = healthBody(t, &fakeCore{name: "xray", running: true})
	if strings.Contains(body, "reservedPorts") {
		t.Errorf("an adapter that cannot speak must send no key at all: %s", body)
	}
}

// The chain field is absent until something runs a chain, and absence is what
// every node on the fleet says on the day this ships. A panel that read it as
// "chain down" would turn all of them red at once, so the wire has to make the
// difference visible: no key at all, not `"chain":{"running":false}`.
func TestHealthzSaysNothingAboutAChainThatDoesNotExist(t *testing.T) {
	body := healthBody(t, &fakeCore{name: "xray", engine: "xray", running: true})
	if strings.Contains(body, "chain") {
		t.Errorf("a node with no chain process must send no chain key: %s", body)
	}

	var out dto.HealthcheckResponse
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Chain != nil {
		t.Errorf("Chain = %+v, want nil", out.Chain)
	}
}

// Milestone 18.2: the healthcheck carries what the host can do with IPv6, and
// says nothing where the server has no probe.
func TestTheHealthcheckCarriesTheIPv6Block(t *testing.T) {
	s := newServerWith(t, &fakeAdapter{name: "xray", engine: "xray"})
	if h := healthOf(t, s); h.IPv6 != nil {
		t.Errorf("no probe, yet an ipv6 block: %+v", h.IPv6)
	}

	s.cfg.IPv6Probe = func() core.IPv6Facts {
		return core.IPv6Facts{Stack: true, Global: true, Addresses: []string{"2001:db8::1"}}
	}
	h := healthOf(t, s)
	if h.IPv6 == nil || !h.IPv6.Stack || !h.IPv6.Global || len(h.IPv6.Addresses) != 1 || h.IPv6.Egress == nil || *h.IPv6.Egress {
		t.Errorf("ipv6 block %+v", h.IPv6)
	}

	// Milestone 18.5: egress follows the check.
	s.cfg.IPv6Probe = func() core.IPv6Facts {
		return core.IPv6Facts{Stack: true, Global: true, Egress: true, Addresses: []string{"2001:db8::1"}}
	}
	if h := healthOf(t, s); h.IPv6 == nil || h.IPv6.Egress == nil || !*h.IPv6.Egress {
		t.Errorf("a passing check must read egress true: %+v", h.IPv6)
	}

	// A host without IPv6: stack false, and the address list is [] on the wire,
	// not null.
	s.cfg.IPv6Probe = func() core.IPv6Facts { return core.IPv6Facts{} }
	rr := httptest.NewRecorder()
	s.routes().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if !strings.Contains(rr.Body.String(), `"ipv6":{"stack":false,"global":false,"addresses":[],"egress":false}`) {
		t.Errorf("body %s", rr.Body.String())
	}
}

// Milestone 18.4: the block names where the agent's own API listens, so the
// panel can hint at a node whose stack takes `::` while the API stayed IPv4.
func TestTheIPv6BlockNamesTheAPIListener(t *testing.T) {
	s := newServerWith(t, &fakeAdapter{name: "xray", engine: "xray"})
	s.cfg.IPv6Probe = func() core.IPv6Facts { return core.IPv6Facts{Stack: true} }
	s.cfg.Host = "0.0.0.0"
	if h := healthOf(t, s); h.IPv6 == nil || h.IPv6.ApiListen != "0.0.0.0" {
		t.Errorf("ipv6 block %+v", h.IPv6)
	}
}

// 19.14: the real hysteria adapter takes the resolver but has one general
// resolver and no choice by domain, so receiving a setting is not executing it:
// `rendersDns` is true for a general server (or none held), false when the
// setting has rules by domain or nothing this core can draw.
func TestHysteriaReportsWhatItExecutesOfTheResolver(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	cases := []struct {
		name, dns string
		want      bool
	}{
		{"no setting", ``, true},
		{"general server", `{"servers":[{"address":"1.1.1.1"}]}`, true},
		{"general server first of several", `{"servers":[{"address":"1.1.1.1"},{"address":"9.9.9.9"}]}`, true},
		{"domain rule only", `{"servers":[{"address":"10.0.0.2","domains":["corp.example"]}]}`, false},
		{"domain rule beside a general server", `{"servers":[{"address":"10.0.0.2","domains":["corp.example"]},{"address":"1.1.1.1"}]}`, false},
		{"a kind hysteria has no resolver for", `{"servers":[{"address":"quic://dns.example"}]}`, false},
	}
	for _, c := range cases {
		a := hysteria.New(hysteria.Config{}, log)
		if c.dns != "" {
			if err := a.ApplyDns(json.RawMessage(c.dns)); err != nil {
				t.Fatalf("%s: %v", c.name, err)
			}
		}
		got := health(t, a)
		if len(got.Cores) != 1 || got.Cores[0].RendersDns == nil {
			t.Fatalf("%s: no rendersDns in %+v", c.name, got.Cores)
		}
		if *got.Cores[0].RendersDns != c.want {
			t.Errorf("%s: rendersDns = %v, want %v", c.name, *got.Cores[0].RendersDns, c.want)
		}
	}
}
