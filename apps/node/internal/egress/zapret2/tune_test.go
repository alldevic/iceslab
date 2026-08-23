package zapret2

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Shaped after real blockcheckw output captured on a node behind RU DPI
// (rutracker.org, TLS1.3 blocked, ss-zapret2 v1.0.2, 2026-06-24): progress
// lines around a JSON object whose `strategies` are ranked best-first.
const tlsReport = `scanning rutracker.org ...
checking 42 strategies
{"domain":"rutracker.org","total":42,"working":3,"strategies":[
  {"protocol":"HTTPS/TLS1.3","args":"--payload=tls_client_hello --lua-desync=tcpseg:pos=0,1:ip_id=rnd:repeats=1","coverage":1},
  {"protocol":"HTTPS/TLS1.3","args":"--payload=tls_client_hello --lua-desync=fake","coverage":0.5}
]}
done`

// The ordinary outcome on an unfiltered uplink: the scan ran, nothing was
// blocked, so there is nothing to apply. NOT an error, and not the same as a
// scan that found no working strategy, which is why the counts travel too.
const openReport = `{"domain":"example.com","total":42,"working":0,"strategies":[]}`

func TestParseBlockcheckReports(t *testing.T) {
	t.Run("takes the top-ranked TLS strategy", func(t *testing.T) {
		tune, err := ParseBlockcheckReports([]byte(tlsReport))
		if err != nil {
			t.Fatalf("parse: %v", err)
		}
		if tune == nil {
			t.Fatal("expected a strategy")
		}
		if tune.Args != "--payload=tls_client_hello --lua-desync=tcpseg:pos=0,1:ip_id=rnd:repeats=1" {
			t.Errorf("took the wrong strategy: %q", tune.Args)
		}
		if tune.Domain != "rutracker.org" || tune.Total != 42 || tune.Working != 3 {
			t.Errorf("scan context lost: %+v", tune)
		}
	})

	t.Run("nothing blocked is not an error", func(t *testing.T) {
		tune, err := ParseBlockcheckReports([]byte(openReport))
		if err != nil || tune != nil {
			t.Errorf("open domain: got tune=%+v err=%v, want nil/nil", tune, err)
		}
	})

	t.Run("walks past a domain that needed nothing to the one that did", func(t *testing.T) {
		joined := openReport + "\n" + reportSeparator + "\n" + tlsReport
		tune, err := ParseBlockcheckReports([]byte(joined))
		if err != nil {
			t.Fatalf("parse: %v", err)
		}
		if tune == nil || tune.Domain != "rutracker.org" {
			t.Errorf("expected the blocked domain's strategy, got %+v", tune)
		}
	})

	// A strategy proven for one protocol says nothing about another, and the
	// http/quic selectors in the config are the panel's.
	t.Run("ignores a non-TLS strategy", func(t *testing.T) {
		report := `{"domain":"d","total":1,"working":1,"strategies":[{"protocol":"HTTP","args":"--lua-desync=http_methodeol"}]}`
		tune, err := ParseBlockcheckReports([]byte(report))
		if err != nil || tune != nil {
			t.Errorf("got tune=%+v err=%v, want nil/nil", tune, err)
		}
	})

	// The strategy lands inside the quoted NFQWS2_OPT block of a file zapret
	// sources as root. A quote in it would end that quoting.
	t.Run("refuses a strategy carrying shell quoting", func(t *testing.T) {
		report := `{"domain":"d","total":1,"working":1,"strategies":[{"protocol":"TLS","args":"--payload=x\" ; rm -rf /"}]}`
		tune, err := ParseBlockcheckReports([]byte(report))
		if err == nil || tune != nil {
			t.Errorf("got tune=%+v err=%v, want nil + an error", tune, err)
		}
	})

	t.Run("reports unusable output rather than guessing", func(t *testing.T) {
		if _, err := ParseBlockcheckReports([]byte("blockcheckw: connection refused")); err == nil {
			t.Error("expected an error for output with no JSON at all")
		}
		if _, err := ParseBlockcheckReports([]byte("{not json}")); err == nil {
			t.Error("expected an error for a malformed report")
		}
	})
}

// The panel owns the config; the node owns one line of it. Everything else the
// operator set on that line (which port, which hostlist) has to survive.
func TestMergeTunedTLS(t *testing.T) {
	body := `NFQWS2_ENABLE=1
NFQWS2_OPT="
--filter-tcp=80 --filter-l7=http --payload http_req --lua-desync=http_methodeol --new
--filter-tcp=443 --filter-l7=tls --payload=tls_client_hello --lua-desync=old --new
--filter-udp=443 --filter-l7=quic --payload=quic_initial --lua-desync=fake
"`
	tune := &Tune{Args: "--payload=tls_client_hello --lua-desync=new"}

	t.Run("replaces only the TLS strategy", func(t *testing.T) {
		got := MergeTunedTLS(body, tune)
		if !strings.Contains(got, "--filter-tcp=443 --filter-l7=tls --payload=tls_client_hello --lua-desync=new --new") {
			t.Errorf("TLS line not tuned:\n%s", got)
		}
		if !strings.Contains(got, "--filter-tcp=80 --filter-l7=http --payload http_req --lua-desync=http_methodeol --new") {
			t.Errorf("http line must be untouched:\n%s", got)
		}
		if !strings.Contains(got, "--filter-udp=443 --filter-l7=quic --payload=quic_initial --lua-desync=fake") {
			t.Errorf("quic line must be untouched:\n%s", got)
		}
		if strings.Contains(got, "--lua-desync=old") {
			t.Errorf("old strategy still present:\n%s", got)
		}
	})

	t.Run("keeps a hostlist the operator set on that line", func(t *testing.T) {
		scoped := strings.Replace(body,
			"--filter-tcp=443 --filter-l7=tls",
			"--filter-tcp=443 --filter-l7=tls --hostlist-domains=rutracker.org", 1)
		got := MergeTunedTLS(scoped, tune)
		if !strings.Contains(got, "--hostlist-domains=rutracker.org --payload=tls_client_hello --lua-desync=new --new") {
			t.Errorf("hostlist selector lost:\n%s", got)
		}
	})

	t.Run("a node that never scanned renders exactly what the panel sent", func(t *testing.T) {
		if got := MergeTunedTLS(body, nil); got != body {
			t.Errorf("nil tune must not touch the body")
		}
		if got := MergeTunedTLS("NFQWS2_ENABLE=1", tune); got != "NFQWS2_ENABLE=1" {
			t.Errorf("a body with no TLS line must come back unchanged")
		}
	})
}

// The two writers problem: a self-tuning node and a panel-managed channel used
// to overwrite each other's config. The merge happens where the file is
// written, so a push carries the tune and a tune survives the push.
func TestApply_MergesTuneIntoPushedConfig(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config")
	tunePath := filepath.Join(dir, "tune.json")
	if err := os.WriteFile(tunePath, []byte(tlsReport), 0o644); err != nil {
		t.Fatalf("write tune: %v", err)
	}
	rec := &recorder{}
	m := New(Config{
		ConfigPath: cfgPath,
		TunePath:   tunePath,
		UpCmd:      []string{"up"},
		RunCmd:     rec.run,
	}, testLogger())

	pushed := "NFQWS2_OPT=\"\n--filter-tcp=443 --filter-l7=tls --lua-desync=preset --new\n\""
	if _, err := m.Apply(true, pushed, ""); err != nil {
		t.Fatalf("apply: %v", err)
	}
	written, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if !strings.Contains(string(written), "--lua-desync=tcpseg:pos=0,1:ip_id=rnd:repeats=1") {
		t.Errorf("pushed config was written without the local tune:\n%s", written)
	}
	if got := m.LastTune(); got == nil || got.Domain != "rutracker.org" {
		t.Errorf("LastTune not reported for /healthz: %+v", got)
	}

	// Re-pushing the same config is still a no-op.
	callsBefore := len(rec.calls)
	if changed, err := m.Apply(true, pushed, ""); err != nil || changed {
		t.Errorf("identical push after tune: changed=%v err=%v", changed, err)
	}
	if len(rec.calls) != callsBefore {
		t.Errorf("no-op push restarted the service")
	}
}

// A scan finds a better strategy hours after the last push. Without a refresh
// it would sit in the file until an admin happened to edit something.
func TestRefresh_AppliesANewScanWithoutAPush(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config")
	tunePath := filepath.Join(dir, "tune.json")
	rec := &recorder{}
	m := New(Config{
		ConfigPath: cfgPath,
		TunePath:   tunePath,
		UpCmd:      []string{"up"},
		RunCmd:     rec.run,
	}, testLogger())

	pushed := "NFQWS2_OPT=\"\n--filter-tcp=443 --filter-l7=tls --lua-desync=preset --new\n\""
	if _, err := m.Apply(true, pushed, ""); err != nil {
		t.Fatalf("apply: %v", err)
	}
	// Nothing scanned yet: a refresh changes nothing.
	if changed, err := m.Refresh(); err != nil || changed {
		t.Errorf("refresh with no report: changed=%v err=%v", changed, err)
	}

	if err := os.WriteFile(tunePath, []byte(tlsReport), 0o644); err != nil {
		t.Fatalf("write tune: %v", err)
	}
	changed, err := m.Refresh()
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if !changed {
		t.Fatal("a fresh scan must reach zapret2 without waiting for a push")
	}
	written, _ := os.ReadFile(cfgPath)
	if !strings.Contains(string(written), "--lua-desync=tcpseg:pos=0,1:ip_id=rnd:repeats=1") {
		t.Errorf("refreshed config missing the new strategy:\n%s", written)
	}
	// And the refresh is idempotent once applied.
	if changed, err := m.Refresh(); err != nil || changed {
		t.Errorf("second refresh: changed=%v err=%v", changed, err)
	}
}

// A half-written or unreadable report must never block the push that carries
// the panel's config: the node stays on the strategy it was sent.
func TestApply_UnusableTuneFallsBackToThePushedConfig(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config")
	tunePath := filepath.Join(dir, "tune.json")
	if err := os.WriteFile(tunePath, []byte("{half-writ"), 0o644); err != nil {
		t.Fatalf("write tune: %v", err)
	}
	m := New(Config{
		ConfigPath: cfgPath,
		TunePath:   tunePath,
		UpCmd:      []string{"up"},
		RunCmd:     (&recorder{}).run,
	}, testLogger())

	pushed := "NFQWS2_OPT=\"\n--filter-tcp=443 --filter-l7=tls --lua-desync=preset --new\n\""
	if _, err := m.Apply(true, pushed, ""); err != nil {
		t.Fatalf("apply must not fail on a bad report: %v", err)
	}
	written, _ := os.ReadFile(cfgPath)
	if string(written) != pushed {
		t.Errorf("expected the pushed config verbatim, got:\n%s", written)
	}
	if m.LastTune() != nil {
		t.Errorf("a bad report must not be reported as a running strategy")
	}
}

// B2b: a new box should not spend its first hours on the generic preset while
// its first scan runs, when a sibling on the same uplink already knows what
// works. The panel suggests that strategy; the node runs it until it has
// measured its own, and then its own wins - the suggestion is a head start, not
// an instruction.
func TestApply_PanelStrategyIsASeedTheLocalScanOverrides(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config")
	tunePath := filepath.Join(dir, "tune.json")
	m := New(Config{
		ConfigPath: cfgPath,
		TunePath:   tunePath,
		UpCmd:      []string{"up"},
		RunCmd:     (&recorder{}).run,
	}, testLogger())

	pushed := "NFQWS2_OPT=\"\n--filter-tcp=443 --filter-l7=tls --lua-desync=preset --new\n\""

	// Nothing scanned here yet: the suggestion is what runs.
	if _, err := m.Apply(true, pushed, "--payload=tls_client_hello --lua-desync=suggested"); err != nil {
		t.Fatalf("apply: %v", err)
	}
	written, _ := os.ReadFile(cfgPath)
	if !strings.Contains(string(written), "--lua-desync=suggested") {
		t.Errorf("panel suggestion should run on an unscanned node:\n%s", written)
	}

	// The node scans and finds its own. That one was measured here.
	if err := os.WriteFile(tunePath, []byte(tlsReport), 0o644); err != nil {
		t.Fatalf("write tune: %v", err)
	}
	if _, err := m.Apply(true, pushed, "--payload=tls_client_hello --lua-desync=suggested"); err != nil {
		t.Fatalf("re-apply: %v", err)
	}
	written, _ = os.ReadFile(cfgPath)
	if !strings.Contains(string(written), "--lua-desync=tcpseg:pos=0,1:ip_id=rnd:repeats=1") {
		t.Errorf("a local scan must beat the suggestion:\n%s", written)
	}
	if strings.Contains(string(written), "--lua-desync=suggested") {
		t.Errorf("suggestion still present after a local scan:\n%s", written)
	}
}
