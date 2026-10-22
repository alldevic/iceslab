package singbox

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// ssmClient talks to the ssm-api service of a managed shadowsocks inbound
// (sing-box 1.13.14, service/ssmapi/api.go): users are added, changed and
// removed in the running process, and counted by username.
type ssmClient struct {
	base string
	http *http.Client
}

func newSSMClient(listen string) *ssmClient {
	return &ssmClient{base: "http://" + listen + "/server/v1", http: &http.Client{Timeout: 5 * time.Second}}
}

type ssmUser struct {
	UserName      string `json:"username"`
	Password      string `json:"uPSK,omitempty"`
	DownlinkBytes int64  `json:"downlinkBytes"`
	UplinkBytes   int64  `json:"uplinkBytes"`
}

func (c *ssmClient) do(ctx context.Context, method, path string, body any, want ...int) ([]byte, int, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, 0, err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, rd)
	if err != nil {
		return nil, 0, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	for _, w := range want {
		if resp.StatusCode == w {
			return out, resp.StatusCode, nil
		}
	}
	return out, resp.StatusCode, fmt.Errorf("ssm-api %s %s: %d %s", method, path, resp.StatusCode, strings.TrimSpace(string(out)))
}

// put makes the user's key what it should be: added when absent, changed
// when present (PUT answers 404 for a user it does not have).
func (c *ssmClient) put(ctx context.Context, name, uPSK string) error {
	_, code, err := c.do(ctx, http.MethodPut, "/users/"+name, ssmUser{Password: uPSK}, http.StatusNoContent, http.StatusNotFound)
	if err != nil {
		return err
	}
	if code == http.StatusNotFound {
		_, _, err = c.do(ctx, http.MethodPost, "/users", ssmUser{UserName: name, Password: uPSK}, http.StatusCreated)
	}
	return err
}

func (c *ssmClient) remove(ctx context.Context, name string) error {
	_, _, err := c.do(ctx, http.MethodDelete, "/users/"+name, nil, http.StatusNoContent, http.StatusNotFound)
	return err
}

func (c *ssmClient) list(ctx context.Context) ([]ssmUser, error) {
	out, _, err := c.do(ctx, http.MethodGet, "/users", nil, http.StatusOK)
	if err != nil {
		return nil, err
	}
	var resp struct {
		Users []ssmUser `json:"users"`
	}
	if err := json.Unmarshal(out, &resp); err != nil {
		return nil, fmt.Errorf("ssm-api users: %w", err)
	}
	return resp.Users, nil
}

// stats is every user's cumulative bytes, by username. Never ?clear: the
// counters stay cumulative and the panel keeps the snapshot, as for xray.
func (c *ssmClient) stats(ctx context.Context) (map[string]ssmUser, error) {
	out, _, err := c.do(ctx, http.MethodGet, "/stats", nil, http.StatusOK)
	if err != nil {
		return nil, err
	}
	var resp struct {
		Users []ssmUser `json:"users"`
	}
	if err := json.Unmarshal(out, &resp); err != nil {
		return nil, fmt.Errorf("ssm-api stats: %w", err)
	}
	m := make(map[string]ssmUser, len(resp.Users))
	for _, u := range resp.Users {
		m[u.UserName] = u
	}
	return m, nil
}

// sync makes the running inbound hold exactly `want` (name -> uPSK), waiting
// for the API to come up after a start.
func (c *ssmClient) sync(ctx context.Context, want map[string]string) error {
	var have []ssmUser
	var err error
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(100 * time.Millisecond) {
		if have, err = c.list(ctx); err == nil || time.Now().After(deadline) {
			break
		}
	}
	if err != nil {
		return err
	}
	for _, u := range have {
		if _, ok := want[u.UserName]; !ok {
			if err := c.remove(ctx, u.UserName); err != nil {
				return err
			}
		}
	}
	for name, key := range want {
		if err := c.put(ctx, name, key); err != nil {
			return err
		}
	}
	return nil
}
