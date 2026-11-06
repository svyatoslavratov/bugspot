package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"text/tabwriter"
	"time"
	"unicode/utf8"
)

// client talks to a running service with an agent token. BUGSPOT_URL is the service root as the
// browser sees it, Basic Auth included if the stand has one: https://user:pass@dev.example.com/bugspot.
type client struct {
	base  *url.URL
	token string
	http  *http.Client
}

func newClient() (*client, error) {
	raw := os.Getenv("BUGSPOT_URL")
	token := os.Getenv("BUGSPOT_TOKEN")
	if raw == "" || token == "" {
		return nil, errors.New("set BUGSPOT_URL (the service root, e.g. https://app.example.com/bugspot) and BUGSPOT_TOKEN (an agent token)")
	}
	base, err := url.Parse(strings.TrimSuffix(raw, "/") + "/")
	if err != nil {
		return nil, fmt.Errorf("BUGSPOT_URL: %w", err)
	}
	return &client{base: base, token: token, http: &http.Client{Timeout: 30 * time.Second}}, nil
}

func (c *client) do(method, path string, body any, out any) error {
	ref, err := url.Parse(path)
	if err != nil {
		return err
	}
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, c.base.ResolveReference(ref).String(), reader) //nolint:noctx,gosec // the operator's BUGSPOT_URL
	if err != nil {
		return err
	}
	req.Header.Set("X-Bugspot-Token", c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.http.Do(req) //nolint:gosec // the operator's BUGSPOT_URL
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(res.Body, 64<<20))
	if err != nil {
		return err
	}
	if res.StatusCode >= 300 {
		var e struct{ Error string }
		_ = json.Unmarshal(data, &e)
		if e.Error == "" {
			e.Error = strings.TrimSpace(string(data))
		}
		return fmt.Errorf("%s %s: %d %s", method, path, res.StatusCode, e.Error)
	}
	switch v := out.(type) {
	case nil:
		return nil
	case *[]byte:
		*v = data
		return nil
	default:
		return json.Unmarshal(data, out)
	}
}

type cliThread struct {
	ID            string                 `json:"id"`
	Number        int                    `json:"number"`
	Route         string                 `json:"route"`
	URL           string                 `json:"url"`
	Title         string                 `json:"title"`
	Kind          string                 `json:"kind"`
	Status        string                 `json:"status"`
	Verified      bool                   `json:"verified"`
	VerifiedBy    *struct{ Name string } `json:"verifiedBy"`
	Body          string                 `json:"body"`
	Anchor        json.RawMessage        `json:"anchor"`
	Context       json.RawMessage        `json:"context"`
	Author        struct{ Name string }
	HasScreenshot bool      `json:"hasScreenshot"`
	ReplyCount    int       `json:"replyCount"`
	UpdatedAt     time.Time `json:"updatedAt"`
	Replies       []struct {
		Body      string
		Author    struct{ Name, Kind string }
		CreatedAt time.Time
	} `json:"replies"`
}

func short(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n-1]) + "…"
}

func ref(arg string) string { return url.PathEscape(strings.TrimPrefix(arg, "#")) }

func threads(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: bugspot threads list|show|reply|status|screenshot")
	}
	c, err := newClient()
	if err != nil {
		return err
	}
	switch args[0] {
	case "list":
		fs := flag.NewFlagSet("threads list", flag.ExitOnError)
		status := fs.String("status", "open,in_progress", "statuses, comma separated; empty for all")
		route := fs.String("route", "", "only this page route")
		query := fs.String("q", "", "search text")
		asJSON := fs.Bool("json", false, "print the API answer as is")
		_ = fs.Parse(args[1:])
		q := url.Values{"limit": {"100"}}
		for k, v := range map[string]string{"status": *status, "route": *route, "q": *query} {
			if v != "" {
				q.Set(k, v)
			}
		}
		var raw []byte
		if err := c.do(http.MethodGet, "api/v1/threads?"+q.Encode(), nil, &raw); err != nil {
			return err
		}
		if *asJSON {
			_, err := os.Stdout.Write(raw)
			return err
		}
		var page struct {
			Data []cliThread
			Meta struct{ Total int }
		}
		if err := json.Unmarshal(raw, &page); err != nil {
			return err
		}
		tw := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
		fmt.Fprintln(tw, "#\tSTATUS\tCHECKED\tKIND\tROUTE\tAUTHOR\tREPLIES\tUPDATED\tTEXT")
		for _, t := range page.Data {
			checked := "-"
			if t.Verified {
				checked = "yes"
			}
			fmt.Fprintf(tw, "%d\t%s\t%s\t%s\t%s\t%s\t%d\t%s\t%s\n", t.Number, t.Status, checked, t.Kind, short(t.Route, 40),
				short(t.Author.Name, 20), t.ReplyCount, t.UpdatedAt.Local().Format("01-02 15:04"), short(t.Body, 60))
		}
		if err := tw.Flush(); err != nil {
			return err
		}
		fmt.Fprintf(os.Stderr, "%d of %d\n", len(page.Data), page.Meta.Total)
	case "show":
		if len(args) != 2 {
			return errors.New("usage: bugspot threads show <number or id>")
		}
		var t cliThread
		if err := c.do(http.MethodGet, "api/v1/threads/"+ref(args[1]), nil, &t); err != nil {
			return err
		}
		fmt.Printf("#%d [%s, %s] %s\n%s\nroute: %s\nby: %s\n\n%s\n\nanchor: %s\ncontext: %s\n", t.Number, t.Status, t.Kind,
			t.Title, t.URL, t.Route, t.Author.Name, t.Body, t.Anchor, t.Context)
		if t.VerifiedBy != nil {
			fmt.Printf("checked by a person: %s\n", t.VerifiedBy.Name)
		}
		if t.HasScreenshot {
			fmt.Printf("screenshot: bugspot threads screenshot %d --out screenshot-%d.png\n", t.Number, t.Number)
		}
		for _, r := range t.Replies {
			fmt.Printf("\n— %s (%s, %s):\n%s\n", r.Author.Name, r.Author.Kind, r.CreatedAt.Local().Format("2006-01-02 15:04"), r.Body)
		}
	case "reply":
		if len(args) != 3 {
			return errors.New(`usage: bugspot threads reply <number or id> "text"`)
		}
		return c.do(http.MethodPost, "api/v1/threads/"+ref(args[1])+"/replies", map[string]string{"body": args[2]}, nil)
	case "status":
		if len(args) != 3 {
			return errors.New("usage: bugspot threads status <number or id> open|in_progress|fixed|wontfix")
		}
		return c.do(http.MethodPatch, "api/v1/threads/"+ref(args[1]), map[string]string{"status": args[2]}, nil)
	case "screenshot":
		fs := flag.NewFlagSet("threads screenshot", flag.ExitOnError)
		out := fs.String("out", "", "file to write (required)")
		if len(args) < 2 {
			return errors.New("usage: bugspot threads screenshot <number or id> --out file")
		}
		_ = fs.Parse(args[2:])
		if *out == "" {
			return errors.New("--out is required")
		}
		var data []byte
		if err := c.do(http.MethodGet, "api/v1/threads/"+ref(args[1])+"/screenshot", nil, &data); err != nil {
			return err
		}
		return os.WriteFile(*out, data, 0o600)
	default:
		return fmt.Errorf("unknown threads command %q", args[0])
	}
	return nil
}
