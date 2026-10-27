package shadowsocks

import "testing"

// The second xray process on the box keeps both its logs quiet as the first
// does (xray/loglevel_test.go): the error log at warning, and the ACCESS log,
// which `loglevel` does not govern and which goes to journald unless set, at
// none. Both ciphers render the same block; TestTheCoreAcceptsBothSsRenders
// asks the real core about these renders.
func TestTheSsCoreKeepsTheAccessLogOff(t *testing.T) {
	for _, tc := range ssCases {
		m := renderToMap(t, ssInbound(tc.method, tc.psk), ssUsers)
		log, _ := m["log"].(map[string]any)
		if log["loglevel"] != "warning" || log["access"] != "none" || log["dnsLog"] != false {
			t.Errorf("%s: log block %v, want loglevel warning, access none, dnsLog false", tc.method, log)
		}
	}
}
