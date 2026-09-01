package mtprotoproxy

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
	"testing"
)

func newTestAdapter(t *testing.T) *Adapter {
	t.Helper()
	a := New(Config{
		// No PythonPath: config-only mode, so nothing is spawned and the tests
		// exercise the state machine rather than a subprocess.
		ConfigPath: filepath.Join(t.TempDir(), "config.py"),
		Inbound:    InboundConfig{Domain: "www.cloudflare.com", ListenPort: 2083},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	return a
}

func TestAddUserRefusesAUserWithNoSecret(t *testing.T) {
	// Generating one here would produce a user who exists on the node and cannot
	// connect, because the link the buyer holds carries the panel's secret. That
	// failure looks like a network problem and is not.
	a := newTestAdapter(t)
	err := a.AddUser(core.User{UserID: "u1"})
	if err == nil {
		t.Fatal("accepted a user with no MtprotoSecret")
	}
	if !strings.Contains(err.Error(), "MtprotoSecret") {
		t.Errorf("error should name the missing field, got %v", err)
	}
	if len(a.users) != 0 {
		t.Error("the rejected user was still recorded")
	}
}

func TestAddUserRefusesAMalformedSecret(t *testing.T) {
	a := newTestAdapter(t)
	if err := a.AddUser(core.User{UserID: "u1", MtprotoSecret: "not-hex"}); err == nil {
		t.Fatal("accepted a secret that is not 32 hex chars")
	}
}

func TestUserSetRoundTrip(t *testing.T) {
	a := newTestAdapter(t)
	if err := a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA}); err != nil {
		t.Fatal(err)
	}
	if err := a.AddUser(core.User{UserID: "u2", MtprotoSecret: secretB}); err != nil {
		t.Fatal(err)
	}
	blob, err := os.ReadFile(a.cfg.ConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	got := runPy(t, blob)
	users := got["USERS"].(map[string]any)
	if users["u1"] != secretA || users["u2"] != secretB {
		t.Errorf("USERS on disk = %v", users)
	}

	if err := a.RemoveUser("u1"); err != nil {
		t.Fatal(err)
	}
	blob, _ = os.ReadFile(a.cfg.ConfigPath)
	users = runPy(t, blob)["USERS"].(map[string]any)
	if _, still := users["u1"]; still {
		t.Errorf("removed user still in USERS: %v", users)
	}
	if users["u2"] != secretB {
		t.Errorf("removing one user disturbed another: %v", users)
	}
}

func TestRepeatedPushDoesNotTriggerAReload(t *testing.T) {
	// The panel re-pushes the same user set routinely. Treating that as a change
	// would SIGUSR2 the process every time — the difference between a quiet
	// proxy and one re-reading its config all day.
	//
	// Note what is NOT asserted: that the file is left alone. The config is
	// rewritten every time, atomically, because skipping the write would be
	// indistinguishable from an unsafe in-place rewrite (see the write contract
	// in internal/core). Only the reload is skipped.
	a := newTestAdapter(t)
	u := core.User{UserID: "u1", MtprotoSecret: secretA}
	if err := a.AddUser(u); err != nil {
		t.Fatal(err)
	}
	first, err := os.ReadFile(a.cfg.ConfigPath)
	if err != nil {
		t.Fatal(err)
	}

	if err := a.AddUser(u); err != nil {
		t.Fatal(err)
	}
	_, changed, err := a.renderAndWrite()
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Error("an unchanged user set was reported as a change; the proxy would be signalled for nothing")
	}
	second, _ := os.ReadFile(a.cfg.ConfigPath)
	if string(first) != string(second) {
		t.Error("the same user set rendered differently twice")
	}

	// Removing somebody who is not there is a no-op too.
	if err := a.RemoveUser("nobody"); err != nil {
		t.Fatal(err)
	}
}

func TestAChangedUserSetIsReportedAsAChange(t *testing.T) {
	// The mirror of the test above: if this stopped reporting true, no reload
	// would ever fire and a new user would exist only in the file.
	a := newTestAdapter(t)
	if err := a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA}); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	a.users["u2"] = User{Name: "u2", Secret: secretB}
	a.mu.Unlock()
	if _, changed, err := a.renderAndWrite(); err != nil || !changed {
		t.Errorf("adding a user reported changed=%v, err=%v; want true, nil", changed, err)
	}
}

func TestApplyInboundRequiresDomainAndIgnoresInboundSecret(t *testing.T) {
	a := newTestAdapter(t)
	if err := a.ApplyInbound(2083, json.RawMessage(`{}`)); err == nil {
		t.Error("accepted an inbound with no domain")
	}
	// The panel still sends the mtg-shaped `secret`; on this engine the secret
	// belongs to the user. Accepting and ignoring it is what lets a node move to
	// this engine before the panel side changes.
	err := a.ApplyInbound(2083, json.RawMessage(`{"domain":"example.org","secret":"eedead"}`))
	if err != nil {
		t.Fatalf("ApplyInbound with a legacy secret field: %v", err)
	}
	if a.cfg.Inbound.Domain != "example.org" {
		t.Errorf("domain = %q", a.cfg.Inbound.Domain)
	}
	blob, _ := os.ReadFile(a.cfg.ConfigPath)
	if strings.Contains(string(blob), "eedead") {
		t.Error("the inbound-level secret leaked into the generated config")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats
// ─────────────────────────────────────────────────────────────────────────────

func TestGetStatsAttributesTrafficPerUser(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `mtprotoproxy_user_octets_from{user="u1"} 100
mtprotoproxy_user_octets_to{user="u1"} 200
mtprotoproxy_user_octets_from{user="u2"} 5
mtprotoproxy_user_octets_to{user="u2"} 7
`)
	}))
	defer srv.Close()

	a := newTestAdapter(t)
	a.cfg.MetricsURL = srv.URL
	a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA})
	a.AddUser(core.User{UserID: "u2", MtprotoSecret: secretB})

	st, err := a.GetStats()
	if err != nil {
		t.Fatal(err)
	}
	if !st.Cumulative {
		t.Error("counters are cumulative since process start; the panel must diff them")
	}
	if len(st.Users) != 2 {
		t.Fatalf("users = %d", len(st.Users))
	}
	byID := map[string]int64{}
	for _, u := range st.Users {
		byID[u.UserID+"/in"] = u.BytesIn
		byID[u.UserID+"/out"] = u.BytesOut
	}
	if byID["u1/in"] != 100 || byID["u1/out"] != 200 || byID["u2/in"] != 5 || byID["u2/out"] != 7 {
		t.Errorf("per-user attribution wrong: %v", byID)
	}
	if st.TotalBytesIn != 105 || st.TotalBytesOut != 207 {
		t.Errorf("totals = %d/%d, want 105/207", st.TotalBytesIn, st.TotalBytesOut)
	}
}

func TestGetStatsMarksDegradedRatherThanReportingZeros(t *testing.T) {
	// A zero is indistinguishable from "nobody used it", and the panel would
	// bank it as a real reading. Degraded says "no reading this poll".
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	a := newTestAdapter(t)
	a.cfg.MetricsURL = srv.URL
	a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA})

	st, err := a.GetStats()
	if err != nil {
		t.Fatal(err)
	}
	if !st.Degraded {
		t.Error("a failed scrape must set Degraded")
	}
	if len(st.Users) != 0 {
		t.Error("a failed scrape must not report user rows at all")
	}
}

func TestKnownUserWithNoRowReportsZero(t *testing.T) {
	// The endpoint answered and did not mention them: they have not used the
	// proxy since it started. That is a real zero, unlike a failed scrape.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, "mtprotoproxy_connects 3\n")
	}))
	defer srv.Close()

	a := newTestAdapter(t)
	a.cfg.MetricsURL = srv.URL
	a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA})

	st, _ := a.GetStats()
	if st.Degraded {
		t.Error("a successful scrape with no rows is not degraded")
	}
	if len(st.Users) != 1 || st.Users[0].BytesIn != 0 {
		t.Errorf("users = %+v", st.Users)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The crypto guard
// ─────────────────────────────────────────────────────────────────────────────

func TestRefusesToStartOnTheSlowCryptoBackend(t *testing.T) {
	// Measured on the target node: pyaes does 0.4 MB/s against cryptography's
	// 3777 MB/s. mtprotoproxy starts anyway and prints a suggestion, so a proxy
	// carrying media at dial-up speed would report itself healthy.
	failing := func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return []byte("pyaes\n"), errors.New("exit status 1")
	}
	err := assertFastCrypto(context.Background(), failing, "python3")
	if err == nil {
		t.Fatal("started on the bundled pyaes backend")
	}
	if !strings.Contains(err.Error(), "python3-cryptography") {
		t.Errorf("the error should say what to install, got: %v", err)
	}
}

func TestAcceptsAFastCryptoBackend(t *testing.T) {
	ok := func(_ context.Context, _ string, _ ...string) ([]byte, error) {
		return []byte("cryptography\n"), nil
	}
	if err := assertFastCrypto(context.Background(), ok, "python3"); err != nil {
		t.Fatalf("refused a working backend: %v", err)
	}
}

func TestCryptoProbeMatchesRealPython(t *testing.T) {
	// The probe mirrors mtprotoproxy's own selection order, so it is worth
	// running against a real interpreter rather than only a stub: a syntax error
	// in the probe would fail every start with a message about crypto.
	a := newTestAdapter(t)
	out, err := a.cfg.RunCmd(context.Background(), "python3", "-c", `
import sys
try:
    import cryptography; print("cryptography"); sys.exit(0)
except ImportError:
    pass
try:
    import Crypto; print("pycryptodome"); sys.exit(0)
except ImportError:
    pass
print("pyaes")
sys.exit(1)
`)
	if err != nil && !strings.Contains(string(out), "pyaes") {
		t.Fatalf("the probe itself failed rather than reporting a backend: %v (%s)", err, out)
	}
	got := strings.TrimSpace(string(out))
	if got != "cryptography" && got != "pycryptodome" && got != "pyaes" {
		t.Errorf("probe printed %q, expected one of the three backend names", got)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The backstops. This is what the whole engine change was for: on mtg an
// expired, disabled or deleted buyer keeps working forever, and so does anyone
// they forwarded the link to.
// ─────────────────────────────────────────────────────────────────────────────

func TestExpiryAndQuotaReachTheConfig(t *testing.T) {
	a := newTestAdapter(t)
	err := a.AddUser(core.User{
		UserID:            "u1",
		MtprotoSecret:     secretA,
		MtprotoExpiresAt:  time.Date(2026, 10, 4, 15, 35, 0, 0, time.UTC),
		MtprotoQuotaBytes: 500 * 1024 * 1024 * 1024,
	})
	if err != nil {
		t.Fatal(err)
	}
	blob, err := os.ReadFile(a.cfg.ConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	got := runPy(t, blob)

	exp := got["USER_EXPIRATIONS"].(map[string]any)
	// The day AFTER: mtprotoproxy cuts at 00:00 of the named date, so writing
	// 04/10 would end a subscription that runs to 15:35 about sixteen hours
	// early. The panel owns the precise cut.
	if exp["u1"] != "05/10/2026" {
		t.Errorf("USER_EXPIRATIONS[u1] = %v, want 05/10/2026", exp["u1"])
	}
	quota := got["USER_DATA_QUOTA"].(map[string]any)
	if int64(quota["u1"].(float64)) != 500*1024*1024*1024 {
		t.Errorf("USER_DATA_QUOTA[u1] = %v", quota["u1"])
	}
}

func TestNoLimitsMeansNoKeysAtAll(t *testing.T) {
	// A user on an unlimited plan must not acquire a quota or an expiry from
	// a zero value: mtprotoproxy treats a present key as a limit, so a zero
	// would read as "expired in year one" / "quota of nothing".
	a := newTestAdapter(t)
	if err := a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA}); err != nil {
		t.Fatal(err)
	}
	blob, _ := os.ReadFile(a.cfg.ConfigPath)
	got := runPy(t, blob)
	for _, k := range []string{"USER_EXPIRATIONS", "USER_DATA_QUOTA", "USER_MAX_TCP_CONNS"} {
		if _, present := got[k]; present {
			t.Errorf("%s emitted for a user with no limits: %v", k, got[k])
		}
	}
}

func TestConnectionCapIsNeverSetByThePush(t *testing.T) {
	// USER_MAX_TCP_CONNS reads like a device limit and is not one: it caps
	// CONCURRENT connections, and one Telegram client holds several. A cap that
	// disconnects paying users is worse than no cap, so nothing on the wire
	// carries it — an operator sets it deliberately or not at all.
	a := newTestAdapter(t)
	if err := a.AddUser(core.User{
		UserID:            "u1",
		MtprotoSecret:     secretA,
		MtprotoQuotaBytes: 1 << 20,
	}); err != nil {
		t.Fatal(err)
	}
	blob, _ := os.ReadFile(a.cfg.ConfigPath)
	if _, present := runPy(t, blob)["USER_MAX_TCP_CONNS"]; present {
		t.Error("the push set a connection cap; nothing on the wire should be able to")
	}
}

func TestChangingALimitReloads(t *testing.T) {
	// A renewed subscription changes only the expiry. If that did not count as
	// a change the node would keep cutting the user off at the old date.
	a := newTestAdapter(t)
	u := core.User{
		UserID: "u1", MtprotoSecret: secretA,
		MtprotoExpiresAt: time.Date(2026, 10, 4, 0, 0, 0, 0, time.UTC),
	}
	if err := a.AddUser(u); err != nil {
		t.Fatal(err)
	}
	u.MtprotoExpiresAt = time.Date(2026, 11, 4, 0, 0, 0, 0, time.UTC)
	if err := a.AddUser(u); err != nil {
		t.Fatal(err)
	}
	_, changed, err := a.renderAndWrite()
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Error("the second push did not land: the config still differs from the state")
	}
	got := runPy(t, mustRead(t, a.cfg.ConfigPath))
	if got["USER_EXPIRATIONS"].(map[string]any)["u1"] != "05/11/2026" {
		t.Errorf("expiry did not move: %v", got["USER_EXPIRATIONS"])
	}
}

func mustRead(t *testing.T, p string) []byte {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// ─────────────────────────────────────────────────────────────────────────────
// Seamless switch off mtg.
//
// A tg:// link is not a subscription. The Telegram client stored a server, a
// port and a secret, and there is nothing for it to re-fetch — so on the day mtg
// stops, every buyer who ever added the proxy has a saved entry that either
// still works or does not. Carrying mtg's one shared secret as an extra user is
// what makes it still work.
// ─────────────────────────────────────────────────────────────────────────────

// The live mtg secret this deployment serves, shape and all:
// "ee" + 16 raw bytes + hex("www.cloudflare.com").
const liveMtgSecret = "eed06ba72cc5f27206cb632a62a7b3865c7777772e636c6f7564666c6172652e636f6d"
const liveMtgRaw = "d06ba72cc5f27206cb632a62a7b3865c"
const liveDomain = "www.cloudflare.com"

func legacyAdapter(t *testing.T, accept bool) *Adapter {
	t.Helper()
	return New(Config{
		ConfigPath: filepath.Join(t.TempDir(), "config.py"),
		// No Domain: it arrives from the panel, which is also what makes the
		// ApplyInbound below a real change rather than a no-op the adapter
		// correctly skips.
		Inbound:            InboundConfig{ListenPort: 2083},
		AcceptLegacySecret: accept,
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func TestOldMtgLinksKeepWorkingDuringMigration(t *testing.T) {
	a := legacyAdapter(t, true)
	if err := a.ApplyInbound(2083, json.RawMessage(
		`{"domain":"`+liveDomain+`","secret":"`+liveMtgSecret+`"}`)); err != nil {
		t.Fatal(err)
	}
	if err := a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA}); err != nil {
		t.Fatal(err)
	}
	users := runPy(t, mustRead(t, a.cfg.ConfigPath))["USERS"].(map[string]any)

	// The raw half of mtg's secret, under the migration name. mtprotoproxy
	// rebuilds "ee" + this + hex(TLS_DOMAIN), which is byte-for-byte the secret
	// already saved in every buyer's Telegram.
	if users[LegacyUserName] != liveMtgRaw {
		t.Errorf("legacy secret missing or wrong: %v", users)
	}
	if users["u1"] != secretA {
		t.Errorf("the personal secret was disturbed: %v", users)
	}
}

func TestLegacySecretIsOffUnlessAskedFor(t *testing.T) {
	// It keeps alive a secret everybody has and nobody owns, so it has to be a
	// deliberate migration state rather than something a node drifts into.
	a := legacyAdapter(t, false)
	if err := a.ApplyInbound(2083, json.RawMessage(
		`{"domain":"`+liveDomain+`","secret":"`+liveMtgSecret+`"}`)); err != nil {
		t.Fatal(err)
	}
	blob := mustRead(t, a.cfg.ConfigPath)
	if strings.Contains(string(blob), liveMtgRaw) {
		t.Error("the legacy secret was carried without the flag being set")
	}
}

func TestLegacySecretForAnotherDomainIsRefused(t *testing.T) {
	// The domain is baked into the FakeTLS secret, so a secret minted for a
	// different one could not be accepted anyway. Carrying it would look like
	// migration cover while providing none.
	a := legacyAdapter(t, true)
	other := "ee" + liveMtgRaw + "6578616d706c652e636f6d" // example.com
	if err := a.ApplyInbound(2083, json.RawMessage(
		`{"domain":"`+liveDomain+`","secret":"`+other+`"}`)); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(mustRead(t, a.cfg.ConfigPath)), liveMtgRaw) {
		t.Error("a secret for another domain was carried as cover")
	}
}

func TestLegacyUserIsNotReportedToThePanel(t *testing.T) {
	// It is not a panel user. Handing the panel a userId it has never heard of
	// would risk the whole stats poll for a row nobody can be billed for; the
	// operator watches this cohort on the node's metrics endpoint instead.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `mtprotoproxy_user_octets_from{user="`+LegacyUserName+`"} 900
mtprotoproxy_user_octets_from{user="u1"} 5
mtprotoproxy_user_octets_to{user="u1"} 7
`)
	}))
	defer srv.Close()

	a := legacyAdapter(t, true)
	a.cfg.MetricsURL = srv.URL
	if err := a.ApplyInbound(2083, json.RawMessage(
		`{"domain":"`+liveDomain+`","secret":"`+liveMtgSecret+`"}`)); err != nil {
		t.Fatal(err)
	}
	if err := a.AddUser(core.User{UserID: "u1", MtprotoSecret: secretA}); err != nil {
		t.Fatal(err)
	}
	st, err := a.GetStats()
	if err != nil {
		t.Fatal(err)
	}
	for _, u := range st.Users {
		if u.UserID == LegacyUserName {
			t.Fatal("the legacy cohort was reported to the panel as a user")
		}
	}
	if len(st.Users) != 1 || st.Users[0].UserID != "u1" {
		t.Errorf("users = %+v", st.Users)
	}
	// It still lands in the NODE totals: nobody can be billed for it, but it is
	// real traffic, and a node mid-migration must not look quieter than it is.
	if st.TotalBytesIn != 900+5 {
		t.Errorf("TotalBytesIn = %d, want 905 (the legacy cohort plus u1)", st.TotalBytesIn)
	}
}

func TestRevokingAUserDoesNotDentTheNodeTotal(t *testing.T) {
	// The panel reads the node total as a cumulative counter and treats a DROP
	// as a core restart worth re-baselining. mtprotoproxy keeps a departed
	// user's counters in its stats after they leave USERS, so the scrape still
	// carries them — and summing only the CURRENT users would make every
	// revocation look like a restart, flattening the node's history exactly
	// when somebody is watching it.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `mtprotoproxy_user_octets_from{user="stays"} 100
mtprotoproxy_user_octets_to{user="stays"} 200
mtprotoproxy_user_octets_from{user="revoked"} 1000
mtprotoproxy_user_octets_to{user="revoked"} 2000
`)
	}))
	defer srv.Close()

	a := newTestAdapter(t)
	a.cfg.MetricsURL = srv.URL
	if err := a.AddUser(core.User{UserID: "stays", MtprotoSecret: secretA}); err != nil {
		t.Fatal(err)
	}
	// "revoked" is gone from USERS but still in the scrape.
	st, err := a.GetStats()
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Users) != 1 || st.Users[0].UserID != "stays" {
		t.Errorf("a revoked user must not be attributed: %+v", st.Users)
	}
	if st.TotalBytesIn != 1100 || st.TotalBytesOut != 2200 {
		t.Errorf("node totals = %d/%d, want 1100/2200 — the departed user's bytes still happened",
			st.TotalBytesIn, st.TotalBytesOut)
	}
}
