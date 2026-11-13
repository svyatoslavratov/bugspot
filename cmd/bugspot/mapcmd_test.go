package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestMapManifestCommands(t *testing.T) {
	var imported string
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Bugspot-Token") != "bsp_test" || r.URL.Path != "/api/v1/map/manifest" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		if r.Method == http.MethodPost {
			body, _ := io.ReadAll(r.Body)
			imported = string(body)
			_, _ = w.Write([]byte(`{"created":1,"updated":2,"states":3,"edges":4}`))
			return
		}
		_, _ = w.Write([]byte(`{"version":1,"screens":[{"key":"/a","name":"Авторы"}]}`))
	}))
	defer api.Close()
	env := map[string]string{"BUGSPOT_URL": api.URL, "BUGSPOT_TOKEN": "bsp_test"}

	r := run(t, env, "map", "export")
	if r.code != 0 || !strings.Contains(r.stdout, "\n  \"screens\": [") {
		t.Fatalf("export = %+v", r)
	}
	file := filepath.Join(t.TempDir(), "map.json")
	if r := run(t, env, "map", "export", "-o", file); r.code != 0 {
		t.Fatalf("export -o = %+v", r)
	}
	if r := run(t, env, "map", "import", file); r.code != 0 || !strings.Contains(r.stdout, "1 planned, 2 updated") ||
		!strings.Contains(imported, `"Авторы"`) {
		t.Fatalf("import = %+v, sent %s", r, imported)
	}
	a, out, _ := newApp(context.Background(), env, `{"screens":[]}`)
	if code := a.run([]string{"map", "import", "-"}); code != 0 || imported != `{"screens":[]}` {
		t.Fatalf("import from stdin = %d %s", code, out)
	}
	_ = os.WriteFile(file, []byte("{oops"), 0o600)
	for _, args := range [][]string{{"map"}, {"map", "draw"}, {"map", "import"}, {"map", "import", file}, {"map", "import", "/nope.json"}} {
		if r := run(t, env, args...); r.code != 1 {
			t.Errorf("%v = %+v, want an error", args, r)
		}
	}
}

func TestMapCrawlArguments(t *testing.T) {
	for _, c := range []struct {
		env  map[string]string
		args []string
		want string
	}{
		{nil, []string{"map", "crawl"}, "usage"},
		{nil, []string{"map", "crawl", "https://app.test"}, "BUGSPOT_TOKEN"},
		{map[string]string{"BUGSPOT_TOKEN": "bsp_x"}, []string{"map", "crawl", "ftp://app.test"}, "http(s) URL"},
		{map[string]string{"BUGSPOT_TOKEN": "bsp_x"}, []string{"map", "crawl", "--viewport", "big", "https://app.test"}, "WIDTHxHEIGHT"},
		{map[string]string{"BUGSPOT_TOKEN": "bsp_x"}, []string{"map", "crawl", "--header", "nocolon", "https://app.test"}, "Name: value"},
		{map[string]string{"BUGSPOT_TOKEN": "bsp_x"}, []string{"map", "crawl", "--cookie", "novalue", "https://app.test"}, "name=value"},
		{map[string]string{"BUGSPOT_TOKEN": "bsp_x"}, []string{"map", "crawl", "--chrome", "/nope/chrome", "https://app.test"}, "/nope/chrome"},
		{map[string]string{"BUGSPOT_TOKEN": "bsp_x"}, []string{"map", "crawl", "--widget", "ftp://x", "https://app.test"}, "--widget"},
		{map[string]string{"BUGSPOT_TOKEN": "bsp_x"}, []string{"map", "crawl", "--widget", "https://x", "--route", "tree", "https://app.test"}, "--route"},
	} {
		if r := run(t, c.env, c.args...); r.code != 1 || !strings.Contains(r.stderr, c.want) {
			t.Errorf("%v = %+v, want %q", c.args, r, c.want)
		}
	}
	if w, h, err := parseViewport("1280x720"); err != nil || w != 1280 || h != 720 {
		t.Fatalf("viewport = %d %d %v", w, h, err)
	}
	if js, err := injectWidget("https://app.test/bugspot/", "hash"); err != nil ||
		!strings.Contains(js, `{"route":"hash","src":"https://app.test/bugspot/widget.js"}`) {
		t.Fatalf("inject = %s %v", js, err)
	}
	if js, _ := injectWidget("", "auto"); js != "" {
		t.Fatalf("no widget to inject = %q", js)
	}
	if p, err := findChrome("/opt/chrome"); err != nil || p != "/opt/chrome" {
		t.Fatalf("asked chrome = %q %v", p, err)
	}
}

// fakeBrowser answers DevTools calls over a pipe: getVersion, and the crawl status from statuses
// in turn (the last one repeats).
func fakeBrowser(t *testing.T, statuses []string) (*cdp, *[]string) {
	t.Helper()
	toBrowserR, toBrowserW := io.Pipe()
	fromBrowserR, fromBrowserW := io.Pipe()
	var calls []string
	go func() {
		buf := make([]byte, 0, 4096)
		chunk := make([]byte, 4096)
		i := 0
		for {
			n, err := toBrowserR.Read(chunk)
			if err != nil {
				_ = fromBrowserW.Close()
				return
			}
			buf = append(buf, chunk[:n]...)
			for {
				end := bytes.IndexByte(buf, 0)
				if end < 0 {
					break
				}
				var m struct {
					ID     int64           `json:"id"`
					Method string          `json:"method"`
					Params json.RawMessage `json:"params"`
				}
				_ = json.Unmarshal(buf[:end], &m)
				buf = buf[end+1:]
				calls = append(calls, m.Method+" "+string(m.Params))
				var result any = map[string]any{}
				switch {
				case m.Method == "Browser.getVersion":
					result = map[string]any{"product": "Chrome/140"}
				case m.Method == "Runtime.evaluate" && strings.Contains(string(m.Params), "__bugspotCrawlStatus"):
					value := statuses[min(i, len(statuses)-1)]
					i++
					result = map[string]any{"result": map[string]any{"value": value}}
				case m.Method == "Fail.me":
					reply, _ := json.Marshal(map[string]any{"id": m.ID, "error": map[string]any{"code": -32000, "message": "no such method"}})
					_, _ = fromBrowserW.Write(append(reply, 0))
					continue
				}
				reply, _ := json.Marshal(map[string]any{"id": m.ID, "result": result})
				_, _ = fromBrowserW.Write(append(reply, 0))
			}
		}
	}()
	t.Cleanup(func() { _ = toBrowserW.Close() })
	return newCDP(fromBrowserR, toBrowserW), &calls
}

func TestCDPCalls(t *testing.T) {
	c, _ := fakeBrowser(t, []string{"null"})
	ctx := context.Background()
	var version struct{ Product string }
	if err := c.call(ctx, "", "Browser.getVersion", nil, &version); err != nil || version.Product != "Chrome/140" {
		t.Fatalf("version = %+v %v", version, err)
	}
	if err := c.call(ctx, "s1", "Fail.me", nil, nil); err == nil || !strings.Contains(err.Error(), "no such method") {
		t.Fatalf("an error answer = %v", err)
	}
	short, cancel := context.WithTimeout(ctx, 20*time.Millisecond)
	defer cancel()
	<-short.Done()
	if err := c.call(short, "", "Browser.getVersion", nil, nil); err == nil {
		t.Fatal("a call after the context ended succeeded")
	}
}

func TestFollowCrawl(t *testing.T) {
	running := `{"phase":"running","screens":3,"states":5,"looks":4,"queued":7,"current":"/authors"}`
	done := `{"phase":"done","screens":12,"states":30,"looks":28,"edges":40,"map":"https://app.test/bugspot/map"}`
	c, calls := fakeBrowser(t, []string{"null", running, running, done})
	a, out, errOut := newApp(context.Background(), nil, "")
	if err := a.followCrawl(context.Background(), c, "s1", time.Millisecond, time.Second); err != nil {
		t.Fatal(err)
	}
	if strings.Count(errOut.String(), "screens 3 · states 5") != 1 || !strings.Contains(out.String(), "done: 12 screens, 30 states, 28 looks, 40 transitions") ||
		!strings.Contains(out.String(), "the map: https://app.test/bugspot/map") {
		t.Fatalf("output:\n%s\n%s", out, errOut)
	}
	if len(*calls) != 4 {
		t.Fatalf("calls = %v", *calls)
	}

	c, _ = fakeBrowser(t, []string{`{"phase":"error","error":"the app does not open in a frame"}`})
	if err := a.followCrawl(context.Background(), c, "s1", time.Millisecond, time.Second); err == nil || !strings.Contains(err.Error(), "frame") {
		t.Fatalf("a failed crawl = %v", err)
	}
	c, _ = fakeBrowser(t, []string{"null"})
	if err := a.followCrawl(context.Background(), c, "s1", time.Millisecond, 20*time.Millisecond); err == nil || !strings.Contains(err.Error(), "widget.js") {
		t.Fatalf("no widget = %v", err)
	}
	c, calls = fakeBrowser(t, []string{running})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if err := a.followCrawl(ctx, c, "s1", time.Millisecond, time.Second); err == nil || !strings.Contains(err.Error(), "--timeout") {
		t.Fatalf("a crawl past its time = %v", err)
	}
	if last := (*calls)[len(*calls)-1]; !strings.Contains(last, "__bugspotCrawlStop") {
		t.Fatalf("the crawl was not stopped: %s", last)
	}
}

func TestOnlyReads(t *testing.T) {
	c, calls := fakeBrowser(t, []string{"null"})
	var stopped atomic.Int64
	handle := onlyReads(context.Background(), c, &stopped)
	paused := func(method string, headers map[string]string) cdpMessage {
		return cdpMessage{Method: "Fetch.requestPaused", SessionID: "s1", Params: map[string]any{
			"requestId": "r-" + method, "request": map[string]any{"method": method, "url": "https://app.test/api/x", "headers": headers}}}
	}
	handle(paused("GET", nil))
	handle(paused("PUT", map[string]string{"Content-Type": "application/json"}))
	handle(paused("POST", map[string]string{"x-bugspot-token": "bsp_x"}))
	handle(cdpMessage{Method: "Page.loadEventFired"})
	want := []string{`Fetch.continueRequest {"requestId":"r-GET"}`, `Fetch.failRequest {"errorReason":"BlockedByClient","requestId":"r-PUT"}`,
		`Fetch.continueRequest {"requestId":"r-POST"}`}
	if strings.Join(*calls, "\n") != strings.Join(want, "\n") || stopped.Load() != 1 {
		t.Fatalf("calls:\n%s\nstopped %d", strings.Join(*calls, "\n"), stopped.Load())
	}
}
