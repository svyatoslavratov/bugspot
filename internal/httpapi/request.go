package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/svyatoslavratov/bugspot/internal/auth"
	"github.com/svyatoslavratov/bugspot/internal/domain"
	"github.com/svyatoslavratov/bugspot/internal/secret"
)

// RequestHeader must be on every state-changing request from the widget. A page on another
// origin cannot add it without passing CORS, which is what stops CSRF.
const RequestHeader = "X-Bugspot-Request"

// caller is who sent the request and what they may do.
type caller struct {
	id    *auth.Identity
	perms auth.Permissions
}

func (c caller) author() domain.Author {
	kind := domain.AuthorUser
	if c.id.Provider == auth.ProviderAgent {
		kind = domain.AuthorAgent
	}
	return domain.Author{ID: c.id.ID, Name: c.id.Name, Kind: kind}
}

type handler func(w http.ResponseWriter, r *http.Request, c caller) error

// api resolves the caller, applies CSRF protection and rate limits, and turns errors into JSON.
func (s *Server) api(h handler, write bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, err := s.identify(r)
		if errors.Is(err, errInvalidToken) {
			writeError(w, http.StatusUnauthorized, "invalid_token", "the agent token is unknown, expired or revoked")
			return
		}
		if err != nil {
			s.o.Logger.Error("identify", "err", err)
			writeError(w, http.StatusInternalServerError, "internal", "internal error")
			return
		}
		agent := id != nil && id.Provider == auth.ProviderAgent
		if write && !agent {
			if r.Header.Get(RequestHeader) == "" {
				writeError(w, http.StatusForbidden, "csrf", "the "+RequestHeader+" header is required")
				return
			}
			if r.Header.Get("Sec-Fetch-Site") == "cross-site" && !s.origins[r.Header.Get("Origin")] {
				writeError(w, http.StatusForbidden, "csrf", "cross-site request from an origin that is not allowed")
				return
			}
		}
		key := "ip:" + s.clientIP(r)
		if id != nil && id.ID != "" {
			key = "id:" + id.Provider + ":" + id.ID
		}
		limiter := s.read
		if write {
			limiter = s.write
		}
		if !limiter.Allow(key) {
			w.Header().Set("Retry-After", "60")
			writeError(w, http.StatusTooManyRequests, "rate_limited", "too many requests, try again in a minute")
			return
		}
		c := caller{id: id}
		if s.o.Enabled {
			c.perms = s.o.Policy.For(id)
		}
		if err := h(w, r, c); err != nil {
			s.fail(w, err)
		}
	})
}

var (
	errForbidden = errors.New("forbidden")
	errTooLarge  = errors.New("too large")
	// errInvalidToken: a request that names an agent token must not fall back to another identity.
	errInvalidToken = errors.New("invalid agent token")
)

func (s *Server) fail(w http.ResponseWriter, err error) {
	var bad errBadRequest
	switch {
	case errors.As(err, &bad):
		writeError(w, http.StatusBadRequest, "bad_request", bad.msg)
	case errors.Is(err, domain.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "not found")
	case errors.Is(err, errForbidden):
		writeError(w, http.StatusForbidden, "forbidden", "not allowed")
	case errors.Is(err, domain.ErrConflict):
		writeError(w, http.StatusConflict, "conflict", "the change conflicts with the map: a screen merged into itself or into an unknown one, or a key that is taken")
	case errors.Is(err, errTooLarge):
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "the body is too large")
	default:
		s.o.Logger.Error("request failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "internal error")
	}
}

// identify checks an agent token first, then the identity providers.
func (s *Server) identify(r *http.Request) (*auth.Identity, error) {
	if token := agentToken(r); token != "" {
		return s.agent(r.Context(), token)
	}
	id, errs := s.o.Chain.Identify(r.Context(), r)
	for _, err := range errs {
		s.o.Logger.Warn("identity provider failed", "err", err)
	}
	return id, nil
}

func agentToken(r *http.Request) string {
	token := r.Header.Get(auth.TokenHeader)
	if token == "" {
		token, _ = strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	}
	if strings.HasPrefix(token, secret.AgentPrefix) {
		return token
	}
	return ""
}

func (s *Server) agent(ctx context.Context, token string) (*auth.Identity, error) {
	c, err := s.o.Store.CredentialByHash(ctx, secret.Hash(token))
	if errors.Is(err, domain.ErrNotFound) {
		return nil, errInvalidToken
	}
	if err != nil {
		return nil, err
	}
	if c.Kind != domain.CredentialAgent || !c.Active(s.o.Now()) {
		return nil, errInvalidToken
	}
	_ = s.o.Store.TouchCredential(ctx, c.ID, s.o.Now())
	return &auth.Identity{ID: "agent:" + c.ID, Name: c.Name, Provider: auth.ProviderAgent, Scopes: c.Scopes, CredentialID: c.ID}, nil
}
