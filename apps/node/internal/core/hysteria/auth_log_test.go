package hysteria

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
)

// A-265, stand 26.10 p.23: the agent wrote who connected and from where on
// every hysteria login, a connection log on the node. An accepted login now
// writes nothing at any level, Debug included; a refused one keeps the address
// for fail2ban.
func TestAnAcceptedHysteriaLoginLeavesNoAddressAndNoUser(t *testing.T) {
	var buf bytes.Buffer
	a := newTestAdapter(t)
	a.logger = slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
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
	if out := buf.String(); !strings.Contains(out, "auth rejected") || !strings.Contains(out, "198.51.100.23") {
		t.Fatalf("a refused login lost the address fail2ban reads:\n%s", out)
	}
}
