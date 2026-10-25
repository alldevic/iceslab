package xray

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// What the core writes to disk about every connection: a disk-space question
// and, since the access log names the client's IP, the destination and the
// user, a privacy one.
//
// xray keeps two logs. At `info` the ERROR log writes a line per connection,
// so it stays at `warning`. The ACCESS log is not governed by `loglevel` at
// all: left empty it goes to stdout, which is journald, and journald mirrors
// into syslog, which the installer does not cap (3 GB on an operator's exit
// node, PR #43, 2026-08-17; the access lines found in the journal of
// aeza-de-01 with loglevel already at warning, 26.10). So `access` is `none`.
//
// Asserted on the VALUES and not only through the goldens: a golden says the
// render has not changed, which is the opposite of what is wanted the day
// somebody "temporarily" turns the logging back up to chase a bug. This test
// makes that a deliberate edit with a reason next to it.
func TestCoreLogsAtWarning(t *testing.T) {
	blob, err := renderConfig(validInbound(), policyUsers())
	if err != nil {
		t.Fatalf("renderConfig: %v", err)
	}
	assertQuietLog(t, blob)
}

// The render every pushed node gets (several inbounds, the cascade and the
// policy beside them) carries the same block, and the core takes it.
func TestTheMultiRenderKeepsTheAccessLogOff(t *testing.T) {
	blob, err := renderMultiConfig([]InboundConfig{vlessIn(), plainIn("socks", 1080)},
		[]xrayClient{alice, bob}, nil, 8080, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	assertQuietLog(t, blob)

	bin := os.Getenv("XRAY_BIN")
	if bin == "" {
		t.Skip("XRAY_BIN not set: the log block is not asked of the real core here")
	}
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, blob, 0o600); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command(bin, "run", "-test", "-c", path).CombinedOutput()
	if err != nil || !strings.Contains(string(out), "Configuration OK") {
		t.Fatalf("xray refused the log block: %v\n%s", err, out)
	}
}

func assertQuietLog(t *testing.T, blob []byte) {
	t.Helper()
	var doc struct {
		Log struct {
			Loglevel string `json:"loglevel"`
			Access   string `json:"access"`
			DNSLog   *bool  `json:"dnsLog"`
		} `json:"log"`
	}
	if err := json.Unmarshal(blob, &doc); err != nil {
		t.Fatalf("unmarshal config: %v", err)
	}
	if doc.Log.Loglevel != "warning" {
		t.Errorf("xray logs at %q; below warning the error log writes a line per connection, "+
			"journald mirrors it into syslog, and the node fills its own disk", doc.Log.Loglevel)
	}
	if doc.Log.Access != "none" {
		t.Errorf("log.access is %q, want \"none\": anything else writes every connection (client IP, "+
			"destination, user) to stdout, which is journald", doc.Log.Access)
	}
	if doc.Log.DNSLog == nil || *doc.Log.DNSLog {
		t.Errorf("log.dnsLog must be false, said: %v", doc.Log.DNSLog)
	}
}
