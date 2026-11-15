package auth

import (
	"context"
	"net/http"
	"regexp"
)

// AnonymousCookie keeps a random visitor id so an anonymous author can edit their own threads.
// LegacyAnonymousCookie is its name before the project was renamed from bugspot; it is still read.
const (
	AnonymousCookie       = "pinpath_anon"
	LegacyAnonymousCookie = "bugspot_anon"
)

// cookieOf returns the first of the named cookies the request has.
func cookieOf(r *http.Request, names ...string) (*http.Cookie, error) {
	for _, name := range names {
		if c, err := r.Cookie(name); err == nil {
			return c, nil
		}
	}
	return nil, http.ErrNoCookie
}

var anonID = regexp.MustCompile(`^[a-f0-9-]{36}$`)

// Anonymous recognizes everyone. The id comes from AnonymousCookie, which the session endpoint
// sets on the first visit; until then the id is empty and the visitor cannot write.
type Anonymous struct{}

// Name implements Provider.
func (Anonymous) Name() string { return ProviderAnonymous }

// Identify implements Provider.
func (Anonymous) Identify(_ context.Context, r *http.Request) (*Identity, error) {
	id := &Identity{Name: "Guest"}
	if c, err := cookieOf(r, AnonymousCookie, LegacyAnonymousCookie); err == nil && anonID.MatchString(c.Value) {
		id.ID = "anon:" + c.Value
	}
	return id, nil
}
