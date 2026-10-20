package httpapi

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"

	"github.com/bitofbytes-io/noted/internal/auth"
)

// Exercise the real router and OAuth callback against fake Google endpoints:
// the observable result is the IP passed to NewSession, not just helper output.
func TestGoogleCallbackRecordsOnlyTrustedForwardedIPs(t *testing.T) {
	trusted := []netip.Prefix{
		netip.MustParsePrefix("192.0.2.10/32"),
		netip.MustParsePrefix("192.0.2.11/32"),
		netip.MustParsePrefix("2001:db8::10/128"),
	}
	for _, test := range []struct {
		name      string
		peer      string
		trust     bool
		forwarded []string
		want      string
	}{
		{name: "default ignores spoofed headers", peer: "192.0.2.10:4444", forwarded: []string{"203.0.113.99"}, want: "192.0.2.10"},
		{name: "untrusted peer ignores spoofed headers", peer: "198.51.100.7:4444", trust: true, forwarded: []string{"203.0.113.99"}, want: "198.51.100.7"},
		{name: "trusted proxy forwards client", peer: "192.0.2.10:4444", trust: true, forwarded: []string{"198.51.100.7"}, want: "198.51.100.7"},
		{name: "untrusted hop stops forged leftmost address", peer: "192.0.2.10:4444", trust: true, forwarded: []string{"203.0.113.99, 198.51.100.7, 192.0.2.11"}, want: "198.51.100.7"},
		{name: "multiple header lines keep chain order", peer: "192.0.2.10:4444", trust: true, forwarded: []string{"203.0.113.99, 198.51.100.7", "192.0.2.11"}, want: "198.51.100.7"},
		{name: "malformed chain falls back", peer: "192.0.2.10:4444", trust: true, forwarded: []string{"198.51.100.7, unknown"}, want: "192.0.2.10"},
		{name: "malformed leftmost also falls back", peer: "192.0.2.10:4444", trust: true, forwarded: []string{"garbage, 198.51.100.7, 192.0.2.11"}, want: "192.0.2.10"},
		{name: "empty entry falls back", peer: "192.0.2.10:4444", trust: true, forwarded: []string{"198.51.100.7,,192.0.2.11"}, want: "192.0.2.10"},
		{name: "empty header line falls back", peer: "192.0.2.10:4444", trust: true, forwarded: []string{"198.51.100.7", ""}, want: "192.0.2.10"},
		{name: "address with port rejected", peer: "192.0.2.10:4444", trust: true, forwarded: []string{"198.51.100.7:1234"}, want: "192.0.2.10"},
		{name: "quoted address rejected", peer: "192.0.2.10:4444", trust: true, forwarded: []string{"\"198.51.100.7\""}, want: "192.0.2.10"},
		{name: "scoped IPv6 header rejected", peer: "192.0.2.10:4444", trust: true, forwarded: []string{"fe80::1%eth0"}, want: "192.0.2.10"},
		{name: "all trusted falls back to peer", peer: "192.0.2.10:4444", trust: true, forwarded: []string{"192.0.2.11, 192.0.2.10"}, want: "192.0.2.10"},
		{name: "other headers ignored even from proxy", peer: "192.0.2.10:4444", trust: true, want: "192.0.2.10"},
		{name: "IPv6 peer default", peer: "[2001:db8::10]:4444", forwarded: []string{"203.0.113.99"}, want: "2001:db8::10"},
		{name: "trusted IPv6 proxy and IPv6 client", peer: "[2001:db8::10]:4444", trust: true, forwarded: []string{"2001:db8:2::7, 192.0.2.11"}, want: "2001:db8:2::7"},
		{name: "mapped IPv4 socket normalized", peer: "[::ffff:192.0.2.10]:4444", trust: true, forwarded: []string{"::ffff:198.51.100.7, ::ffff:192.0.2.11"}, want: "198.51.100.7"},
		{name: "mapped IPv4 default normalized", peer: "[::ffff:198.51.100.7]:4444", want: "198.51.100.7"},
		{name: "bare peer address accepted", peer: "192.0.2.10", trust: true, forwarded: []string{"198.51.100.7"}, want: "198.51.100.7"},
		{name: "invalid peer never trusts headers", peer: "invalid-peer", trust: true, forwarded: []string{"198.51.100.7"}, want: "invalid-peer"},
	} {
		t.Run(test.name, func(t *testing.T) {
			google := newFakeGoogle(t)
			authenticator := &fakeAuthenticator{}
			handler := callbackHandler(authenticator, google)
			if test.trust {
				handler.config.TrustedProxyCIDRs = trusted
			}
			request := httptest.NewRequest(http.MethodGet, "/api/auth/google/callback?state=state-1&code=code-1", nil)
			request.RemoteAddr = test.peer
			request.AddCookie(&http.Cookie{Name: auth.StateCookieName, Value: "state-1", HttpOnly: true, Secure: true, SameSite: http.SameSiteLaxMode})
			for _, value := range test.forwarded {
				request.Header.Add("X-Forwarded-For", value)
			}
			request.Header.Set("X-Real-IP", "203.0.113.88")
			request.Header.Set("True-Client-IP", "203.0.113.77")
			request.Header.Set("Forwarded", "for=203.0.113.66")
			response := httptest.NewRecorder()
			newRouter(handler).ServeHTTP(response, request)
			if response.Code != http.StatusFound || !google.reached() || authenticator.sessionUserID != testUserID {
				t.Fatalf("callback did not create session: status=%d body=%s", response.Code, response.Body.String())
			}
			if authenticator.sessionIP != test.want {
				t.Fatalf("NewSession IP = %q, want %q", authenticator.sessionIP, test.want)
			}
		})
	}
}
