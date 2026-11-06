package auth

import (
	"context"
	"net/http"
	"regexp"
)

// AnonymousCookie keeps a random visitor id so an anonymous author can edit their own threads.
const AnonymousCookie = "bugspot_anon"

var anonID = regexp.MustCompile(`^[a-f0-9-]{36}$`)

// Anonymous recognizes everyone. The id comes from AnonymousCookie, which the session endpoint
// sets on the first visit; until then the id is empty and the visitor cannot write.
type Anonymous struct{}

// Name implements Provider.
func (Anonymous) Name() string { return ProviderAnonymous }

// Identify implements Provider.
func (Anonymous) Identify(_ context.Context, r *http.Request) (*Identity, error) {
	id := &Identity{Name: "Guest"}
	if c, err := r.Cookie(AnonymousCookie); err == nil && anonID.MatchString(c.Value) {
		id.ID = "anon:" + c.Value
	}
	return id, nil
}
