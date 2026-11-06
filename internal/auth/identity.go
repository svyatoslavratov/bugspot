// Package auth decides who is behind a request (identity providers) and what they may do with
// the widget (policy). Providers run in the configured order; the first that recognizes the
// request wins. Unrecognized requests get no identity and see nothing unless the policy is public.
package auth

import (
	"context"
	"net/http"
	"slices"
)

// Provider names.
const (
	ProviderForward   = "forward"
	ProviderJWT       = "jwt"
	ProviderHeader    = "header"
	ProviderKey       = "key"
	ProviderAnonymous = "anonymous"
	// ProviderAgent marks API tokens; they bypass the policy and are limited by scopes.
	ProviderAgent = "agent"
)

// Identity is who made a request.
type Identity struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Roles    []string `json:"roles,omitempty"`
	Provider string   `json:"provider"`
	// Scopes are the rights of an agent token.
	Scopes []string `json:"-"`
	// CredentialID is set for agent tokens and access keys.
	CredentialID string `json:"-"`
}

// Authenticated reports whether a real identity provider (not the anonymous one) recognized it.
func (i *Identity) Authenticated() bool {
	return i != nil && i.ID != "" && i.Provider != ProviderAnonymous
}

// HasRole reports whether the identity carries role.
func (i *Identity) HasRole(role string) bool { return i != nil && slices.Contains(i.Roles, role) }

// HasScope reports whether an agent token has scope.
func (i *Identity) HasScope(scope string) bool {
	return i != nil && i.Provider == ProviderAgent && slices.Contains(i.Scopes, scope)
}

// Provider recognizes the user of a request. It returns nil, nil when the request is not its
// kind, and an error only when it could not decide (the next provider is then tried).
type Provider interface {
	Name() string
	Identify(ctx context.Context, r *http.Request) (*Identity, error)
}

// Chain runs providers in order.
type Chain []Provider

// Identify returns the first identity found, or nil.
func (c Chain) Identify(ctx context.Context, r *http.Request) (*Identity, []error) {
	var errs []error
	for _, p := range c {
		id, err := p.Identify(ctx, r)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		if id != nil {
			id.Provider = p.Name()
			return id, errs
		}
	}
	return nil, errs
}
