package auth

import (
	"context"
	"crypto"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// TokenHeader carries a JWT from the widget (or an agent token). It is not Authorization, so the
// token survives HTTP Basic Auth in front of a test stand.
const TokenHeader = "X-Bugspot-Token" //nolint:gosec // a header name, not a credential

// JWT verifies a short-lived token issued by the host application's backend. The page hands it
// to the widget (window.bugspotToken); the widget sends it in X-Bugspot-Token.
type JWT struct {
	// Secret verifies HS256 tokens; PublicKey verifies RS256 and ES256 tokens.
	Secret    []byte
	PublicKey crypto.PublicKey
	Issuer    string
	Audience  string
	Map       Mapping
	Leeway    time.Duration
}

// Name implements Provider.
func (j *JWT) Name() string { return ProviderJWT }

// bearer returns a token from X-Bugspot-Token or Authorization: Bearer, skipping agent tokens.
func bearer(r *http.Request) string {
	token := r.Header.Get(TokenHeader)
	if token == "" {
		if v, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer "); ok {
			token = strings.TrimSpace(v)
		}
	}
	return token
}

// Identify implements Provider.
func (j *JWT) Identify(_ context.Context, r *http.Request) (*Identity, error) {
	raw := bearer(r)
	if raw == "" || strings.Count(raw, ".") != 2 {
		return nil, nil
	}
	methods := []string{"HS256"}
	if j.PublicKey != nil {
		methods = []string{"RS256", "ES256"}
	}
	opts := []jwt.ParserOption{jwt.WithValidMethods(methods), jwt.WithLeeway(j.Leeway), jwt.WithExpirationRequired()}
	if j.Issuer != "" {
		opts = append(opts, jwt.WithIssuer(j.Issuer))
	}
	if j.Audience != "" {
		opts = append(opts, jwt.WithAudience(j.Audience))
	}
	claims := jwt.MapClaims{}
	_, err := jwt.ParseWithClaims(raw, claims, func(*jwt.Token) (any, error) {
		if j.PublicKey != nil {
			return j.PublicKey, nil
		}
		return j.Secret, nil
	}, opts...)
	if err != nil {
		// A bad, expired or foreign token is "not recognized": the next provider may know the user.
		return nil, nil //nolint:nilerr // not an error of the server
	}
	id := j.Map.fromDocument(map[string]any(claims))
	if id == nil {
		return nil, fmt.Errorf("jwt: no %q claim", j.Map.ID)
	}
	return id, nil
}
