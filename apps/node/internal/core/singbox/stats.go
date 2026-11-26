package singbox

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

const statsQueryTimeout = 5 * time.Second

// RunCmdFunc runs an external command and returns its combined output. The
// default shells out via os/exec. Stats no longer use it (see queryUserStats);
// kept as the one shell-out sing-box's package shares with the other adapters.
type RunCmdFunc func(ctx context.Context, name string, args ...string) ([]byte, error)

func defaultRunCmd(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

// StatsQueryFunc reads the cumulative per-user counters of the v2ray_api at
// addr. The default is queryUserStats; tests inject a fake.
type StatsQueryFunc func(ctx context.Context, addr string) (map[string]userByteCounters, error)

type userByteCounters struct {
	UplinkBytes   int64
	DownlinkBytes int64
}

// statsQueryPath is the gRPC method sing-box's v2ray_api serves. sing-box
// forked the stats service from v2ray-core and kept its package name,
// `v2ray.core.app.stats.command`; the xray CLI asks for
// `xray.app.stats.command` and gets "unknown service" (stand 26.11, f08-09),
// so the xray binary cannot be the client here.
const statsQueryPath = "/v2ray.core.app.stats.command.StatsService/QueryStats"

// statsClient speaks gRPC over cleartext HTTP/2 (the v2ray_api listens on
// loopback without TLS). net/http does h2c with prior knowledge since Go 1.24,
// so the agent stays free of a gRPC module.
var statsClient = func() *http.Client {
	t := &http.Transport{DisableKeepAlives: true}
	t.Protocols = new(http.Protocols)
	t.Protocols.SetUnencryptedHTTP2(true)
	return &http.Client{Transport: t}
}()

// queryUserStats reads per-user CUMULATIVE byte counters from a sing-box
// v2ray_api endpoint with a hand-written QueryStats call (pattern "user", no
// reset). Non-destructive: the panel deltas against its own snapshot, so a
// lost response never drops bytes (#5, same model as xray).
//
// Returns a map keyed by userId -> (uplink, downlink).
func queryUserStats(ctx context.Context, statsListen string) (map[string]userByteCounters, error) {
	if statsListen == "" {
		return nil, fmt.Errorf("stats address is empty")
	}
	ctx, cancel := context.WithTimeout(ctx, statsQueryTimeout)
	defer cancel()

	// QueryStatsRequest{pattern: "user"}, in a gRPC message frame.
	msg := appendBytesField(nil, 1, []byte("user"))
	frame := make([]byte, 5, 5+len(msg))
	binary.BigEndian.PutUint32(frame[1:], uint32(len(msg)))
	frame = append(frame, msg...)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://"+statsListen+statsQueryPath, bytes.NewReader(frame))
	if err != nil {
		return nil, fmt.Errorf("statsquery: %w", err)
	}
	req.Header.Set("Content-Type", "application/grpc")
	req.Header.Set("TE", "trailers")

	resp, err := statsClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("statsquery: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return nil, fmt.Errorf("statsquery: read: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("statsquery: http %d", resp.StatusCode)
	}
	// grpc-status is in the trailers, or in the headers of a trailers-only
	// reply (an error such as Unimplemented carries no body).
	status := resp.Trailer.Get("Grpc-Status")
	gmsg := resp.Trailer.Get("Grpc-Message")
	if status == "" {
		status, gmsg = resp.Header.Get("Grpc-Status"), resp.Header.Get("Grpc-Message")
	}
	if status != "0" {
		return nil, fmt.Errorf("statsquery: grpc status %q: %s", status, gmsg)
	}

	result := make(map[string]userByteCounters)
	for len(body) > 0 {
		if len(body) < 5 || body[0] != 0 {
			return nil, errors.New("statsquery: bad grpc frame")
		}
		n := int(binary.BigEndian.Uint32(body[1:5]))
		if n > len(body)-5 {
			return nil, errors.New("statsquery: truncated grpc frame")
		}
		if err := decodeQueryStatsResponse(body[5:5+n], result); err != nil {
			return nil, fmt.Errorf("statsquery: %w", err)
		}
		body = body[5+n:]
	}
	return result, nil
}

// decodeQueryStatsResponse reads QueryStatsResponse{repeated Stat stat = 1}
// with Stat{string name = 1; int64 value = 2}, adding every user counter into
// out. Unknown fields are skipped; a Stat of another shape is skipped rather
// than failing the batch.
func decodeQueryStatsResponse(b []byte, out map[string]userByteCounters) error {
	for len(b) > 0 {
		field, val, rest, err := nextField(b)
		if err != nil {
			return err
		}
		b = rest
		if field != 1 || val.bytes == nil {
			continue
		}
		var name string
		var value int64
		sb := val.bytes
		for len(sb) > 0 {
			f, v, r, err := nextField(sb)
			if err != nil {
				return err
			}
			sb = r
			switch {
			case f == 1 && v.bytes != nil:
				name = string(v.bytes)
			case f == 2 && v.bytes == nil:
				value = int64(v.varint)
			}
		}
		userID, dir, ok := parseStatName(name)
		if !ok {
			continue
		}
		c := out[userID]
		switch dir {
		case "uplink":
			c.UplinkBytes += value
		case "downlink":
			c.DownlinkBytes += value
		}
		out[userID] = c
	}
	return nil
}

type pbValue struct {
	varint uint64
	bytes  []byte // non-nil for a length-delimited field
}

// nextField reads one protobuf field: varint or length-delimited; the fixed
// widths are skipped (val is empty then).
func nextField(b []byte) (field uint64, val pbValue, rest []byte, err error) {
	key, n := binary.Uvarint(b)
	if n <= 0 {
		return 0, val, nil, errors.New("bad protobuf key")
	}
	b = b[n:]
	field = key >> 3
	switch key & 7 {
	case 0:
		v, n := binary.Uvarint(b)
		if n <= 0 {
			return 0, val, nil, errors.New("bad protobuf varint")
		}
		return field, pbValue{varint: v}, b[n:], nil
	case 1:
		if len(b) < 8 {
			return 0, val, nil, errors.New("truncated protobuf fixed64")
		}
		return field, val, b[8:], nil
	case 2:
		l, n := binary.Uvarint(b)
		if n <= 0 || l > uint64(len(b)-n) {
			return 0, val, nil, errors.New("bad protobuf length")
		}
		return field, pbValue{bytes: append([]byte{}, b[n:n+int(l)]...)}, b[n+int(l):], nil
	case 5:
		if len(b) < 4 {
			return 0, val, nil, errors.New("truncated protobuf fixed32")
		}
		return field, val, b[4:], nil
	}
	return 0, val, nil, errors.New("unsupported protobuf wire type " + strconv.Itoa(int(key&7)))
}

func appendBytesField(dst []byte, field uint64, v []byte) []byte {
	dst = binary.AppendUvarint(dst, field<<3|2)
	dst = binary.AppendUvarint(dst, uint64(len(v)))
	return append(dst, v...)
}

// parseStatName extracts (userId, "uplink"|"downlink") from a stat key like
// `user>>><userId>>>traffic>>>uplink`. ok=false on any other shape.
func parseStatName(name string) (userID, direction string, ok bool) {
	const sep = ">>>"
	parts := strings.Split(name, sep)
	if len(parts) != 4 || parts[0] != "user" || parts[2] != "traffic" {
		return "", "", false
	}
	if parts[3] != "uplink" && parts[3] != "downlink" {
		return "", "", false
	}
	return parts[1], parts[3], true
}
