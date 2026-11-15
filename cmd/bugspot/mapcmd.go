package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

func (a *app) mapCommand(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: bugspot map crawl|export|import")
	}
	switch args[0] {
	case "crawl":
		return a.mapCrawl(args[1:])
	case "export":
		return a.mapExport(args[1:])
	case "import":
		return a.mapImport(args[1:])
	}
	return fmt.Errorf("unknown map command %q (crawl, export or import)", args[0])
}

// mapExport writes the manifest of the map: what people and agents wrote about the screens.
func (a *app) mapExport(args []string) error {
	fs := a.flags("map export")
	out := fs.String("o", "", "write to this file instead of stdout")
	if err := fs.Parse(args); err != nil {
		return err
	}
	c, err := a.newClient()
	if err != nil {
		return err
	}
	var data []byte
	if err := c.do("GET", "api/v1/map/manifest", nil, &data); err != nil {
		return err
	}
	var pretty json.RawMessage = data
	if indented, err := json.MarshalIndent(pretty, "", "  "); err == nil {
		indented = append(indented, '\n')
		data = indented
	}
	if *out == "" {
		_, err = a.stdout.Write(data)
		return err
	}
	return os.WriteFile(*out, data, 0o600)
}

// mapImport applies a manifest file ("-" reads stdin).
func (a *app) mapImport(args []string) error {
	fs := a.flags("map import")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return errors.New("usage: bugspot map import <manifest.json | ->")
	}
	var data []byte
	var err error
	if name := fs.Arg(0); name == "-" {
		data, err = io.ReadAll(io.LimitReader(a.stdin, 8<<20))
	} else {
		data, err = os.ReadFile(name) //nolint:gosec // the operator's file
	}
	if err != nil {
		return err
	}
	if !json.Valid(data) {
		return errors.New("the manifest is not valid JSON")
	}
	c, err := a.newClient()
	if err != nil {
		return err
	}
	var res struct{ Created, Updated, States, Edges int }
	if err := c.do("POST", "api/v1/map/manifest", json.RawMessage(data), &res); err != nil {
		return err
	}
	fmt.Fprintf(a.stdout, "screens: %d planned, %d updated; states described: %d; transitions declared: %d\n",
		res.Created, res.Updated, res.States, res.Edges)
	return nil
}

// listFlag collects a repeated flag.
type listFlag []string

func (l *listFlag) String() string { return strings.Join(*l, ", ") }

func (l *listFlag) Set(v string) error {
	*l = append(*l, v)
	return nil
}

// crawlOptions are what the widget's crawler gets from the command.
type crawlOptions struct {
	Token      string          `json:"token"`
	Auto       bool            `json:"auto"`
	Buttons    bool            `json:"buttons"`
	MaxScreens int             `json:"maxScreens"`
	Widget     *injectedWidget `json:"widget,omitempty"`
}

// crawlStatus is what the widget reports while it crawls (window.__bugspotCrawlStatus).
type crawlStatus struct {
	Phase   string `json:"phase"`
	Screens int    `json:"screens"`
	States  int    `json:"states"`
	Looks   int    `json:"looks"`
	Edges   int    `json:"edges"`
	Queued  int    `json:"queued"`
	Current string `json:"current"`
	Error   string `json:"error"`
	Map     string `json:"map"`
	// WritesBlocked are requests of the app that were not reads, stopped in the page.
	WritesBlocked int `json:"writesBlocked"`
}

// mapCrawl opens the app in a browser without a window and lets the widget walk it: the same
// crawler as the "Build the map" button, with an agent token instead of a person.
func (a *app) mapCrawl(args []string) error {
	fs := a.flags("map crawl")
	chrome := fs.String("chrome", a.getenv("BUGSPOT_CHROME"), "Chrome or Chromium to run (default: the first one installed)")
	profile := fs.String("profile", "", "a Chrome profile to use and keep: sign in to the app once with --headed, then crawl with it")
	headed := fs.Bool("headed", false, "show the browser window")
	buttons := fs.Bool("buttons", false, "also press buttons that may open windows (never ones that delete, send, save, pay or sign out)")
	maxScreens := fs.Int("max-screens", 100, "stop after this many screens")
	timeout := fs.Duration("timeout", 30*time.Minute, "stop after this long")
	viewport := fs.String("viewport", "1440x900", "window size the app is laid out in")
	widget := fs.String("widget", "", "load the widget from this bugspot address on pages that do not, e.g. https://app.example.com/bugspot")
	route := fs.String("route", "auto", "with --widget: how the app routes (auto, path or hash)")
	var cookies, headers listFlag
	fs.Var(&cookies, "cookie", "a cookie for the app, name=value (repeat for more)")
	fs.Var(&headers, "header", `a header for every request, "Name: value" (repeat for more)`)
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return errors.New("usage: bugspot map crawl [flags] <app address>")
	}
	token := a.getenv("BUGSPOT_TOKEN")
	if token == "" {
		return errors.New("set BUGSPOT_TOKEN: an agent token with the read and map scopes (bugspot token create --scopes read,map)")
	}
	target, err := url.Parse(fs.Arg(0))
	if err != nil || (target.Scheme != "http" && target.Scheme != "https") || target.Host == "" {
		return fmt.Errorf("the app address must be an http(s) URL, got %q", fs.Arg(0))
	}
	width, height, err := parseViewport(*viewport)
	if err != nil {
		return err
	}
	inject, err := injectWidget(*widget, *route)
	if err != nil {
		return err
	}
	extra := map[string]string{}
	// Chrome does not send credentials from the address: Basic Auth of a stand becomes a header.
	if target.User != nil {
		pass, _ := target.User.Password()
		extra["Authorization"] = "Basic " + base64.StdEncoding.EncodeToString([]byte(target.User.Username()+":"+pass))
		target.User = nil
	}
	for _, h := range headers {
		name, value, ok := strings.Cut(h, ":")
		if !ok || strings.TrimSpace(name) == "" {
			return fmt.Errorf("--header %q: want \"Name: value\"", h)
		}
		extra[strings.TrimSpace(name)] = strings.TrimSpace(value)
	}
	type cookie struct {
		Name  string `json:"name"`
		Value string `json:"value"`
		URL   string `json:"url"`
	}
	jar := make([]cookie, 0, len(cookies))
	for _, c := range cookies {
		name, value, ok := strings.Cut(c, "=")
		if !ok || name == "" {
			return fmt.Errorf("--cookie %q: want name=value", c)
		}
		jar = append(jar, cookie{Name: name, Value: value, URL: target.Scheme + "://" + target.Host + "/"})
	}
	path, err := findChrome(*chrome)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(a.ctx, *timeout)
	defer cancel()
	b, err := launchBrowser(ctx, browserOptions{path: path, profile: *profile, headed: *headed, width: width, height: height})
	if err != nil {
		return err
	}
	defer b.close()
	session, err := b.page(ctx)
	if err != nil {
		return err
	}
	options, err := json.Marshal(crawlOptions{Token: token, Auto: true, Buttons: *buttons, MaxScreens: *maxScreens, Widget: inject})
	if err != nil {
		return err
	}
	bootstrap := "if (window === window.top) { window.__bugspotCrawl = " + string(options) + ";"
	if inject != nil {
		bootstrap += " " + widgetLoader
	}
	bootstrap += " }"
	// Under the widget's own guard, a second one in the browser: a request of the page that is not
	// a read fails, unless it is the widget reporting to bugspot (it carries the token).
	var stopped atomic.Int64
	b.cdp.handle(onlyReads(ctx, b.cdp, &stopped))
	setup := []struct {
		method string
		params any
	}{
		{"Emulation.setDeviceMetricsOverride", map[string]any{"width": width, "height": height, "deviceScaleFactor": 1, "mobile": false}},
		{"Network.enable", nil},
		{"Network.setExtraHTTPHeaders", map[string]any{"headers": extra}},
		{"Network.setCookies", map[string]any{"cookies": jar}},
		{"Page.enable", nil},
		{"Fetch.enable", map[string]any{"patterns": []map[string]any{{"urlPattern": "*", "requestStage": "Request"}}}},
		// Only the top page crawls; the app inside the crawler's frame must not start another.
		{"Page.addScriptToEvaluateOnNewDocument", map[string]any{"source": bootstrap}},
		{"Page.navigate", map[string]any{"url": target.String()}},
	}
	for _, step := range setup {
		if err := b.cdp.call(ctx, session, step.method, step.params, nil); err != nil {
			return err
		}
	}
	fmt.Fprintf(a.stderr, "crawling %s\n", target.Redacted())
	err = a.followCrawl(ctx, b.cdp, session, time.Second, 90*time.Second)
	if n := stopped.Load(); n > 0 {
		fmt.Fprintf(a.stdout, "requests that would change data, stopped by the browser: %d\n", n)
	}
	return err
}

// onlyReads answers paused requests: reads and the widget's own reports go on, the rest fail.
func onlyReads(ctx context.Context, c *cdp, stopped *atomic.Int64) func(cdpMessage) {
	return func(m cdpMessage) {
		if m.Method != "Fetch.requestPaused" {
			return
		}
		raw, _ := json.Marshal(m.Params)
		var p struct {
			RequestID string `json:"requestId"`
			Request   struct {
				Method  string            `json:"method"`
				Headers map[string]string `json:"headers"`
			} `json:"request"`
		}
		if json.Unmarshal(raw, &p) != nil || p.RequestID == "" {
			return
		}
		if readOrReport(p.Request.Method, p.Request.Headers) {
			_ = c.call(ctx, m.SessionID, "Fetch.continueRequest", map[string]any{"requestId": p.RequestID}, nil)
			return
		}
		stopped.Add(1)
		_ = c.call(ctx, m.SessionID, "Fetch.failRequest", map[string]any{"requestId": p.RequestID, "errorReason": "BlockedByClient"}, nil)
	}
}

func readOrReport(method string, headers map[string]string) bool {
	switch strings.ToUpper(method) {
	case "GET", "HEAD", "OPTIONS":
		return true
	}
	for name := range headers {
		if strings.EqualFold(name, "X-Bugspot-Token") {
			return true
		}
	}
	return false
}

// injectedWidget is the widget to add to pages that do not load it.
type injectedWidget struct {
	Src   string `json:"src"`
	Route string `json:"route"`
}

// widgetLoader adds the widget a moment after the page loaded, when the page has not loaded it
// itself: for apps that load it only in some environments, or not at all. It reads what to load
// from the crawl options, so nothing is spliced into it.
const widgetLoader = `addEventListener("load", () => setTimeout(() => {
	const w = window.__bugspotCrawl && window.__bugspotCrawl.widget;
	if (!w || window.bugspot || window.__bugspotRun) return;
	const s = document.createElement("script");
	s.src = w.src;
	s.dataset.route = w.route;
	document.head.append(s);
}, 1500));`

// injectWidget checks --widget and --route; nil when no widget is to be added.
func injectWidget(base, route string) (*injectedWidget, error) {
	if base == "" {
		return nil, nil
	}
	u, err := url.Parse(strings.TrimSuffix(base, "/") + "/widget.js")
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("--widget must be the http(s) address of bugspot, got %q", base)
	}
	if route != "auto" && route != "path" && route != "hash" {
		return nil, fmt.Errorf("--route must be auto, path or hash, got %q", route)
	}
	return &injectedWidget{Src: u.String(), Route: route}, nil
}

func parseViewport(v string) (int, int, error) {
	w, h, ok := strings.Cut(v, "x")
	width, errW := strconv.Atoi(w)
	height, errH := strconv.Atoi(h)
	if !ok || errW != nil || errH != nil || width < 320 || height < 320 || width > 4000 || height > 4000 {
		return 0, 0, fmt.Errorf("--viewport %q: want WIDTHxHEIGHT, e.g. 1440x900", v)
	}
	return width, height, nil
}

// followCrawl prints the progress the widget reports until it is done; stopping the command stops
// the crawl, and what was collected stays on the map.
func (a *app) followCrawl(ctx context.Context, c *cdp, session string, every, startup time.Duration) error {
	started := time.Now()
	var last crawlStatus
	seen := false
	for {
		var raw string
		err := c.evaluate(ctx, session, "JSON.stringify(window.__bugspotCrawlStatus ?? null)", &raw)
		if ctx.Err() != nil {
			stop, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			_ = c.evaluate(stop, session, "window.__bugspotCrawlStop?.()", nil)
			cancel()
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return errors.New("the crawl took longer than --timeout; what it collected is on the map")
			}
			return errors.New("stopped; what the crawl collected is on the map")
		}
		// A page that is navigating has no context for a moment: try again.
		var st crawlStatus
		if err == nil && raw != "" && raw != "null" && json.Unmarshal([]byte(raw), &st) == nil {
			seen = true
			if st != last {
				a.printCrawl(st)
				last = st
			}
			switch st.Phase {
			case "done", "stopped":
				fmt.Fprintf(a.stdout, "%s: %d screens, %d states, %d looks, %d transitions in %s\n", st.Phase,
					st.Screens, st.States, st.Looks, st.Edges, time.Since(started).Round(time.Second))
				if st.WritesBlocked > 0 {
					fmt.Fprintf(a.stdout, "requests that would change data, stopped in the page: %d\n", st.WritesBlocked)
				}
				if st.Screens <= 1 {
					fmt.Fprintln(a.stderr, "only one screen was reached: if the app wants a sign-in, pass --cookie or sign in once with --headed --profile")
				}
				if st.Map != "" {
					fmt.Fprintf(a.stdout, "the map: %s\n", st.Map)
				}
				return nil
			case "error":
				return fmt.Errorf("the crawl failed: %s", st.Error)
			}
		}
		if !seen && time.Since(started) > startup {
			return errors.New("the widget did not start the crawl: is widget.js on the page, may the token see it " +
				"(scopes read and map), and is the page reachable without a sign-in (else --cookie or --profile)?")
		}
		select {
		case <-ctx.Done():
		case <-time.After(every):
		}
	}
}

func (a *app) printCrawl(st crawlStatus) {
	if st.Phase != "running" {
		return
	}
	fmt.Fprintf(a.stderr, "screens %d · states %d · looks %d · queued %d  %s\n", st.Screens, st.States, st.Looks, st.Queued, st.Current)
}
