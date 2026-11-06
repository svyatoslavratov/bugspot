package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestProviderEdges(t *testing.T) {
	if (&JWT{}).Name() != ProviderJWT || (&Header{}).Name() != ProviderHeader || (&Forward{}).Name() != ProviderForward ||
		(&Key{}).Name() != ProviderKey || (Anonymous{}).Name() != ProviderAnonymous {
		t.Fatal("provider names")
	}
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer a.b.c")
	if got := bearer(r); got != "a.b.c" {
		t.Fatalf("bearer = %q", got)
	}

	answers := map[string]func(http.ResponseWriter){
		"teapot":   func(w http.ResponseWriter) { w.WriteHeader(http.StatusTeapot) },
		"not json": func(w http.ResponseWriter) { _, _ = w.Write([]byte("<html>")) },
	}
	for name, answer := range answers {
		app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { answer(w) }))
		f := &Forward{URL: app.URL, Headers: []string{"Authorization"}, Map: Mapping{ID: "id"}, TTL: time.Minute, Client: app.Client()}
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("Authorization", "Bearer x")
		if id, err := f.Identify(context.Background(), req); id != nil || err == nil {
			t.Errorf("%s: %+v, %v", name, id, err)
		}
		app.Close()
	}
	if (&Forward{URL: "::bad", Cookies: []string{"s"}}).credentialsOnly(t) {
		t.Fatal("unreachable")
	}
}

// credentialsOnly checks that a bad URL is reported, not panicked on.
func (f *Forward) credentialsOnly(t *testing.T) bool {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.AddCookie(&http.Cookie{Name: "s", Value: "v"})
	f.Client, f.TTL, f.Map = http.DefaultClient, time.Minute, Mapping{ID: "id"}
	_, err := f.Identify(context.Background(), r)
	return err == nil
}
