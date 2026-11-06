package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// fakeAPI answers like the service for thread #7 and records what the MCP server sent.
func fakeAPI(t *testing.T, calls *[]string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Bugspot-Token") != "bsp_test" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		body := new(bytes.Buffer)
		_, _ = body.ReadFrom(r.Body)
		*calls = append(*calls, r.Method+" "+r.URL.RequestURI()+" "+strings.TrimSpace(body.String()))
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/bugspot/api/v1/threads":
			_, _ = w.Write([]byte(`{"data":[{"id":"t7","number":7,"status":"open","kind":"issue","route":"/a","body":"Кнопка","author":{"name":"Анна"},
				"anchor":{"selector":"#x"},"context":{"console":[]},"updatedAt":"2026-11-06T12:00:00Z"}],"meta":{"total":1}}`))
		case r.URL.Path == "/bugspot/api/v1/threads/7/screenshot":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte("\x89PNG\r\n\x1a\n0000"))
		case r.Method == http.MethodPatch && strings.Contains(body.String(), "resolved"):
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"error":"not allowed","code":"forbidden"}`))
		case r.Method == http.MethodPatch:
			_, _ = w.Write([]byte(`{"id":"t7","number":7,"status":"in_progress","updatedAt":"2026-11-06T12:00:00Z","author":{"name":"Анна"}}`))
		default:
			_, _ = w.Write([]byte(`{"ok":true}`))
		}
	}))
}

func TestMCP(t *testing.T) {
	var calls []string
	api := fakeAPI(t, &calls)
	defer api.Close()
	base, _ := url.Parse(api.URL + "/bugspot/")
	s := &mcpServer{api: &client{base: base, token: "bsp_test", http: &http.Client{Timeout: 5 * time.Second}}}

	in := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_threads","arguments":{"status":["open"]}}}`,
		`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"set_status","arguments":{"thread":"#7","status":"in_progress"}}}`,
		`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"set_status","arguments":{"thread":"7","status":"resolved"}}}`,
		`{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"get_screenshot","arguments":{"thread":"7"}}}`,
		`{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"reply","arguments":{"thread":"7","body":"Исправлено в 1.2"}}}`,
		`{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"drop_tables","arguments":{}}}`,
		`{"jsonrpc":"2.0","id":9,"method":"resources/list"}`,
		`not json`,
	}, "\n")
	var out bytes.Buffer
	if err := s.serve(strings.NewReader(in), &out); err != nil {
		t.Fatal(err)
	}
	var responses []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("bad response line %q", line)
		}
		responses = append(responses, m)
	}
	if len(responses) != 10 {
		t.Fatalf("%d responses (the notification must get none):\n%s", len(responses), out.String())
	}
	result := func(i int) map[string]any { return responses[i]["result"].(map[string]any) }
	if v := result(0)["protocolVersion"]; v != "2025-06-18" {
		t.Errorf("negotiated version = %v", v)
	}
	if tools := result(1)["tools"].([]any); len(tools) != len(mcpTools) {
		t.Errorf("tools/list = %d tools", len(tools))
	}
	text := func(i int) string {
		return result(i)["content"].([]any)[0].(map[string]any)["text"].(string)
	}
	if got := text(2); !strings.Contains(got, `"number":7`) || strings.Contains(got, "selector") {
		t.Errorf("list_threads should be compact: %s", got)
	}
	if !strings.Contains(text(3), `"status":"in_progress"`) {
		t.Errorf("set_status = %s", text(3))
	}
	if result(4)["isError"] != true || !strings.Contains(text(4), "403") {
		t.Errorf("resolving must come back as a tool error: %v", result(4))
	}
	img := result(5)["content"].([]any)[0].(map[string]any)
	if img["type"] != "image" || img["mimeType"] != "image/png" || img["data"] == "" {
		t.Errorf("get_screenshot = %v", img)
	}
	if responses[7]["error"] == nil || responses[8]["error"] == nil || responses[9]["error"] == nil {
		t.Errorf("unknown tool, unknown method and broken JSON must be JSON-RPC errors")
	}
	want := []string{
		"GET /bugspot/api/v1/threads?limit=50&status=open ",
		`PATCH /bugspot/api/v1/threads/7 {"status":"in_progress"}`,
		`PATCH /bugspot/api/v1/threads/7 {"status":"resolved"}`,
		"GET /bugspot/api/v1/threads/7/screenshot ",
		`POST /bugspot/api/v1/threads/7/replies {"body":"Исправлено в 1.2"}`,
	}
	if strings.Join(calls, "\n") != strings.Join(want, "\n") {
		t.Errorf("API calls:\n%s\nwant:\n%s", strings.Join(calls, "\n"), strings.Join(want, "\n"))
	}
}
