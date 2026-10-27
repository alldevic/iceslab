package mtprotoproxy

import "testing"

// A realistic scrape, shaped exactly as make_metrics_pkt writes it
// (mtprotoproxy.py:1740) — HELP/TYPE lines, then one sample per user per
// metric, with metrics we do not consume interleaved.
const sampleScrape = `# HELP mtprotoproxy_connects counter
# TYPE mtprotoproxy_connects counter
mtprotoproxy_connects 41
# HELP mtprotoproxy_user_connects user connects
# TYPE mtprotoproxy_user_connects counter
mtprotoproxy_user_connects{user="alice"} 7
mtprotoproxy_user_connects{user="bob"} 2
# HELP mtprotoproxy_user_octets octets proxied for user
# TYPE mtprotoproxy_user_octets counter
mtprotoproxy_user_octets{user="alice"} 999999
# HELP mtprotoproxy_user_octets_from octets proxied from user
# TYPE mtprotoproxy_user_octets_from counter
mtprotoproxy_user_octets_from{user="alice"} 1024
mtprotoproxy_user_octets_from{user="bob"} 17
# HELP mtprotoproxy_user_octets_to octets proxied to user
# TYPE mtprotoproxy_user_octets_to counter
mtprotoproxy_user_octets_to{user="alice"} 4096
mtprotoproxy_user_octets_to{user="bob"} 33
`

func TestParsesPerUserTraffic(t *testing.T) {
	got, err := parseUserMetrics(sampleScrape)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("users = %d, want 2 (%v)", len(got), got)
	}
	if got["alice"].BytesIn != 1024 || got["alice"].BytesOut != 4096 {
		t.Errorf("alice = %+v, want in=1024 out=4096", *got["alice"])
	}
	if got["bob"].BytesIn != 17 || got["bob"].BytesOut != 33 {
		t.Errorf("bob = %+v, want in=17 out=33", *got["bob"])
	}
}

func TestIgnoresCombinedOctetsMetric(t *testing.T) {
	// `user_octets` is from+to already. Counting it as well would bill every
	// byte twice, and it sits directly above the two we do want.
	got, _ := parseUserMetrics(sampleScrape)
	if got["alice"].BytesIn+got["alice"].BytesOut != 1024+4096 {
		t.Errorf("alice total = %d, want 5120 — user_octets must not be summed in",
			got["alice"].BytesIn+got["alice"].BytesOut)
	}
}

func TestSkipsUnattributableSamples(t *testing.T) {
	// A user metric with no user label cannot be attributed to anybody. Folding
	// it into a total would put someone else's traffic on a buyer's bill.
	body := `mtprotoproxy_user_octets_from 500
mtprotoproxy_user_octets_from{user=""} 600
mtprotoproxy_user_octets_from{user="alice"} 7
`
	got, err := parseUserMetrics(body)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got["alice"].BytesIn != 7 {
		t.Errorf("got %v, want only alice=7", got)
	}
}

func TestSurvivesUnknownAndMalformedLines(t *testing.T) {
	// Upstream adds metrics; a parser that errors on an unrecognised line turns
	// a routine version bump into "no traffic counted at all".
	body := `mtprotoproxy_brand_new_metric{some="label"} 1
this is not a metric line
mtprotoproxy_user_octets_from{user="alice"} notanumber
mtprotoproxy_user_octets_from{user="alice"} 12
mtprotoproxy_user_octets_to{unterminated="x
`
	got, err := parseUserMetrics(body)
	if err != nil {
		t.Fatal(err)
	}
	if got["alice"].BytesIn != 12 {
		t.Errorf("alice in = %d, want 12", got["alice"].BytesIn)
	}
}

func TestLabelValueHandlesEscapesAndCommas(t *testing.T) {
	// mtprotoproxy escapes `"` inside a label value and nothing else, so a value
	// may legitimately contain a comma. Splitting the label set on commas would
	// truncate it.
	body := `mtprotoproxy_user_octets_from{dc="2",user="a,b"} 5
mtprotoproxy_user_octets_to{user="quo\"te"} 9
`
	got, err := parseUserMetrics(body)
	if err != nil {
		t.Fatal(err)
	}
	if got["a,b"] == nil || got["a,b"].BytesIn != 5 {
		t.Errorf("comma-containing user name lost: %v", got)
	}
	if got[`quo"te`] == nil || got[`quo"te`].BytesOut != 9 {
		t.Errorf("escaped quote in user name lost: %v", got)
	}
}

func TestEmptyBodyIsNotAnError(t *testing.T) {
	// A proxy with no traffic yet scrapes to almost nothing. That is "no users
	// seen", not a failure — reporting it as one would mark the adapter
	// Degraded on a quiet node.
	got, err := parseUserMetrics("")
	if err != nil || len(got) != 0 {
		t.Errorf("got %v, %v; want empty and no error", got, err)
	}
}
