package hysteria

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// A-265, stand 26.10 p.23: the agent wrote who connected and from where on
// every hysteria login, a connection log on the node. An accepted login now
// writes nothing at any level, Debug included. A refused one keeps the
// address, and fail2ban has to FIND it there: the line is written by the
// agent's own handler (JSON, main.go) and matched by the failregex the
// installer writes, read here from the script itself, so a field put before
// addr or another handler fails this test instead of silently ending the ban.
func TestAnAcceptedHysteriaLoginLeavesNoAddressAndNoUser(t *testing.T) {
	var buf bytes.Buffer
	a := newTestAdapter(t)
	a.logger = slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	_ = a.AddUser(core.User{UserID: "u-42", Username: "carol", HysteriaPassword: "secret-pw"})
	buf.Reset()

	call := func(auth string) {
		body := `{"addr":"198.51.100.23:5678","auth":"` + auth + `","tx":0}`
		a.handleAuthCallback(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/auth", strings.NewReader(body)))
	}

	call("secret-pw")
	if out := buf.String(); strings.Contains(out, "198.51.100.23") || strings.Contains(out, "u-42") || strings.Contains(out, "carol") {
		t.Fatalf("an accepted login was written down:\n%s", out)
	}

	call("guess")
	line := buf.String()
	failregex := fail2banHysteriaRegex(t)
	m := failregex.FindStringSubmatch(line)
	if m == nil {
		t.Fatalf("fail2ban's failregex %q does not match the refusal the agent writes:\n%s", failregex, line)
	}
	if !strings.HasPrefix(m[1], "198.51.100.23") {
		t.Fatalf("<HOST> took %q, not the refused address", m[1])
	}
}

// fail2banHysteriaRegex is the failregex of the installer's
// iceslab-hysteria.conf, as Go reads it. It is a regex already (fail2ban's
// own, the `(?::\d+)?` after <HOST> included), so it is compiled as written
// and only <HOST> is put in by hand, the way fail2ban does.
func fail2banHysteriaRegex(t *testing.T) *regexp.Regexp {
	t.Helper()
	script := readScript(t, "..", "..", "..", "..", "..", "scripts", "install-iceslab-node.sh")
	start := strings.Index(script, "/etc/fail2ban/filter.d/iceslab-hysteria.conf <<'EOF'")
	if start < 0 {
		t.Fatal("install-iceslab-node.sh writes no iceslab-hysteria.conf")
	}
	conf := script[start:]
	conf = conf[:strings.Index(conf, "\nEOF\n")]
	const key = "failregex = "
	at := strings.Index(conf, "\n"+key)
	if at < 0 {
		t.Fatal("iceslab-hysteria.conf has no failregex")
	}
	raw := conf[at+1+len(key):]
	raw = raw[:strings.Index(raw, "\n")]
	if !strings.Contains(raw, "<HOST>") {
		t.Fatalf("the failregex names no <HOST>: %q", raw)
	}
	return regexp.MustCompile(strings.Replace(raw, "<HOST>", "([0-9a-fA-F.:]+)", 1))
}
