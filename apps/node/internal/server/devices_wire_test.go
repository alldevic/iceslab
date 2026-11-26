package server

import (
	"encoding/json"
	"testing"

	"github.com/icecompany-tech/iceslab/apps/node/internal/dto"
)

// The panel's `amneziawgPeers: []` means "no device left": it has to reach the
// adapter as an empty list, not as the absent field an older panel sends.
func TestAmneziawgPeers_EmptyIsNotAbsent(t *testing.T) {
	var withEmpty, without dto.AddUserRequest
	if err := json.Unmarshal([]byte(`{"userId":"u1","credentials":{"amneziawgPeers":[]}}`), &withEmpty); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(`{"userId":"u1","credentials":{}}`), &without); err != nil {
		t.Fatal(err)
	}
	if got := amneziawgPeers(withEmpty.Credentials.AmneziaWGPeers); got == nil || len(got) != 0 {
		t.Fatalf("[] arrived as %#v, want an empty non-nil list", got)
	}
	if got := amneziawgPeers(without.Credentials.AmneziaWGPeers); got != nil {
		t.Fatalf("an absent field arrived as %#v, want nil", got)
	}
	var one dto.AddUserRequest
	body := `{"userId":"u1","credentials":{"amneziawgPeers":[{"publicKey":"k","allowedIp":"10.0.0.2","allowedIp3":"10.1.0.2","wireguardAllowedIp":"10.2.0.2"}]}}`
	if err := json.Unmarshal([]byte(body), &one); err != nil {
		t.Fatal(err)
	}
	if got := amneziawgPeers(one.Credentials.AmneziaWGPeers); len(got) != 1 || got[0].AllowedIP3 != "10.1.0.2" || got[0].WireguardAllowedIP != "10.2.0.2" {
		t.Fatalf("a device: %#v", got)
	}
}
