package httpapi

import (
	"context"
	"crypto/tls"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/svyatoslavratov/pinpath/internal/auth"
	"github.com/svyatoslavratov/pinpath/internal/domain"
	"github.com/svyatoslavratov/pinpath/internal/secret"
	"github.com/svyatoslavratov/pinpath/internal/store/memory"
)

// brokenStore fails the health check and panics on lists.
type brokenStore struct{ *memory.Store }

func (brokenStore) Summary(context.Context, string, string, string) (domain.Summary, error) {
	return domain.Summary{}, errors.New("disk on fire")
}

func (brokenStore) ListThreads(context.Context, domain.ThreadFilter) ([]domain.Thread, int, error) {
	panic("boom")
}

func TestRootHealthAndPanics(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.Version = "v9.9.9" })
	if w := e.do(call{method: "GET", path: "/"}); w.Code != 200 || !strings.Contains(w.Body.String(), "v9.9.9") {
		t.Fatalf("root: %d %s", w.Code, w.Body)
	}
	broken := newEnv(t, func(o *Options) { o.Store = brokenStore{memory.New()} })
	if w := broken.do(call{method: "GET", path: "/healthz"}); w.Code != http.StatusServiceUnavailable {
		t.Fatalf("healthz with a broken store: %d", w.Code)
	}
	if w := broken.do(call{method: "GET", path: "/api/v1/threads", user: "anna"}); w.Code != 500 || !strings.Contains(w.Body.String(), `"internal"`) {
		t.Fatalf("panic: %d %s", w.Code, w.Body)
	}
	if w := broken.do(call{method: "GET", path: "/api/v1/threads/summary", user: "anna"}); w.Code != 500 {
		t.Fatalf("store error: %d", w.Code)
	}
	noWidget := newEnv(t, func(o *Options) { o.Widget = nil })
	if w := noWidget.do(call{method: "GET", path: "/widget.js"}); w.Code != 404 || !strings.Contains(w.Body.String(), "no_widget") {
		t.Fatalf("no widget: %d %s", w.Code, w.Body)
	}
	if w := noWidget.do(call{method: "GET", path: "/assets/app.js"}); w.Code != 404 {
		t.Fatalf("no assets: %d", w.Code)
	}
}

func TestAgentTokenStates(t *testing.T) {
	e := newEnv(t, nil)
	ctx := context.Background()
	expired, revoked, key := secret.New(secret.AgentPrefix), secret.New(secret.AgentPrefix), secret.New(secret.AgentPrefix)
	past := now.Add(-time.Hour)
	_ = e.store.CreateCredential(ctx, domain.Credential{ID: "x1", Kind: domain.CredentialAgent, Hash: secret.Hash(expired), Scopes: []string{"read"}, ExpiresAt: &past})
	_ = e.store.CreateCredential(ctx, domain.Credential{ID: "x2", Kind: domain.CredentialAgent, Hash: secret.Hash(revoked), Scopes: []string{"read"}, RevokedAt: &past})
	_ = e.store.CreateCredential(ctx, domain.Credential{ID: "x3", Kind: domain.CredentialKey, Hash: secret.Hash(key)})
	for name, token := range map[string]string{"expired": expired, "revoked": revoked, "a key as a token": key, "unknown": "ppt_nope"} {
		w := e.do(call{method: "GET", path: "/api/v1/threads", headers: map[string]string{auth.TokenHeader: token}})
		if w.Code != http.StatusUnauthorized || !strings.Contains(w.Body.String(), "invalid_token") {
			t.Errorf("%s: %d %s", name, w.Code, w.Body)
		}
	}
	w := e.do(call{method: "GET", path: "/api/v1/session", headers: map[string]string{"Authorization": "Bearer " + e.agent}})
	if s := decodeBody[sessionBody](t, w); !s.Visible || s.User.Provider != auth.ProviderAgent || s.Can.Comment || !s.Can.Reply {
		t.Fatalf("agent session via Authorization = %+v", s)
	}
}

func TestKeysAndCookies(t *testing.T) {
	e := newEnv(t, nil)
	w := e.do(call{method: "DELETE", path: "/api/v1/session/key"})
	// The cookie of a key opened before the rename from bugspot expires too.
	if c := w.Result().Cookies(); w.Code != http.StatusNoContent || len(c) != 2 || c[0].MaxAge >= 0 || c[1].Name != "bugspot_key" || c[1].MaxAge >= 0 {
		t.Fatalf("close key: %d %v", w.Code, c)
	}
	off := newEnv(t, func(o *Options) { o.Keys = nil })
	if w := off.do(call{method: "POST", path: "/api/v1/session/key", body: map[string]string{"key": off.key}}); w.Code != http.StatusForbidden {
		t.Fatalf("keys off: %d", w.Code)
	}
	if w := e.do(call{method: "POST", path: "/api/v1/session/key", raw: []byte(`{"key":1}`)}); w.Code != http.StatusBadRequest {
		t.Fatalf("bad key body: %d", w.Code)
	}

	s := New(Options{TrustedProxies: []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}})
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "10.0.0.2:1"
	r.Header.Set("X-Forwarded-Proto", "https")
	for _, c := range []struct {
		mode   string
		mutate func(*http.Request)
		want   bool
	}{
		{"true", nil, true},
		{"false", nil, false},
		{"auto", nil, true},
		{"auto", func(r *http.Request) { r.RemoteAddr = "203.0.113.1:1" }, false},
		{"auto", func(r *http.Request) { r.RemoteAddr = "203.0.113.1:1"; r.TLS = &tls.ConnectionState{} }, true},
		{"auto", func(r *http.Request) { r.RemoteAddr = "garbage" }, false},
	} {
		s.o.CookieSecure = c.mode
		req := r.Clone(context.Background())
		if c.mutate != nil {
			c.mutate(req)
		}
		if got := s.secure(req); got != c.want {
			t.Errorf("secure(%s, %s) = %v", c.mode, req.RemoteAddr, got)
		}
	}
	r.RemoteAddr = "not-an-address"
	if ip := s.clientIP(r); ip != "not-an-address" {
		t.Errorf("client ip of a bad address = %s", ip)
	}
}

func TestEditingAndReplies(t *testing.T) {
	e := newEnv(t, nil)
	th := e.create("anna", "/x")
	path := "/api/v1/threads/" + th.ID
	for name, body := range map[string]any{
		"nothing":     map[string]any{},
		"bad status":  map[string]any{"status": "done"},
		"bad kind":    map[string]any{"kind": "rant"},
		"empty body":  map[string]any{"body": "  "},
		"unknown key": map[string]any{"title": "x"},
	} {
		if w := e.do(call{method: "PATCH", path: path, user: "anna", body: body}); w.Code != http.StatusBadRequest {
			t.Errorf("%s: %d %s", name, w.Code, w.Body)
		}
	}
	edited := decodeBody[threadView](t, e.do(call{method: "PATCH", path: path, user: "anna", body: map[string]any{"body": "Новый текст", "kind": "question"}}))
	if edited.Body != "Новый текст" || edited.Kind != domain.KindQuestion {
		t.Fatalf("edit = %+v", edited)
	}
	if w := e.do(call{method: "PATCH", path: "/api/v1/threads/missing", user: "anna", body: map[string]any{"status": "fixed"}}); w.Code != http.StatusNotFound {
		t.Fatalf("missing thread: %d", w.Code)
	}
	if w := e.do(call{method: "POST", path: path + "/replies", user: "anna", body: map[string]any{"body": ""}}); w.Code != http.StatusBadRequest {
		t.Fatalf("empty reply: %d", w.Code)
	}
	if w := e.do(call{method: "POST", path: path + "/replies", user: "anna", raw: []byte("[]")}); w.Code != http.StatusBadRequest {
		t.Fatalf("reply not an object: %d", w.Code)
	}
	if w := e.do(call{method: "POST", path: "/api/v1/threads/missing/replies", user: "anna", body: map[string]any{"body": "x"}}); w.Code != http.StatusNotFound {
		t.Fatalf("reply to a missing thread: %d", w.Code)
	}
	if w := e.do(call{method: "POST", path: path + "/replies", body: map[string]any{"body": "x"}}); w.Code != http.StatusForbidden {
		t.Fatalf("anonymous reply: %d", w.Code)
	}
	if w := e.do(call{method: "GET", path: path}); w.Code != http.StatusForbidden {
		t.Fatalf("anonymous read: %d", w.Code)
	}
	if w := e.do(call{method: "DELETE", path: "/api/v1/threads/missing", user: "anna"}); w.Code != http.StatusNotFound {
		t.Fatalf("delete missing: %d", w.Code)
	}
	if w := e.do(call{method: "GET", path: path + "/screenshot", user: "anna"}); w.Code != http.StatusNotFound {
		t.Fatalf("no screenshot yet: %d", w.Code)
	}
	if w := e.do(call{method: "GET", path: "/api/v1/threads?kind=rant", user: "anna"}); w.Code != http.StatusBadRequest {
		t.Fatalf("bad kind filter: %d", w.Code)
	}
	if w := e.do(call{method: "GET", path: "/api/v1/threads?q=НОВЫЙ&kind=question&page=1&limit=500", user: "anna"}); w.Code != 200 || !strings.Contains(w.Body.String(), `"limit":100`) {
		t.Fatalf("search: %d %s", w.Code, w.Body)
	}

	for _, img := range [][]byte{
		append([]byte{0xff, 0xd8, 0xff, 0xe0}, make([]byte, 20)...),
		append([]byte("RIFF\x00\x00\x00\x00WEBPVP8 "), make([]byte, 20)...),
	} {
		if w := e.do(call{method: "PUT", path: path + "/screenshot", user: "anna", raw: img}); w.Code != http.StatusNoContent {
			t.Errorf("image %x: %d", img[:4], w.Code)
		}
	}
	if got := (errBadRequest{msg: "x"}).Error(); got != "x" {
		t.Fatalf("error text = %q", got)
	}
	rec := &statusRecorder{ResponseWriter: httptest.NewRecorder()}
	if rec.Unwrap() == nil {
		t.Fatal("Unwrap lost the writer")
	}
}

// What clients sent before the project was renamed from bugspot keeps working: the old headers,
// agent tokens and access keys with the old prefixes, and the old cookies.
func TestLegacyNames(t *testing.T) {
	e := newEnv(t, func(o *Options) {
		o.Policy.View = rules(t, "*")
		o.Policy.Comment = rules(t, "*")
	})
	legacyAgent := "bsp_" + strings.Repeat("a", 32)
	legacyKey := "bsk_" + strings.Repeat("b", 32)
	_ = e.store.CreateCredential(context.Background(), domain.Credential{ID: "a9", Kind: domain.CredentialAgent, Name: "Old agent",
		Hash: secret.Hash(legacyAgent), Scopes: []string{domain.ScopeRead}, CreatedAt: now})
	_ = e.store.CreateCredential(context.Background(), domain.Credential{ID: "k9", Kind: domain.CredentialKey, Name: "Old key",
		Hash: secret.Hash(legacyKey), CreatedAt: now})

	agent := decodeBody[sessionBody](t, e.do(call{method: "GET", path: "/api/v1/session", headers: map[string]string{"X-Bugspot-Token": legacyAgent}}))
	if agent.User == nil || agent.User.Name != "Old agent" {
		t.Fatalf("an old agent token in the old header = %+v", agent.User)
	}
	if w := e.do(call{method: "GET", path: "/api/v1/session", headers: map[string]string{"X-Bugspot-Token": "bsp_unknown"}}); w.Code != http.StatusUnauthorized {
		t.Fatalf("an unknown old token: %d", w.Code)
	}
	w := e.do(call{method: "POST", path: "/api/v1/threads", body: newThread("/a"), noCSRF: true,
		headers: map[string]string{"X-Bugspot-Request": "1", "Cookie": "bugspot_anon=0193a6b2-7d1c-7a3e-9f00-1234567890ab"}})
	if w.Code != http.StatusCreated {
		t.Fatalf("the old CSRF header and anonymous cookie: %d %s", w.Code, w.Body)
	}
	if th := decodeBody[threadView](t, w); th.Author.ID != "anon:0193a6b2-7d1c-7a3e-9f00-1234567890ab" {
		t.Fatalf("author from the old cookie = %+v", th.Author)
	}
	key := decodeBody[sessionBody](t, e.do(call{method: "POST", path: "/api/v1/session/key", body: map[string]string{"key": legacyKey}}))
	if key.User == nil || key.User.Name != "Old key" {
		t.Fatalf("an old access key = %+v", key.User)
	}
	if s := decodeBody[sessionBody](t, e.do(call{method: "GET", path: "/api/v1/session", headers: map[string]string{"Cookie": "bugspot_key=" + legacyKey}})); s.User == nil || s.User.Name != "Old key" {
		t.Fatalf("the old key cookie = %+v", s.User)
	}
	pre := e.do(call{method: "OPTIONS", path: "/api/v1/threads", headers: map[string]string{"Origin": "https://app.example.com", "Access-Control-Request-Method": "POST"}})
	if allowed := pre.Header().Get("Access-Control-Allow-Headers"); !strings.Contains(allowed, "X-Pinpath-Request") || !strings.Contains(allowed, "X-Bugspot-Request") {
		t.Fatalf("CORS headers = %q", allowed)
	}
}
