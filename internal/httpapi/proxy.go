package httpapi

import (
	"net/http"
	"net/netip"
	"strings"
)

// trustedProxyIP only accepts X-Forwarded-For when the socket peer is trusted.
// Other forwarding headers are deliberately ignored. The first untrusted hop
// from the right is the client; anything farther left is that client's claim.
func trustedProxyIP(trusted []netip.Prefix) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r.RemoteAddr = forwardedClientIP(r, trusted)
			next.ServeHTTP(w, r)
		})
	}
}

func forwardedClientIP(r *http.Request, trusted []netip.Prefix) string {
	peer, err := netip.ParseAddrPort(r.RemoteAddr)
	var address netip.Addr
	if err == nil {
		address = peer.Addr()
	} else {
		address, err = netip.ParseAddr(r.RemoteAddr)
		if err != nil {
			return r.RemoteAddr
		}
	}
	address = address.WithZone("").Unmap()
	fallback := address.String()
	if !trustedProxy(address, trusted) {
		return fallback
	}
	values := r.Header.Values("X-Forwarded-For")
	if len(values) == 0 {
		return fallback
	}
	var chain []netip.Addr
	for _, value := range values {
		for _, hop := range strings.Split(value, ",") {
			ip, err := netip.ParseAddr(strings.TrimSpace(hop))
			if err != nil || ip.Zone() != "" {
				return fallback
			}
			chain = append(chain, ip.Unmap())
		}
	}
	for i := len(chain) - 1; i >= 0; i-- {
		if !trustedProxy(chain[i], trusted) {
			return chain[i].String()
		}
	}
	// An all-trusted chain contains no independently identified client.
	return fallback
}

func trustedProxy(address netip.Addr, trusted []netip.Prefix) bool {
	for _, prefix := range trusted {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}
