package server

import (
	"bytes"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
	"github.com/icecompany-tech/iceslab/apps/node/internal/payload"
)

// A-265: every push leaves one line, how long it took and which cores it was
// handed, so the stand can measure the panel's applyInbounds timeout. Nothing
// about a user, a key or an address is in it.
func TestEveryPushSaysHowLongItTook(t *testing.T) {
	var log bytes.Buffer
	xry := &fakeAdapter{name: "xray", engine: "xray"}
	sb := &fakeAdapter{name: "xray", engine: "singbox"}
	srv, err := New(Config{
		Logger:   slog.New(slog.NewTextHandler(io.MultiWriter(&log), nil)),
		Payload:  &payload.Payload{NodeCertPem: "x", NodeKeyPem: "y", CACertPem: "z"},
		Adapters: []core.CoreAdapter{xry, sb},
	})
	if err != nil {
		t.Fatal(err)
	}

	body := `{"inbounds":[
		{"id":"i1","name":"vless-a","protocol":"xray","port":0,"config":{"realityPrivateKey":"SECRET-KEY"}},
		{"id":"i2","name":"vless-b","protocol":"xray","port":0,"config":{}},
		{"id":"i3","name":"vless-sb","protocol":"xray","engine":"singbox","port":0,"config":{}}]}`
	rr := httptest.NewRecorder()
	srv.routes().ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/applyInbounds", strings.NewReader(body)))
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rr.Code, rr.Body.String())
	}

	var line string
	for _, l := range strings.Split(log.String(), "\n") {
		if strings.Contains(l, "applyInbounds done in") {
			line = l
		}
	}
	if line == "" {
		t.Fatalf("no timing line in the log:\n%s", log.String())
	}
	if !regexp.MustCompile(`applyInbounds done in \d+ ms`).MatchString(line) || !strings.Contains(line, "level=INFO") {
		t.Errorf("the line does not say the duration at info: %s", line)
	}
	if !strings.Contains(line, "cores=\"[xray/singbox xray/xray]\"") || !strings.Contains(line, "chain=false") {
		t.Errorf("the line does not name the cores once each: %s", line)
	}
	if strings.Contains(line, "SECRET-KEY") || strings.Contains(line, "vless-a") {
		t.Errorf("the line carries config or names: %s", line)
	}
}

// A refused push says its time too: the slow case is often the failing one.
func TestARefusedPushSaysHowLongItTook(t *testing.T) {
	var log bytes.Buffer
	xry := &fakeAdapter{name: "xray", engine: "xray", failOnApply: "core rejected the config: boom"}
	srv, err := New(Config{
		Logger:   slog.New(slog.NewTextHandler(&log, nil)),
		Payload:  &payload.Payload{NodeCertPem: "x", NodeKeyPem: "y", CACertPem: "z"},
		Adapters: []core.CoreAdapter{xry},
	})
	if err != nil {
		t.Fatal(err)
	}
	rr := httptest.NewRecorder()
	srv.routes().ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/applyInbounds",
		strings.NewReader(`{"inbounds":[{"id":"i1","name":"x","protocol":"xray","port":0,"config":{}}]}`)))
	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("status %d", rr.Code)
	}
	if !strings.Contains(log.String(), "applyInbounds done in") {
		t.Fatalf("a refused push left no timing line:\n%s", log.String())
	}
}
