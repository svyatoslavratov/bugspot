package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/cookiejar"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type runResult struct {
	code           int
	stdout, stderr string
}

// newApp runs commands with env as the whole environment.
func newApp(ctx context.Context, env map[string]string, stdin string) (*app, *bytes.Buffer, *bytes.Buffer) {
	var out, errOut bytes.Buffer
	return &app{ctx: ctx, stdin: strings.NewReader(stdin), stdout: &out, stderr: &errOut,
		getenv: func(k string) string { return env[k] }}, &out, &errOut
}

func run(t *testing.T, env map[string]string, args ...string) runResult {
	t.Helper()
	a, out, errOut := newApp(context.Background(), env, "")
	code := a.run(args)
	return runResult{code: code, stdout: out.String(), stderr: errOut.String()}
}

func TestRunCommands(t *testing.T) {
	if r := run(t, nil, "version"); r.code != 0 || strings.TrimSpace(r.stdout) != version {
		t.Fatalf("version = %+v", r)
	}
	if r := run(t, nil, "help"); r.code != 0 || !strings.Contains(r.stdout, "bugspot mcp") {
		t.Fatalf("help = %+v", r)
	}
	if r := run(t, nil, "launch"); r.code != 2 || !strings.Contains(r.stderr, `unknown command "launch"`) {
		t.Fatalf("unknown command = %+v", r)
	}
	if r := run(t, nil, "token", "create", "-h"); r.code != 0 || !strings.Contains(r.stderr, "-scopes") {
		t.Fatalf("flag help = %+v", r)
	}
	if r := run(t, map[string]string{"BUGSPOT_AUTH": "ldap"}, "serve"); r.code != 1 || !strings.Contains(r.stderr, "ldap") {
		t.Fatalf("bad configuration = %+v", r)
	}
	if r := run(t, nil, "threads", "list"); r.code != 1 || !strings.Contains(r.stderr, "BUGSPOT_URL") {
		t.Fatalf("client without settings = %+v", r)
	}
	if r := run(t, nil, "mcp"); r.code != 1 || !strings.Contains(r.stderr, "BUGSPOT_TOKEN") {
		t.Fatalf("mcp without settings = %+v", r)
	}
}

func TestCredentials(t *testing.T) {
	env := map[string]string{"BUGSPOT_DATA_DIR": t.TempDir()}
	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{"token"}, "usage"},
		{[]string{"token", "create"}, "--name is required"},
		{[]string{"token", "create", "--name", "x", "--scopes", "read,admin"}, `unknown scope "admin"`},
		{[]string{"token", "revoke"}, "usage"},
		{[]string{"token", "revoke", "nope"}, "not found"},
		{[]string{"key", "rotate"}, `unknown key command "rotate"`},
	} {
		if r := run(t, env, c.args...); r.code != 1 || !strings.Contains(r.stderr, c.want) {
			t.Errorf("%v = %+v, want %q", c.args, r, c.want)
		}
	}

	token := run(t, env, "token", "create", "--name", "claude", "--expires", "24h")
	if token.code != 0 || !strings.HasPrefix(token.stdout, "bsp_") || !strings.Contains(token.stderr, "shown once") {
		t.Fatalf("token create = %+v", token)
	}
	key := run(t, env, "key", "create", "--name", "Customer", "--roles", "customer, qa")
	if key.code != 0 || !strings.HasPrefix(key.stdout, "bsk_") || !strings.Contains(key.stderr, "?bugspot_key=") {
		t.Fatalf("key create = %+v", key)
	}
	list := run(t, env, "token", "list")
	if !strings.Contains(list.stdout, "claude") || !strings.Contains(list.stdout, "read,reply,status") || strings.Contains(list.stdout, "Customer") {
		t.Fatalf("token list = %+v", list)
	}
	keys := run(t, env, "key", "list")
	if !strings.Contains(keys.stdout, "customer,qa") || !strings.Contains(keys.stdout, "active") {
		t.Fatalf("key list = %+v", keys)
	}
	id := strings.Fields(strings.Split(keys.stdout, "\n")[1])[0]
	if r := run(t, env, "key", "revoke", id); r.code != 0 || !strings.Contains(r.stderr, "Revoked key") {
		t.Fatalf("revoke = %+v", r)
	}
	if r := run(t, env, "key", "list"); !strings.Contains(r.stdout, "inactive") {
		t.Fatalf("revoked key still active: %s", r.stdout)
	}
}

func freeAddr(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = l.Close() }()
	return l.Addr().String()
}

// TestServeAndClient starts the real service on SQLite, writes a thread as a visitor, and drives
// it with the threads commands and the MCP server as an agent.
func TestServeAndClient(t *testing.T) {
	dir := t.TempDir()
	addr := freeAddr(t)
	env := map[string]string{
		"BUGSPOT_ADDR": addr, "BUGSPOT_DATA_DIR": dir, "BUGSPOT_PROJECT": "cli",
		"BUGSPOT_AUTH": "anonymous", "BUGSPOT_VIEW": "*", "BUGSPOT_COMMENT": "*",
	}
	ctx, cancel := context.WithCancel(context.Background())
	server, serverOut, _ := newApp(ctx, env, "")
	served := make(chan error, 1)
	go func() { served <- server.serve(nil) }()
	deadline := time.Now().Add(10 * time.Second)
	for run(t, env, "healthcheck").code != 0 {
		if time.Now().After(deadline) {
			t.Fatal("the service did not become healthy")
		}
		time.Sleep(50 * time.Millisecond)
	}

	base := "http://" + addr
	jar, _ := cookiejar.New(nil)
	browser := &http.Client{Jar: jar, Timeout: 5 * time.Second}
	res, err := browser.Get(base + "/api/v1/session")
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	post := func(method, path, contentType string, body []byte) *http.Response {
		req, _ := http.NewRequest(method, base+path, bytes.NewReader(body))
		req.Header.Set("Content-Type", contentType)
		req.Header.Set("X-Bugspot-Request", "1")
		res, err := browser.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		return res
	}
	thread, _ := json.Marshal(map[string]any{"route": "/a", "url": base + "/a", "body": "The button is cut", "authorName": "Pete"})
	if res := post(http.MethodPost, "/api/v1/threads", "application/json", thread); res.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d", res.StatusCode)
	}
	png := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 32)...)
	if res := post(http.MethodPut, "/api/v1/threads/1/screenshot", "image/png", png); res.StatusCode != http.StatusNoContent {
		t.Fatalf("screenshot: %d", res.StatusCode)
	}

	token := strings.TrimSpace(run(t, env, "token", "create", "--name", "claude").stdout)
	agent := map[string]string{"BUGSPOT_URL": base, "BUGSPOT_TOKEN": token}
	if r := run(t, agent, "threads", "list"); r.code != 0 || !strings.Contains(r.stdout, "The button is cut") || !strings.Contains(r.stderr, "1 of 1") {
		t.Fatalf("threads list = %+v", r)
	}
	if r := run(t, agent, "threads", "list", "--json", "--status", ""); r.code != 0 || !strings.HasPrefix(r.stdout, `{"data":[`) {
		t.Fatalf("threads list --json = %+v", r)
	}
	if r := run(t, agent, "threads", "status", "#1", "in_progress"); r.code != 0 {
		t.Fatalf("threads status = %+v", r)
	}
	if r := run(t, agent, "threads", "reply", "1", "Fixed in 1.2"); r.code != 0 {
		t.Fatalf("threads reply = %+v", r)
	}
	if r := run(t, agent, "threads", "status", "1", "resolved"); r.code != 1 || !strings.Contains(r.stderr, "403") {
		t.Fatalf("the agent resolved a thread: %+v", r)
	}
	show := run(t, agent, "threads", "show", "1")
	if show.code != 0 || !strings.Contains(show.stdout, "[in_progress, issue]") || !strings.Contains(show.stdout, "Fixed in 1.2") ||
		!strings.Contains(show.stdout, "screenshot:") || !strings.Contains(show.stdout, "by: Pete") {
		t.Fatalf("threads show = %+v", show)
	}
	shot := filepath.Join(dir, "shot.png")
	if r := run(t, agent, "threads", "screenshot", "1", "--out", shot); r.code != 0 {
		t.Fatalf("threads screenshot = %+v", r)
	}
	if data, _ := os.ReadFile(shot); !bytes.Equal(data, png) {
		t.Fatal("the downloaded screenshot differs")
	}
	for _, args := range [][]string{{"threads"}, {"threads", "show"}, {"threads", "reply", "1"}, {"threads", "status", "1"},
		{"threads", "screenshot", "1"}, {"threads", "screenshot"}, {"threads", "close", "1"}} {
		if r := run(t, agent, args...); r.code != 1 {
			t.Errorf("%v = %+v, want an error", args, r)
		}
	}
	if r := run(t, map[string]string{"BUGSPOT_URL": base, "BUGSPOT_TOKEN": "bsp_wrong"}, "threads", "list"); r.code != 1 || !strings.Contains(r.stderr, "401") {
		t.Fatalf("a wrong token = %+v", r)
	}

	mcpIn := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_thread","arguments":{"thread":"1"}}}` + "\n" +
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"summary","arguments":{"route":"/a"}}}` + "\n" +
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_threads","arguments":{"route":"/a","q":"button","limit":500,"status":"in_progress"}}}` + "\n" +
		`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_thread","arguments":{}}}` + "\n" +
		`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"reply","arguments":{"thread":"1"}}}` + "\n" +
		`{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"set_status","arguments":"oops"}}` + "\n" +
		`{"jsonrpc":"2.0","id":7,"method":"ping"}` + "\n" +
		`{"jsonrpc":"2.0","id":8,"method":"initialize","params":{"protocolVersion":"1999-01-01"}}` + "\n"
	m, mcpOut, _ := newApp(context.Background(), agent, mcpIn)
	if err := m.mcp(nil); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(mcpOut.String()), "\n")
	if len(lines) != 8 {
		t.Fatalf("mcp answered %d lines:\n%s", len(lines), mcpOut)
	}
	for i, want := range []string{`Fixed in 1.2`, `\"in_progress\":1`, `\"total\":1`, `thread is required`, `"isError":true`, `"isError":true`, `"result":{}`, `"protocolVersion":"2025-11-25"`} {
		if !strings.Contains(lines[i], want) {
			t.Errorf("mcp line %d = %s, want %s", i+1, lines[i], want)
		}
	}

	cancel()
	if err := <-served; err != nil {
		t.Fatalf("serve after shutdown: %v", err)
	}
	if !strings.Contains(serverOut.String(), `"msg":"bugspot started"`) {
		t.Fatalf("no start log: %s", serverOut)
	}
	if r := run(t, env, "healthcheck"); r.code != 1 {
		t.Fatalf("healthcheck of a stopped service = %+v", r)
	}
	if r := run(t, nil, "healthcheck", "--url", "http://"+addr+"/nothing"); r.code != 1 {
		t.Fatalf("healthcheck of a wrong URL = %+v", r)
	}
}
