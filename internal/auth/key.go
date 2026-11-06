package auth

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/svyatoslavratov/bugspot/internal/domain"
	"github.com/svyatoslavratov/bugspot/internal/secret"
)

// KeyCookie holds an access key after the visitor opened a link with ?bugspot_key=….
const KeyCookie = "bugspot_key"

// Credentials looks up hashed credentials; the store implements it.
type Credentials interface {
	CredentialByHash(ctx context.Context, hash string) (domain.Credential, error)
	TouchCredential(ctx context.Context, id string, at time.Time) error
}

// Key recognizes people who got an access link: no account in the host app is needed. A key has
// a name (shown as the author) and roles for the policy, and can expire or be revoked.
type Key struct {
	Store Credentials
	Now   func() time.Time
}

// Name implements Provider.
func (k *Key) Name() string { return ProviderKey }

// Lookup returns the active key credential for a raw key.
func (k *Key) Lookup(ctx context.Context, raw string) (domain.Credential, bool, error) {
	if !strings.HasPrefix(raw, secret.KeyPrefix) {
		return domain.Credential{}, false, nil
	}
	c, err := k.Store.CredentialByHash(ctx, secret.Hash(raw))
	if errors.Is(err, domain.ErrNotFound) {
		return c, false, nil
	}
	if err != nil {
		return c, false, err
	}
	return c, c.Kind == domain.CredentialKey && c.Active(k.Now()), nil
}

// Identify implements Provider.
func (k *Key) Identify(ctx context.Context, r *http.Request) (*Identity, error) {
	cookie, err := r.Cookie(KeyCookie)
	if err != nil || cookie.Value == "" {
		return nil, nil
	}
	c, ok, err := k.Lookup(ctx, cookie.Value)
	if err != nil || !ok {
		return nil, err
	}
	_ = k.Store.TouchCredential(ctx, c.ID, k.Now())
	return &Identity{ID: "key:" + c.ID, Name: c.Name, Roles: c.Roles, CredentialID: c.ID}, nil
}
