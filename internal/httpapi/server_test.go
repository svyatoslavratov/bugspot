package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/svyatoslavratov/bugspot/internal/auth"
	"github.com/svyatoslavratov/bugspot/internal/domain"
	"github.com/svyatoslavratov/bugspot/internal/secret"
	"github.com/svyatoslavratov/bugspot/internal/store/memory"
)

var now = time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)

type env struct {
	t     *testing.T
	store *memory.Store
	h     http.Handler
	agent string
	key   string
}

func rules(t *testing.T, s string) auth.Rules {
	r, err := auth.ParseRules(s)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// newEnv trusts identity headers from 192.0.2.1 (the httptest client), so tests pick users with
// X-User and X-Roles.
func newEnv(t *testing.T, mutate func(*Options)) *env {
	st := memory.New()
	trusted := []netip.Prefix{netip.MustParsePrefix("192.0.2.0/24")}
	keys := &auth.Key{Store: st, Now: func() time.Time { return now }}
	o := Options{
		Project: "demo", Enabled: true, Store: st,
		Chain:          auth.Chain{&auth.Header{Map: auth.Mapping{ID: "X-User", Roles: "X-Roles"}, Trusted: trusted}, keys, auth.Anonymous{}},
		Keys:           keys,
		Policy:         auth.Policy{View: rules(t, "authenticated"), Comment: rules(t, "authenticated"), Moderate: rules(t, "role:admin")},
		AllowedOrigins: []string{"https://app.example.com"}, TrustedProxies: trusted,
		CookieSecure: "auto", KeyTTL: time.Hour, ScreenshotMaxBytes: 1024, RateRead: 1000, RateWrite: 1000,
		Widget: fstest.MapFS{"widget.js": {Data: []byte("/*loader*/")}, "assets/app-1.js": {Data: []byte("app")}},
		Now:    func() time.Time { return now },
	}
	if mutate != nil {
		mutate(&o)
	}
	e := &env{t: t, store: st, h: New(o).Handler()}
	e.agent = secret.New(secret.AgentPrefix)
	_ = st.CreateCredential(context.Background(), domain.Credential{ID: "a1", Kind: domain.CredentialAgent, Name: "Claude",
		Hash: secret.Hash(e.agent), Scopes: []string{domain.ScopeRead, domain.ScopeReply, domain.ScopeStatus}, CreatedAt: now})
	e.key = secret.New(secret.KeyPrefix)
	_ = st.CreateCredential(context.Background(), domain.Credential{ID: "k1", Kind: domain.CredentialKey, Name: "Заказчик",
		Hash: secret.Hash(e.key), Roles: []string{"customer"}, CreatedAt: now})
	return e
}

type call struct {
	method, path, user, roles string
	body                      any
	raw                       []byte
	headers                   map[string]string
	noCSRF                    bool
}

func (e *env) do(c call) *httptest.ResponseRecorder {
	e.t.Helper()
	var body io.Reader
	switch {
	case c.raw != nil:
		body = bytes.NewReader(c.raw)
	case c.body != nil:
		data, _ := json.Marshal(c.body)
		body = bytes.NewReader(data)
	}
	r := httptest.NewRequest(c.method, c.path, body)
	if c.user != "" {
		r.Header.Set("X-User", c.user)
		r.Header.Set("X-Roles", c.roles)
	}
	if c.method != http.MethodGet && !c.noCSRF {
		r.Header.Set(RequestHeader, "1")
	}
	for k, v := range c.headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	e.h.ServeHTTP(w, r)
	return w
}

func decodeBody[T any](t *testing.T, w *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
		t.Fatalf("decode %s: %v", w.Body.String(), err)
	}
	return v
}

func newThread(route string) map[string]any {
	return map[string]any{"route": route, "url": "https://app.example.com/#" + route, "title": "Кампании",
		"body": "Поиск не по центру", "anchor": map[string]any{"selector": "#search"},
		"context": map[string]any{"viewport": map[string]int{"w": 1440, "h": 900}}}
}

func (e *env) create(user, route string) threadView {
	e.t.Helper()
	w := e.do(call{method: "POST", path: "/api/v1/threads", user: user, body: newThread(route)})
	if w.Code != http.StatusCreated {
		e.t.Fatalf("create: %d %s", w.Code, w.Body)
	}
	return decodeBody[threadView](e.t, w)
}

func TestSessionVisibility(t *testing.T) {
	e := newEnv(t, nil)
	hidden := e.do(call{method: "GET", path: "/api/v1/session"})
	if hidden.Code != 200 || strings.TrimSpace(hidden.Body.String()) != `{"visible":false}` {
		t.Fatalf("anonymous with an authenticated policy: %d %s", hidden.Code, hidden.Body)
	}
	if c := hidden.Result().Cookies(); len(c) != 0 {
		t.Fatalf("hidden session set cookies: %v", c)
	}
	s := decodeBody[sessionBody](t, e.do(call{method: "GET", path: "/api/v1/session", user: "anna", roles: "admin"}))
	if !s.Visible || s.User.ID != "anna" || !s.Can.Moderate || s.Limits.ScreenshotMaxBytes != 1024 {
		t.Fatalf("admin session = %+v", s)
	}

	off := newEnv(t, func(o *Options) { o.Enabled = false })
	if s := decodeBody[sessionBody](t, off.do(call{method: "GET", path: "/api/v1/session", user: "anna", roles: "admin"})); s.Visible {
		t.Fatal("disabled service shows the widget")
	}
	if w := off.do(call{method: "GET", path: "/api/v1/threads", user: "anna"}); w.Code != http.StatusForbidden {
		t.Fatalf("disabled service lists threads: %d", w.Code)
	}
}

func TestPublicAnonymousGetsCookieAndCanWrite(t *testing.T) {
	e := newEnv(t, func(o *Options) {
		o.Policy = auth.Policy{View: rules(t, "*"), Comment: rules(t, "*")}
	})
	w := e.do(call{method: "GET", path: "/api/v1/session"})
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != auth.AnonymousCookie || !cookies[0].HttpOnly {
		t.Fatalf("anonymous cookie = %v", cookies)
	}
	in := newThread("/x")
	in["authorName"] = "Пётр"
	w = e.do(call{method: "POST", path: "/api/v1/threads", body: in, headers: map[string]string{"Cookie": cookies[0].Name + "=" + cookies[0].Value}})
	if w.Code != http.StatusCreated {
		t.Fatalf("anonymous create: %d %s", w.Code, w.Body)
	}
	if v := decodeBody[threadView](t, w); v.Author.Name != "Пётр" || !v.Allowed.Edit {
		t.Fatalf("anonymous thread = %+v", v)
	}
	// Without the cookie the visitor has no id and cannot write.
	if w := e.do(call{method: "POST", path: "/api/v1/threads", body: newThread("/x")}); w.Code != http.StatusForbidden {
		t.Fatalf("anonymous without cookie: %d", w.Code)
	}
}

func TestThreadLifecycle(t *testing.T) {
	e := newEnv(t, nil)
	th := e.create("anna", "/campaigns")
	if th.Number != 1 || th.Status != domain.StatusOpen || !th.Allowed.Edit || !th.Allowed.Delete {
		t.Fatalf("created = %+v", th)
	}
	e.create("boris", "/authors")

	list := decodeBody[struct {
		Data []threadView `json:"data"`
		Meta pageMeta     `json:"meta"`
	}](t, e.do(call{method: "GET", path: "/api/v1/threads?route=/campaigns&status=open", user: "boris"}))
	if list.Meta.Total != 1 || list.Data[0].ID != th.ID || list.Data[0].Allowed.Edit || list.Data[0].Allowed.Delete {
		t.Fatalf("boris sees = %+v", list)
	}
	if w := e.do(call{method: "GET", path: "/api/v1/threads?status=done", user: "boris"}); w.Code != http.StatusBadRequest {
		t.Fatalf("unknown status filter: %d", w.Code)
	}

	byNumber := decodeBody[threadDetail](t, e.do(call{method: "GET", path: "/api/v1/threads/%231", user: "boris"}))
	if byNumber.ID != th.ID {
		t.Fatalf("thread #1 = %s, want %s", byNumber.ID, th.ID)
	}
	if w := e.do(call{method: "GET", path: "/api/v1/threads/99", user: "boris"}); w.Code != http.StatusNotFound {
		t.Fatalf("missing number: %d", w.Code)
	}

	// Someone else's thread: no edits, no status changes, no deletion.
	path := "/api/v1/threads/" + th.ID
	if w := e.do(call{method: "PATCH", path: path, user: "boris", body: map[string]any{"body": "x"}}); w.Code != http.StatusForbidden {
		t.Fatalf("foreign edit: %d", w.Code)
	}
	if w := e.do(call{method: "PATCH", path: path, user: "boris", body: map[string]any{"status": "resolved"}}); w.Code != http.StatusForbidden {
		t.Fatalf("foreign resolve: %d", w.Code)
	}
	if w := e.do(call{method: "DELETE", path: path, user: "boris"}); w.Code != http.StatusForbidden {
		t.Fatalf("foreign delete: %d", w.Code)
	}

	// The agent takes it into work and replies, but cannot close it.
	agent := map[string]string{auth.TokenHeader: e.agent}
	if w := e.do(call{method: "PATCH", path: path, body: map[string]any{"status": "in_progress"}, headers: agent, noCSRF: true}); w.Code != http.StatusOK {
		t.Fatalf("agent in_progress: %d %s", w.Code, w.Body)
	}
	if w := e.do(call{method: "POST", path: path + "/replies", body: map[string]any{"body": "Исправлю"}, headers: agent, noCSRF: true}); w.Code != http.StatusCreated {
		t.Fatalf("agent reply: %d %s", w.Code, w.Body)
	}
	if w := e.do(call{method: "PATCH", path: path, body: map[string]any{"status": "resolved"}, headers: agent, noCSRF: true}); w.Code != http.StatusForbidden {
		t.Fatalf("agent resolve: %d", w.Code)
	}
	if w := e.do(call{method: "PATCH", path: path, body: map[string]any{"status": "fixed"}, headers: agent, noCSRF: true}); w.Code != http.StatusOK {
		t.Fatalf("agent fixed: %d", w.Code)
	}

	// A person — not the agent — ticks "checked"; reopening clears the tick.
	if w := e.do(call{method: "PATCH", path: path, body: map[string]any{"verified": true}, headers: agent, noCSRF: true}); w.Code != http.StatusForbidden {
		t.Fatalf("agent verify: %d", w.Code)
	}
	verified := decodeBody[threadView](t, e.do(call{method: "PATCH", path: path, user: "boris", body: map[string]any{"verified": true}}))
	if !verified.Verified || verified.VerifiedBy.ID != "boris" || verified.VerifiedAt == nil || !verified.Allowed.Verify {
		t.Fatalf("boris verifies = %+v", verified)
	}

	// The author checks and resolves; the detail shows the reply and who changed the status.
	if w := e.do(call{method: "PATCH", path: path, user: "anna", body: map[string]any{"status": "resolved"}}); w.Code != http.StatusOK {
		t.Fatalf("author resolve: %d %s", w.Code, w.Body)
	}
	detail := decodeBody[threadDetail](t, e.do(call{method: "GET", path: path, user: "anna"}))
	if detail.Status != domain.StatusResolved || detail.StatusBy.ID != "anna" || len(detail.Replies) != 1 ||
		detail.Replies[0].Author.Kind != domain.AuthorAgent || detail.ReplyCount != 1 {
		t.Fatalf("detail = %+v", detail)
	}
	if got := detail.Allowed.Statuses; len(got) != 1 || got[0] != domain.StatusOpen {
		t.Fatalf("author may now only reopen: %v", got)
	}

	if !detail.Verified {
		t.Fatal("resolving must keep the verification")
	}
	reopened := decodeBody[threadView](t, e.do(call{method: "PATCH", path: path, user: "anna", body: map[string]any{"status": "open"}}))
	if reopened.Verified || reopened.VerifiedBy != nil {
		t.Fatalf("reopen keeps the verification: %+v", reopened)
	}

	// Moderators set anything and delete anything.
	if w := e.do(call{method: "PATCH", path: path, user: "lead", roles: "admin", body: map[string]any{"status": "wontfix"}}); w.Code != http.StatusOK {
		t.Fatalf("moderator status: %d", w.Code)
	}
	sum := decodeBody[domain.Summary](t, e.do(call{method: "GET", path: "/api/v1/threads/summary?route=/campaigns", user: "anna"}))
	if sum.Total[domain.StatusWontfix] != 1 || sum.Total[domain.StatusOpen] != 1 || sum.Route[domain.StatusOpen] != 0 {
		t.Fatalf("summary = %+v", sum)
	}
	if w := e.do(call{method: "DELETE", path: path, user: "lead", roles: "admin"}); w.Code != http.StatusNoContent {
		t.Fatalf("moderator delete: %d", w.Code)
	}
	if w := e.do(call{method: "GET", path: path, user: "anna"}); w.Code != http.StatusNotFound {
		t.Fatalf("deleted thread: %d", w.Code)
	}
}

func TestValidation(t *testing.T) {
	e := newEnv(t, nil)
	bad := []map[string]any{
		{"route": "/x", "url": "https://a.b/"},
		{"route": "x", "url": "https://a.b/", "body": "b"},
		{"route": "/x", "url": "javascript:alert(1)", "body": "b"},
		{"route": "/x", "url": "https://a.b/", "body": strings.Repeat("я", maxBody+1)},
		{"route": "/x", "url": "https://a.b/", "body": "b", "kind": "rant"},
		{"route": "/x", "url": "https://a.b/", "body": "b", "anchor": []int{1}},
		{"route": "/x", "url": "https://a.b/", "body": "b", "extra": true},
	}
	for i, in := range bad {
		if w := e.do(call{method: "POST", path: "/api/v1/threads", user: "anna", body: in}); w.Code != http.StatusBadRequest {
			t.Errorf("case %d: %d %s", i, w.Code, w.Body)
		}
	}
	if w := e.do(call{method: "POST", path: "/api/v1/threads", user: "anna", raw: []byte("{")}); w.Code != http.StatusBadRequest {
		t.Errorf("broken JSON: %d", w.Code)
	}
}

func TestCSRFAndCORS(t *testing.T) {
	e := newEnv(t, nil)
	if w := e.do(call{method: "POST", path: "/api/v1/threads", user: "anna", body: newThread("/x"), noCSRF: true}); w.Code != http.StatusForbidden {
		t.Fatalf("write without the request header: %d", w.Code)
	}
	evil := map[string]string{"Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site"}
	if w := e.do(call{method: "POST", path: "/api/v1/threads", user: "anna", body: newThread("/x"), headers: evil}); w.Code != http.StatusForbidden {
		t.Fatalf("cross-site write: %d", w.Code)
	}
	allowedOrigin := map[string]string{"Origin": "https://app.example.com", "Sec-Fetch-Site": "cross-site"}
	w := e.do(call{method: "POST", path: "/api/v1/threads", user: "anna", body: newThread("/x"), headers: allowedOrigin})
	if w.Code != http.StatusCreated || w.Header().Get("Access-Control-Allow-Origin") != "https://app.example.com" {
		t.Fatalf("allowed origin: %d %v", w.Code, w.Header())
	}
	pre := e.do(call{method: "OPTIONS", path: "/api/v1/threads", noCSRF: true, headers: map[string]string{
		"Origin": "https://app.example.com", "Access-Control-Request-Method": "POST"}})
	if pre.Code != http.StatusNoContent || !strings.Contains(pre.Header().Get("Access-Control-Allow-Headers"), RequestHeader) {
		t.Fatalf("preflight: %d %v", pre.Code, pre.Header())
	}
	other := e.do(call{method: "GET", path: "/api/v1/session", headers: map[string]string{"Origin": "https://evil.example"}})
	if other.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("CORS for an unknown origin")
	}
}

func TestAccessKeyLink(t *testing.T) {
	e := newEnv(t, func(o *Options) {
		o.Policy.View = rules(t, "authenticated")
		o.Policy.Comment = rules(t, "provider:key")
	})
	if w := e.do(call{method: "POST", path: "/api/v1/session/key", body: map[string]string{"key": "bsk_wrong"}}); w.Code != http.StatusUnauthorized {
		t.Fatalf("wrong key: %d", w.Code)
	}
	w := e.do(call{method: "POST", path: "/api/v1/session/key", body: map[string]string{"key": e.key}})
	if w.Code != http.StatusOK {
		t.Fatalf("open key: %d %s", w.Code, w.Body)
	}
	cookie := w.Result().Cookies()[0]
	if cookie.Name != auth.KeyCookie || !cookie.HttpOnly || cookie.MaxAge != 3600 {
		t.Fatalf("key cookie = %+v", cookie)
	}
	s := decodeBody[sessionBody](t, e.do(call{method: "GET", path: "/api/v1/session", headers: map[string]string{"Cookie": auth.KeyCookie + "=" + e.key}}))
	if !s.Visible || s.User.Name != "Заказчик" || !s.Can.Comment || s.Can.Moderate {
		t.Fatalf("key session = %+v", s)
	}
}

func TestScreenshots(t *testing.T) {
	e := newEnv(t, nil)
	th := e.create("anna", "/x")
	path := "/api/v1/threads/" + th.ID + "/screenshot"
	png := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 100)...)
	if w := e.do(call{method: "PUT", path: path, user: "boris", raw: png}); w.Code != http.StatusForbidden {
		t.Fatalf("someone else's screenshot: %d", w.Code)
	}
	if w := e.do(call{method: "PUT", path: path, user: "anna", raw: []byte("<svg onload=alert(1)>")}); w.Code != http.StatusBadRequest {
		t.Fatalf("svg accepted: %d", w.Code)
	}
	if w := e.do(call{method: "PUT", path: path, user: "anna", raw: append(png, make([]byte, 2048)...)}); w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("too large: %d", w.Code)
	}
	if w := e.do(call{method: "PUT", path: path, user: "anna", raw: png}); w.Code != http.StatusNoContent {
		t.Fatalf("put: %d %s", w.Code, w.Body)
	}
	w := e.do(call{method: "GET", path: path, user: "boris"})
	if w.Code != 200 || w.Header().Get("Content-Type") != "image/png" || w.Header().Get("X-Content-Type-Options") != "nosniff" || w.Body.Len() != len(png) {
		t.Fatalf("get: %d %v", w.Code, w.Header())
	}
	if w := e.do(call{method: "GET", path: path}); w.Code != http.StatusForbidden {
		t.Fatalf("anonymous get: %d", w.Code)
	}
}

func TestRateLimit(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.RateWrite = 2 })
	for i := range 2 {
		e.create("anna", "/x")
		_ = i
	}
	w := e.do(call{method: "POST", path: "/api/v1/threads", user: "anna", body: newThread("/x")})
	if w.Code != http.StatusTooManyRequests || w.Header().Get("Retry-After") == "" {
		t.Fatalf("third write: %d", w.Code)
	}
	e.create("boris", "/x")
}

func TestWidgetFiles(t *testing.T) {
	e := newEnv(t, nil)
	w := e.do(call{method: "GET", path: "/widget.js"})
	if w.Code != 200 || w.Body.String() != "/*loader*/" || !strings.Contains(w.Header().Get("Cache-Control"), "max-age=300") {
		t.Fatalf("loader: %d %v", w.Code, w.Header())
	}
	again := e.do(call{method: "GET", path: "/widget.js", headers: map[string]string{"If-None-Match": w.Header().Get("ETag")}})
	if again.Code != http.StatusNotModified {
		t.Fatalf("etag revalidation: %d", again.Code)
	}
	asset := e.do(call{method: "GET", path: "/assets/app-1.js"})
	if asset.Code != 200 || !strings.Contains(asset.Header().Get("Cache-Control"), "immutable") ||
		!strings.HasPrefix(asset.Header().Get("Content-Type"), "text/javascript") ||
		asset.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("asset: %d %v", asset.Code, asset.Header())
	}
	for _, p := range []string{"/assets/..%2fwidget.js", "/assets/missing.js"} {
		if w := e.do(call{method: "GET", path: p}); w.Code != http.StatusNotFound {
			t.Errorf("%s: %d", p, w.Code)
		}
	}
	if w := e.do(call{method: "GET", path: "/healthz"}); w.Code != 200 {
		t.Fatalf("healthz: %d", w.Code)
	}
	if w := e.do(call{method: "GET", path: "/api/v2/nothing"}); w.Code != 404 || !strings.Contains(w.Header().Get("Content-Type"), "json") {
		t.Fatalf("unknown API route: %d", w.Code)
	}
}

func TestClientIPBehindTrustedProxy(t *testing.T) {
	s := New(Options{TrustedProxies: []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}})
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "10.0.0.5:1234"
	r.Header.Set("X-Forwarded-For", "198.51.100.7, 10.0.0.9")
	if ip := s.clientIP(r); ip != "198.51.100.7" {
		t.Fatalf("client ip = %s", ip)
	}
	r.RemoteAddr = "203.0.113.1:1"
	if ip := s.clientIP(r); ip != "203.0.113.1" {
		t.Fatalf("spoofed X-Forwarded-For trusted: %s", ip)
	}
}
