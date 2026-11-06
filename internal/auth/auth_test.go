package auth

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/svyatoslavratov/bugspot/internal/domain"
	"github.com/svyatoslavratov/bugspot/internal/secret"
	"github.com/svyatoslavratov/bugspot/internal/store/memory"
)

func mustRules(t *testing.T, s string) Rules {
	t.Helper()
	r, err := ParseRules(s)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestRules(t *testing.T) {
	admin := &Identity{ID: "1", Roles: []string{"superadmin"}, Provider: ProviderForward}
	guest := &Identity{ID: "anon:x", Provider: ProviderAnonymous}
	customer := &Identity{ID: "key:k", Roles: []string{"customer"}, Provider: ProviderKey}
	cases := []struct {
		rules string
		id    *Identity
		want  bool
	}{
		{"*", nil, true},
		{"authenticated", nil, false},
		{"authenticated", guest, false},
		{"authenticated", admin, true},
		{"anonymous", guest, true},
		{"role:superadmin", admin, true},
		{"role:superadmin", customer, false},
		{"role:superadmin, provider:key", customer, true},
		{"user:1", admin, true},
		{"", admin, false},
	}
	for _, c := range cases {
		if got := mustRules(t, c.rules).Allows(c.id); got != c.want {
			t.Errorf("%q allows %+v = %v, want %v", c.rules, c.id, got, c.want)
		}
	}
	for _, bad := range []string{"role:", "admins", "group:x"} {
		if _, err := ParseRules(bad); err == nil {
			t.Errorf("ParseRules(%q) accepted", bad)
		}
	}
	if s := mustRules(t, "authenticated role:a").String(); s != "authenticated,role:a" {
		t.Errorf("String() = %q", s)
	}
}

func TestPolicy(t *testing.T) {
	p := Policy{View: mustRules(t, "authenticated"), Comment: mustRules(t, "role:dev"), Moderate: mustRules(t, "role:lead")}
	cases := []struct {
		id   *Identity
		want Permissions
	}{
		{nil, Permissions{}},
		{&Identity{ID: "1", Provider: ProviderJWT}, Permissions{View: true}},
		{&Identity{ID: "2", Roles: []string{"dev"}, Provider: ProviderJWT}, Permissions{View: true, Comment: true, Reply: true}},
		{&Identity{ID: "3", Roles: []string{"lead"}, Provider: ProviderJWT}, Permissions{View: true, Comment: true, Reply: true, Moderate: true}},
		{&Identity{ID: "a", Provider: ProviderAgent, Scopes: []string{domain.ScopeRead, domain.ScopeReply}}, Permissions{View: true, Reply: true}},
		{&Identity{ID: "a", Provider: ProviderAgent, Scopes: []string{domain.ScopeReply}}, Permissions{}},
	}
	for _, c := range cases {
		if got := p.For(c.id); got != c.want {
			t.Errorf("For(%+v) = %+v, want %+v", c.id, got, c.want)
		}
	}
	// Commenting needs viewing: a comment rule alone does not open the widget.
	narrow := Policy{View: mustRules(t, "role:dev"), Comment: mustRules(t, "authenticated")}
	if got := narrow.For(&Identity{ID: "9", Provider: ProviderJWT}); got.Comment {
		t.Errorf("comment without view: %+v", got)
	}
}

func TestMapping(t *testing.T) {
	m, err := ParseMapping("id=employee.id, name=employee.name, roles=employee.role", Mapping{})
	if err != nil {
		t.Fatal(err)
	}
	doc := map[string]any{"employee": map[string]any{"id": float64(4217), "name": "Анна", "role": "superadmin"}}
	id := m.fromDocument(doc)
	if id == nil || id.ID != "4217" || id.Name != "Анна" || !id.HasRole("superadmin") {
		t.Fatalf("identity = %+v", id)
	}
	if m.fromDocument(map[string]any{}) != nil {
		t.Fatal("identity without id")
	}
	if _, err := ParseMapping("name=x", Mapping{}); err == nil {
		t.Fatal("mapping without id accepted")
	}
	if _, err := ParseMapping("login=x", Mapping{ID: "sub"}); err == nil {
		t.Fatal("unknown key accepted")
	}
	got := list([]any{"a", float64(2)})
	if len(got) != 2 || got[1] != "2" {
		t.Fatalf("list = %v", got)
	}
}

func TestForward(t *testing.T) {
	var calls atomic.Int32
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Cookie") != "session=good" || r.Header.Get("X-Other") != "" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"employee":{"id":"e1","name":"Анна","role":"teamlead"}}`))
	}))
	defer app.Close()
	f := &Forward{URL: app.URL, Cookies: []string{"session"}, Map: Mapping{ID: "employee.id", Name: "employee.name", Roles: "employee.role"},
		TTL: time.Minute, Client: app.Client()}
	req := func(cookie string) *http.Request {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.Header.Set("Cookie", cookie+"; other=secret")
		r.Header.Set("X-Other", "not forwarded")
		return r
	}
	for range 3 {
		id, err := f.Identify(context.Background(), req("session=good"))
		if err != nil || id == nil || id.ID != "e1" || !id.HasRole("teamlead") {
			t.Fatalf("identify = %+v, %v", id, err)
		}
		id.Roles[0] = "changed by caller"
	}
	if n := calls.Load(); n != 1 {
		t.Fatalf("app called %d times, want 1 (cached)", n)
	}
	if id, err := f.Identify(context.Background(), req("session=bad")); id != nil || err != nil {
		t.Fatalf("bad session = %+v, %v", id, err)
	}
	if id, _ := f.Identify(context.Background(), httptest.NewRequest(http.MethodGet, "/", nil)); id != nil || calls.Load() != 2 {
		t.Fatal("request without cookies must not call the app")
	}
	broken := &Forward{URL: "http://127.0.0.1:1", Cookies: []string{"session"}, Map: f.Map, TTL: time.Minute,
		Client: &http.Client{Timeout: time.Second}}
	if _, err := broken.Identify(context.Background(), req("session=good")); err == nil {
		t.Fatal("unreachable app gave no error")
	}
}

func TestHeader(t *testing.T) {
	h := &Header{Map: Mapping{ID: "X-User", Name: "X-Name", Roles: "X-Groups"}, Trusted: []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}}
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("X-User", "u1")
	r.Header.Set("X-Groups", "dev, qa")
	r.RemoteAddr = "10.1.2.3:5000"
	id, _ := h.Identify(context.Background(), r)
	if id == nil || id.Name != "u1" || !id.HasRole("qa") {
		t.Fatalf("trusted proxy = %+v", id)
	}
	r.RemoteAddr = "203.0.113.5:5000"
	if id, _ := h.Identify(context.Background(), r); id != nil {
		t.Fatalf("headers from an untrusted address accepted: %+v", id)
	}
}

func TestJWT(t *testing.T) {
	secretKey := []byte("0123456789abcdef0123456789abcdef")
	j := &JWT{Secret: secretKey, Issuer: "app", Map: Mapping{ID: "sub", Name: "name", Roles: "roles"}}
	sign := func(claims jwt.MapClaims, method jwt.SigningMethod, key any) string {
		s, err := jwt.NewWithClaims(method, claims).SignedString(key)
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	req := func(token string) *http.Request {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.Header.Set(TokenHeader, token)
		return r
	}
	valid := jwt.MapClaims{"sub": "42", "name": "Иван", "roles": []string{"dev"}, "iss": "app", "exp": time.Now().Add(time.Minute).Unix()}
	id, err := j.Identify(context.Background(), req(sign(valid, jwt.SigningMethodHS256, secretKey)))
	if err != nil || id == nil || id.ID != "42" || !id.HasRole("dev") {
		t.Fatalf("valid token = %+v, %v", id, err)
	}
	expired := jwt.MapClaims{"sub": "42", "iss": "app", "exp": time.Now().Add(-time.Hour).Unix()}
	noExp := jwt.MapClaims{"sub": "42", "iss": "app"}
	foreign := jwt.MapClaims{"sub": "42", "iss": "other", "exp": time.Now().Add(time.Minute).Unix()}
	for name, token := range map[string]string{
		"expired":      sign(expired, jwt.SigningMethodHS256, secretKey),
		"without exp":  sign(noExp, jwt.SigningMethodHS256, secretKey),
		"wrong issuer": sign(foreign, jwt.SigningMethodHS256, secretKey),
		"wrong secret": sign(valid, jwt.SigningMethodHS256, []byte("another-secret-another-secret-!!")),
		"none":         "eyJhbGciOiJub25lIn0.eyJzdWIiOiI0MiJ9.",
		"agent token":  secret.New(secret.AgentPrefix),
	} {
		if id, err := j.Identify(context.Background(), req(token)); id != nil || err != nil {
			t.Errorf("%s: %+v, %v", name, id, err)
		}
	}

	ec, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	pub := &JWT{PublicKey: &ec.PublicKey, Map: Mapping{ID: "sub"}}
	claims := jwt.MapClaims{"sub": "7", "exp": time.Now().Add(time.Minute).Unix()}
	if id, _ := pub.Identify(context.Background(), req(sign(claims, jwt.SigningMethodES256, ec))); id == nil || id.Name != "7" {
		t.Fatalf("ES256 token = %+v", id)
	}
	// An HS256 token signed with the public key bytes must not pass a public-key verifier.
	if id, _ := pub.Identify(context.Background(), req(sign(claims, jwt.SigningMethodHS256, secretKey))); id != nil {
		t.Fatal("algorithm confusion accepted")
	}
}

func TestAnonymousAndKey(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	if id, _ := (Anonymous{}).Identify(context.Background(), r); id == nil || id.ID != "" || id.Authenticated() {
		t.Fatalf("anonymous without cookie = %+v", id)
	}
	r.AddCookie(&http.Cookie{Name: AnonymousCookie, Value: secret.ID()})
	if id, _ := (Anonymous{}).Identify(context.Background(), r); id == nil || id.ID == "" {
		t.Fatalf("anonymous with cookie = %+v", id)
	}

	now := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	st := memory.New()
	raw := secret.New(secret.KeyPrefix)
	_ = st.CreateCredential(context.Background(), domain.Credential{ID: "k1", Kind: domain.CredentialKey, Name: "Заказчик",
		Hash: secret.Hash(raw), Roles: []string{"customer"}, CreatedAt: now})
	k := &Key{Store: st, Now: func() time.Time { return now }}
	r = httptest.NewRequest(http.MethodGet, "/", nil)
	r.AddCookie(&http.Cookie{Name: KeyCookie, Value: raw})
	id, err := k.Identify(context.Background(), r)
	if err != nil || id == nil || id.Name != "Заказчик" || !id.HasRole("customer") {
		t.Fatalf("key = %+v, %v", id, err)
	}
	_ = st.RevokeCredential(context.Background(), "k1", now)
	if id, _ := k.Identify(context.Background(), r); id != nil {
		t.Fatal("revoked key accepted")
	}
}

func TestChainOrder(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "127.0.0.1:1"
	r.Header.Set("X-User", "proxy-user")
	chain := Chain{
		&Header{Map: Mapping{ID: "X-User"}, Trusted: []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}},
		Anonymous{},
	}
	id, _ := chain.Identify(context.Background(), r)
	if id == nil || id.Provider != ProviderHeader {
		t.Fatalf("first provider must win: %+v", id)
	}
	r.Header.Del("X-User")
	if id, _ := chain.Identify(context.Background(), r); id == nil || id.Provider != ProviderAnonymous {
		t.Fatalf("falls through to anonymous: %+v", id)
	}
}
