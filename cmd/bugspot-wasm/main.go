//go:build js && wasm

// Command bugspot-wasm runs the real API handler in the browser for the GitHub Pages demo: the
// widget's requests go to globalThis.bugspotFetch instead of the network, the data lives in the
// memory store and is saved to localStorage. The demo page picks the user and the access policy.
package main

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"syscall/js"
	"time"

	"github.com/svyatoslavratov/bugspot/internal/auth"
	"github.com/svyatoslavratov/bugspot/internal/httpapi"
	"github.com/svyatoslavratov/bugspot/internal/store/memory"
)

const storageKey = "bugspot-demo-v1"

var (
	st      = memory.New()
	handler http.Handler
)

func rules(s string) auth.Rules {
	r, err := auth.ParseRules(s)
	if err != nil {
		js.Global().Get("console").Call("error", "bugspot demo: "+err.Error())
	}
	return r
}

// configure rebuilds the server with a policy: {view, comment, moderate} rule strings.
func configure(_ js.Value, args []js.Value) any {
	opts := js.Global().Get("Object").New()
	if len(args) > 0 && args[0].Type() == js.TypeObject {
		opts = args[0]
	}
	str := func(name, def string) string {
		if v := opts.Get(name); v.Type() == js.TypeString {
			return v.String()
		}
		return def
	}
	trusted := []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}
	handler = httpapi.New(httpapi.Options{
		Project: "demo", Enabled: true, Store: st,
		Chain: auth.Chain{
			&auth.Header{Map: auth.Mapping{ID: "X-Demo-User", Name: "X-Demo-Name", Roles: "X-Demo-Roles"}, Trusted: trusted},
			auth.Anonymous{},
		},
		Policy: auth.Policy{
			View:     rules(str("view", "authenticated")),
			Comment:  rules(str("comment", "authenticated")),
			Moderate: rules(str("moderate", "role:admin")),
		},
		CookieSecure: "false", ScreenshotMaxBytes: 3 << 20, Version: "demo",
	}).Handler()
	return nil
}

func persist() {
	data, err := st.Export()
	if err != nil {
		return
	}
	defer func() { _ = recover() }() // a full or blocked localStorage only loses persistence
	js.Global().Get("localStorage").Call("setItem", storageKey, string(data))
}

// serve takes {method, path, headers: {name: value}, body: Uint8Array|null} and returns
// {status, headers: [[name, value]...], body: Uint8Array}.
func serve(_ js.Value, args []js.Value) any {
	in := args[0]
	var body io.Reader = http.NoBody
	if b := in.Get("body"); b.Truthy() {
		buf := make([]byte, b.Get("length").Int())
		js.CopyBytesToGo(buf, b)
		body = bytes.NewReader(buf)
	}
	r := httptest.NewRequest(in.Get("method").String(), in.Get("path").String(), body)
	r.RemoteAddr = "127.0.0.1:0"
	headers := in.Get("headers")
	keys := js.Global().Get("Object").Call("keys", headers)
	for i := range keys.Length() {
		name := keys.Index(i).String()
		r.Header.Set(name, headers.Get(name).String())
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if r.Method != http.MethodGet && w.Code < 300 {
		persist()
	}
	out := js.Global().Get("Object").New()
	out.Set("status", w.Code)
	pairs := js.Global().Get("Array").New()
	for name, values := range w.Header() {
		for _, v := range values {
			pairs.Call("push", js.ValueOf([]any{strings.ToLower(name), v}))
		}
	}
	out.Set("headers", pairs)
	data := w.Body.Bytes()
	arr := js.Global().Get("Uint8Array").New(len(data))
	js.CopyBytesToJS(arr, data)
	out.Set("body", arr)
	return out
}

func reset(js.Value, []js.Value) any {
	st = memory.New()
	js.Global().Get("localStorage").Call("removeItem", storageKey)
	configure(js.Undefined(), nil)
	seed()
	return nil
}

func main() {
	if saved := js.Global().Get("localStorage").Call("getItem", storageKey); saved.Type() == js.TypeString {
		_ = st.Import([]byte(saved.String()))
	}
	configure(js.Undefined(), nil)
	seed()
	api := js.Global().Get("Object").New()
	api.Set("serve", js.FuncOf(serve))
	api.Set("configure", js.FuncOf(configure))
	api.Set("reset", js.FuncOf(reset))
	api.Set("startedAt", time.Now().UnixMilli())
	js.Global().Set("bugspotServer", api)
	if ready := js.Global().Get("onBugspotServerReady"); ready.Type() == js.TypeFunction {
		ready.Invoke()
	}
	select {}
}
