package singbox

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

/*
f08-09 (stand 26.11): sing-box 1.13.14 serves the stats service as
v2ray.core.app.stats.command.StatsService; the xray CLI asked for
xray.app.stats.command.StatsService and every poll failed "unknown service", so
no sing-box user was ever counted. The agent now calls QueryStats itself. These
run it against a fake server that serves only the v2ray name, like sing-box.
*/

func pbVarint(dst []byte, v uint64) []byte { return binary.AppendUvarint(dst, v) }

func pbStat(name string, value int64) []byte {
	st := appendBytesField(nil, 1, []byte(name))
	if value != 0 { // proto3 leaves a zero out
		st = pbVarint(st, 2<<3)
		st = pbVarint(st, uint64(value))
	}
	return st
}

func grpcFrame(msg []byte) []byte {
	f := make([]byte, 5, 5+len(msg))
	binary.BigEndian.PutUint32(f[1:], uint32(len(msg)))
	return append(f, msg...)
}

// fakeSingbox serves QueryStats under the v2ray name only. gotPattern gets the
// pattern the agent asked for.
func fakeSingbox(t *testing.T, stats [][]byte, gotPattern *string) string {
	t.Helper()
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/grpc")
		if r.URL.Path != statsQueryPath {
			// Trailers-only, as grpc-go answers an unknown service.
			w.Header().Set("Grpc-Status", "12")
			w.Header().Set("Grpc-Message", "unknown service "+strings.Split(r.URL.Path, "/")[1])
			w.WriteHeader(http.StatusOK)
			return
		}
		if r.Header.Get("Content-Type") != "application/grpc" || r.ProtoMajor != 2 {
			t.Errorf("not a grpc request: proto %d, content-type %q", r.ProtoMajor, r.Header.Get("Content-Type"))
		}
		in, _ := io.ReadAll(r.Body)
		if gotPattern != nil && len(in) >= 7 {
			// frame(5) + field 1 key + len + pattern; no reset field, so no reset.
			*gotPattern = string(in[7:])
			if in[0] != 0 || int(binary.BigEndian.Uint32(in[1:5])) != len(in)-5 {
				t.Errorf("bad request frame % x", in)
			}
		}
		var msg []byte
		for _, s := range stats {
			msg = appendBytesField(msg, 1, s)
		}
		w.Header().Set("Trailer", "Grpc-Status")
		_, _ = w.Write(grpcFrame(msg))
		w.Header().Set("Grpc-Status", "0")
	}))
	srv.Config.Protocols = new(http.Protocols)
	srv.Config.Protocols.SetUnencryptedHTTP2(true)
	srv.Start()
	t.Cleanup(srv.Close)
	return strings.TrimPrefix(srv.URL, "http://")
}

func TestQueryUserStatsReadsTheV2rayService(t *testing.T) {
	var pattern string
	addr := fakeSingbox(t, [][]byte{
		pbStat("user>>>u1>>>traffic>>>uplink", 100),
		pbStat("user>>>u1>>>traffic>>>downlink", 5_000_000_000), // beyond int32
		pbStat("user>>>u2>>>traffic>>>uplink", 0),
		pbStat("inbound>>>x>>>traffic>>>uplink", 7), // not a user
		pbStat("user>>>u3>>>traffic>>>other", 9),    // not a direction
	}, &pattern)

	got, err := queryUserStats(context.Background(), addr)
	if err != nil {
		t.Fatalf("queryUserStats: %v", err)
	}
	if pattern != "user" {
		t.Errorf("pattern = %q, want user", pattern)
	}
	if got["u1"] != (userByteCounters{UplinkBytes: 100, DownlinkBytes: 5_000_000_000}) {
		t.Errorf("u1 = %+v", got["u1"])
	}
	if c, ok := got["u2"]; !ok || c != (userByteCounters{}) {
		t.Errorf("u2 = %+v, %v; a zero counter is still a user", c, ok)
	}
	if len(got) != 2 {
		t.Errorf("got %+v, want u1 and u2 only", got)
	}
}

func TestQueryUserStatsEmptyAnswerIsNoUsers(t *testing.T) {
	addr := fakeSingbox(t, nil, nil)
	got, err := queryUserStats(context.Background(), addr)
	if err != nil || len(got) != 0 {
		t.Fatalf("got %+v, %v; want an empty map", got, err)
	}
}

// The status of the call is read, not just the HTTP code: grpc-go answers an
// unknown service with 200 and grpc-status 12.
func TestQueryUserStatsSurfacesAGrpcError(t *testing.T) {
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/grpc")
		w.Header().Set("Grpc-Status", "12")
		w.Header().Set("Grpc-Message", "unknown service xray.app.stats.command.StatsService")
	}))
	srv.Config.Protocols = new(http.Protocols)
	srv.Config.Protocols.SetUnencryptedHTTP2(true)
	srv.Start()
	defer srv.Close()

	_, err := queryUserStats(context.Background(), strings.TrimPrefix(srv.URL, "http://"))
	if err == nil || !strings.Contains(err.Error(), "unknown service") {
		t.Fatalf("err = %v, want the grpc message", err)
	}
}

func TestQueryUserStatsRefusedConnectionIsAnError(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	_ = l.Close()
	if _, err := queryUserStats(context.Background(), addr); err == nil {
		t.Fatal("a closed port answered without an error")
	}
	if _, err := queryUserStats(context.Background(), ""); err == nil {
		t.Fatal("an empty address answered without an error")
	}
}

func TestDecodeQueryStatsResponseRejectsGarbage(t *testing.T) {
	for _, b := range [][]byte{{0x0a}, {0x0a, 0x05, 'a'}, {0x0b}, {0xff}} {
		if err := decodeQueryStatsResponse(b, map[string]userByteCounters{}); err == nil {
			t.Errorf("% x decoded without an error", b)
		}
	}
}
