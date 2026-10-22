//go:build !windows

package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/icecompany-tech/iceslab/apps/node/internal/chain"
	"github.com/icecompany-tech/iceslab/apps/node/internal/core"
	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
	"github.com/icecompany-tech/iceslab/apps/node/internal/payload"
)

// П-1: the panel drops a push request after 30 s and repeats it. The agent
// went on with a push whose context was the request's, so a drop between
// stopping the old chain and raising the new one failed the new one with
// "context canceled" and left the cascade down. Here the engine's check takes
// longer than the request lives (the 30 s scaled down: nothing in the agent
// counts them), the request is dropped in the middle, and the chain has to
// come up all the same.
func TestAPushIsCarriedThroughWhenItsRequestIsDropped(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "sing-box")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nexec sleep 30\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	life, stop := context.WithCancel(context.Background())
	t.Cleanup(stop)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	m := chain.New(chain.Config{
		BinaryPath: bin,
		ConfigPath: filepath.Join(dir, "chain", "config.json"),
		Logger:     logger,
		Lifetime:   life,
		Run: func(ctx context.Context, _ string, args ...string) ([]byte, error) {
			if len(args) > 0 && args[0] == "version" {
				return []byte("sing-box version 1.13.14\n"), nil
			}
			// A check that, like exec.CommandContext, dies with its context.
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(400 * time.Millisecond):
				return nil, nil
			}
		},
	})
	s, err := New(Config{Logger: logger, Payload: &payload.Payload{}, Chain: m})
	if err != nil {
		t.Fatal(err)
	}
	block := chainBlock()
	block.UserCore = nil
	body, _ := json.Marshal(dto.ApplyInboundsRequest{Chain: block})

	reqCtx, drop := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodPost, "/applyInbounds", strings.NewReader(string(body))).WithContext(reqCtx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.handleApplyInbounds(httptest.NewRecorder(), req)
	}()
	time.Sleep(100 * time.Millisecond)
	drop() // the panel gives up on the request
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the push never finished")
	}
	st := m.Status()
	if st == nil || !st.Running || st.Error != "" {
		t.Fatalf("the chain is not up after its push request was dropped: %+v", st)
	}
}

// slowCore takes its time over an inbound and counts how many pushes are in
// it at once.
type slowCore struct {
	fakeAdapter
	in, most atomic.Int32
}

func (c *slowCore) ApplyInbound(int, json.RawMessage) error {
	n := c.in.Add(1)
	defer c.in.Add(-1)
	for {
		m := c.most.Load()
		if n <= m || c.most.CompareAndSwap(m, n) {
			break
		}
	}
	time.Sleep(200 * time.Millisecond)
	return nil
}

// Two pushes at once (the panel's repeat while the first still runs) go one
// after the other, not through the cores together.
func TestTwoPushesAtOnceGoOneAfterTheOther(t *testing.T) {
	c := &slowCore{fakeAdapter: fakeAdapter{name: "xray", engine: "xray"}}
	s := newServerWith(t, core.CoreAdapter(c))
	body := `{"inbounds":[{"id":"i1","name":"vless","protocol":"xray","port":0,"config":{}}]}`
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rec := httptest.NewRecorder()
			s.routes().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/applyInbounds", strings.NewReader(body)))
			if rec.Code != http.StatusOK {
				t.Errorf("push: %d %s", rec.Code, rec.Body.String())
			}
		}()
	}
	wg.Wait()
	if most := c.most.Load(); most != 1 {
		t.Fatalf("%d pushes were in the core at once, want 1", most)
	}
}
