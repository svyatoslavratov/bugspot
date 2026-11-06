package auth

import (
	"context"
	"net"
	"net/http"
	"net/netip"
)

// Header trusts identity headers set by a reverse proxy that already authenticated the user
// (oauth2-proxy, Authelia, Traefik forward auth). Headers count only from trusted proxy
// addresses, so a client cannot forge them.
type Header struct {
	Map     Mapping
	Trusted []netip.Prefix
}

// Name implements Provider.
func (h *Header) Name() string { return ProviderHeader }

func (h *Header) trusted(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	addr = addr.Unmap()
	for _, p := range h.Trusted {
		if p.Contains(addr) {
			return true
		}
	}
	return false
}

// Identify implements Provider.
func (h *Header) Identify(_ context.Context, r *http.Request) (*Identity, error) {
	id := r.Header.Get(h.Map.ID)
	if id == "" || !h.trusted(r) {
		return nil, nil
	}
	name := r.Header.Get(h.Map.Name)
	if name == "" {
		name = id
	}
	var roles []string
	if h.Map.Roles != "" {
		roles = list(r.Header.Get(h.Map.Roles))
	}
	return &Identity{ID: id, Name: name, Roles: roles}, nil
}
