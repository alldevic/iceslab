package connlog

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
)

// A-265: the check and the clearing, with journalctl and the clock replaced.

type fakeJournal struct {
	lines   []string
	waitErr error
	args    []string
}

func (f *fakeJournal) stream(_ context.Context, name string, args ...string) (io.ReadCloser, func() error, error) {
	f.args = append([]string{name}, args...)
	return io.NopCloser(strings.NewReader(strings.Join(f.lines, "\n") + "\n")), func() error { return f.waitErr }, nil
}

func found(string) (string, error)   { return "/usr/bin/journalctl", nil }
func missing(string) (string, error) { return "", errors.New("not found") }

// A line of the agent's unit: the core's line is the msg of the agent's JSON.
const agentLine = `{"__REALTIME_TIMESTAMP":"1761400000000000","MESSAGE":"{\"time\":\"x\",\"level\":\"INFO\",\"msg\":\"2025/10/25 13:46:40 from 198.51.100.7:51234 accepted tcp:example.com:443 [vless-in >> direct] email: u1\",\"source\":\"xray\"}"}`

// A line of hysteria's own unit, written as hysteria writes it.
const hysteriaLine = `{"__REALTIME_TIMESTAMP":"1761300000000000","MESSAGE":"2025-10-24T10:00:00Z\tINFO\tclient connected\t{\"addr\": \"198.51.100.9:40000\", \"id\": \"u2\"}"}`

const otherLine = `{"__REALTIME_TIMESTAMP":"1761200000000000","MESSAGE":"{\"level\":\"INFO\",\"msg\":\"applyInbounds ok\"}"}`

func checker(t *testing.T, j *fakeJournal, look func(string) (string, error)) *Checker {
	t.Helper()
	return New(Config{
		Units:     Units("hysteria"),
		Tags:      []string{"iceslab-node", "hysteria"},
		SyslogDir: t.TempDir(),
		Stream:    j.stream,
		LookPath:  look,
	})
}

func TestJournalReadsEveryUnitAndStopsAtTheOldestConnectionLine(t *testing.T) {
	j := &fakeJournal{lines: []string{otherLine, hysteriaLine, agentLine}}
	c := checker(t, j, found)
	got := c.Trace(context.Background())

	want := []string{"journalctl", "--no-pager", "-o", "json", "--output-fields=MESSAGE",
		"-u", "iceslab-node.service", "-u", "hysteria.service", "-u", "hysteria-server.service"}
	if !reflect.DeepEqual(j.args, want) {
		t.Fatalf("args\n got %v\nwant %v", j.args, want)
	}
	if got.Present == nil || !*got.Present {
		t.Fatalf("present: %v", got.Present)
	}
	// hysteria's line comes first in the journal: its time is the answer.
	if got.Since == nil || *got.Since != time.UnixMicro(1761300000000000).UTC().Format(time.RFC3339) {
		t.Fatalf("since: %v", got.Since)
	}
	if !reflect.DeepEqual(got.Sources, []dto.ConnLogSource{dto.ConnLogJournal}) {
		t.Fatalf("sources: %v", got.Sources)
	}
	if got.Checks[1].State != "absent" {
		t.Fatalf("syslog with no files: %+v", got.Checks[1])
	}
}

func TestAHysteriaLineAloneIsFound(t *testing.T) {
	c := checker(t, &fakeJournal{lines: []string{hysteriaLine}}, found)
	if ch := c.Trace(context.Background()).Checks[0]; ch.State != "found" {
		t.Fatalf("%+v", ch)
	}
}

func TestNothingFoundIsANoOnlyWhenEverySourceWasRead(t *testing.T) {
	c := checker(t, &fakeJournal{lines: []string{otherLine}}, found)
	got := c.Trace(context.Background())
	if got.Present == nil || *got.Present {
		t.Fatalf("clean journal, no syslog: want false, got %v", got.Present)
	}

	c = checker(t, &fakeJournal{lines: []string{otherLine}, waitErr: errors.New("exit status 1: Failed to open journal")}, found)
	got = c.Trace(context.Background())
	if got.Present != nil {
		t.Fatalf("journal not read: want null, got %v", *got.Present)
	}
	if got.Checks[0].State != "failed" || !strings.Contains(got.Checks[0].Error, "Failed to open journal") {
		t.Fatalf("%+v", got.Checks[0])
	}
}

func TestNoJournalctlIsAbsent(t *testing.T) {
	j := &fakeJournal{}
	c := checker(t, j, missing)
	if ch := c.Trace(context.Background()).Checks[0]; ch.State != "absent" || j.args != nil {
		t.Fatalf("%+v, ran %v", ch, j.args)
	}
}

func writeGz(t *testing.T, path, body string) {
	t.Helper()
	var b bytes.Buffer
	w := gzip.NewWriter(&b)
	_, _ = w.Write([]byte(body))
	_ = w.Close()
	if err := os.WriteFile(path, b.Bytes(), 0o640); err != nil {
		t.Fatal(err)
	}
}

func TestSyslogOldestFileFirstOurTagsOnly(t *testing.T) {
	c := checker(t, &fakeJournal{}, missing)
	dir := c.cfg.SyslogDir
	// A foreign process with the same words does not count.
	writeGz(t, filepath.Join(dir, "syslog.3.gz"), "2026-10-01T09:00:00.000000+00:00 host sshd[1]: client connected from somewhere\n")
	writeGz(t, filepath.Join(dir, "syslog.2.gz"), "2026-10-05T09:00:00.000000+00:00 host hysteria[77]: 2026-10-05T09:00:00Z\tINFO\tclient connected\t{\"addr\": \"198.51.100.9:1\"}\n")
	_ = os.WriteFile(filepath.Join(dir, "syslog.1"), []byte("2026-10-10T09:00:00+00:00 host iceslab-node[5]: {\"msg\":\"from 1.2.3.4:5 accepted udp:x:53\"}\n"), 0o640)
	_ = os.WriteFile(filepath.Join(dir, "syslog"), []byte("2026-10-20T09:00:00+00:00 host CRON[9]: nothing\n"), 0o640)

	got := c.Trace(context.Background())
	ch := got.Checks[1]
	if ch.State != "found" || ch.Since == nil || *ch.Since != "2026-10-05T09:00:00Z" {
		t.Fatalf("%+v", ch)
	}
	if !reflect.DeepEqual(got.Sources, []dto.ConnLogSource{dto.ConnLogSyslog}) || got.Present == nil || !*got.Present {
		t.Fatalf("%+v", got)
	}
}

func TestSyslogClassicTimeTakesTheFileYear(t *testing.T) {
	mod := time.Date(2026, 1, 3, 0, 0, 0, 0, time.Local)
	got, ok := SyslogTime("Dec 30 23:59:01 host iceslab-node[1]: x", mod)
	if !ok || got.Year() != 2025 || got.Month() != time.December {
		t.Fatalf("%v %v", got, ok)
	}
	got, ok = SyslogTime("Jan  2 08:00:00 host iceslab-node[1]: x", mod)
	if !ok || got.Year() != 2026 {
		t.Fatalf("%v %v", got, ok)
	}
}

type recorder struct {
	calls [][]string
	fail  map[string]error
}

func (r *recorder) run(_ context.Context, name string, args ...string) ([]byte, error) {
	call := append([]string{name}, args...)
	r.calls = append(r.calls, call)
	if err := r.fail[strings.Join(call, " ")]; err != nil {
		return []byte("Failed to rotate"), err
	}
	return nil, nil
}

func TestClearRotatesThenVacuumsAndEmptiesSyslog(t *testing.T) {
	r := &recorder{}
	j := &fakeJournal{}
	c := checker(t, j, found)
	c.cfg.Run = r.run
	dir := c.cfg.SyslogDir
	_ = os.WriteFile(filepath.Join(dir, "syslog"), []byte("x iceslab-node[1]: accepted tcp:a\n"), 0o640)
	_ = os.WriteFile(filepath.Join(dir, "syslog.1"), []byte("y\n"), 0o640)
	writeGz(t, filepath.Join(dir, "syslog.2.gz"), "z\n")
	_ = os.WriteFile(filepath.Join(dir, "auth.log"), []byte("keep\n"), 0o640)

	got := c.Clear(context.Background())

	if want := [][]string{{"journalctl", "--rotate"}, {"journalctl", "--vacuum-time=1s"}}; !reflect.DeepEqual(r.calls, want) {
		t.Fatalf("calls %v", r.calls)
	}
	if got.Results[0].State != "cleared" || got.Results[1].State != "cleared" {
		t.Fatalf("%+v", got.Results)
	}
	var cmds []string
	for _, s := range got.Results[1].Steps {
		cmds = append(cmds, s.Command)
	}
	want := []string{"truncate " + filepath.Join(dir, "syslog"), "remove " + filepath.Join(dir, "syslog.1"), "remove " + filepath.Join(dir, "syslog.2.gz")}
	if !reflect.DeepEqual(cmds, want) {
		t.Fatalf("steps\n got %v\nwant %v", cmds, want)
	}
	if b, err := os.ReadFile(filepath.Join(dir, "syslog")); err != nil || len(b) != 0 {
		t.Fatalf("active syslog: %q %v", b, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "auth.log")); err != nil {
		t.Fatalf("auth.log is not ours to touch: %v", err)
	}
	// The check again, in the same answer.
	if got.After.Checks[1].State != "clean" {
		t.Fatalf("after: %+v", got.After.Checks[1])
	}
}

func TestAFailedRotateStillVacuumsAndSaysSo(t *testing.T) {
	r := &recorder{fail: map[string]error{"journalctl --rotate": errors.New("exit status 1")}}
	c := checker(t, &fakeJournal{}, found)
	c.cfg.Run = r.run
	got := c.Clear(context.Background()).Results[0]
	if len(r.calls) != 2 || got.State != "failed" || got.Steps[0].OK || !got.Steps[1].OK {
		t.Fatalf("calls %v, %+v", r.calls, got)
	}
	if !strings.Contains(got.Steps[0].Error, "Failed to rotate") {
		t.Fatalf("the output in words: %q", got.Steps[0].Error)
	}
	if res := c.Clear(context.Background()).Results[1]; res.State != "absent" {
		t.Fatalf("no syslog files: %+v", res)
	}
}

func TestUnitsTakeTheConfiguredHysteriaUnit(t *testing.T) {
	if got := Units("hy-custom"); got[len(got)-1] != "hy-custom.service" {
		t.Fatalf("%v", got)
	}
	if got := Units("hysteria"); len(got) != 3 {
		t.Fatalf("no duplicate: %v", got)
	}
}
