//go:build linux

package xray

import (
	"context"
	"fmt"
	"net"
	"os"
	"strings"
	"testing"
)

// xray writes why it died to stdout and leaves stderr empty (26.3.27: "Failed
// to start: ... listen tcp 0.0.0.0:P: bind: address already in use", exit 255),
// so the report used to read "exit status 255" with neither the line nor the
// process holding the port.
func TestFaultNamesWhoHoldsTheInboundPortWhenXrayReportsOnStdout(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()

	line := fmt.Sprintf("Failed to start: app/proxyman/inbound: failed to listen TCP on %d > "+
		"transport/internet/tcp: failed to listen TCP on %s > listen tcp %s: bind: address already in use",
		l.Addr().(*net.TCPAddr).Port, l.Addr(), l.Addr())
	a, _ := newAdapterWithBinary(t, writeTwoFacedXray(t, "echo '"+line+"'; exit 255"))

	if err := a.regenerateAndRestart(context.Background()); err == nil {
		t.Fatal("a core that died on a busy port was reported as started")
	}
	got := a.Fault()
	if !strings.Contains(got, "exit status 255") || !strings.Contains(got, "address already in use") ||
		!strings.Contains(got, "(held by ") || !strings.HasSuffix(got, fmt.Sprintf("(pid %d))", os.Getpid())) {
		t.Errorf("Fault() = %q, want the stdout line and this process as the holder", got)
	}
}
