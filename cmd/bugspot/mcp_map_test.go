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

const fakeMap = `{"screens":[
	{"key":"/campaigns","name":"Кампании","section":"CRM","title":"Кампании","roles":["superadmin"],"exampleRoute":"/campaigns",
	 "states":[{"key":"","kind":"page","hasShot":true,"hasSnapshot":true},{"key":"dialog:Новая","kind":"dialog","name":"Новая"}]},
	{"key":"/author/{id}","title":"Автор","states":[{"key":"","kind":"page","hasShot":true}]},
	{"key":"/old","hidden":true,"states":[]}],
 "edges":[{"from":{"screen":"/campaigns","state":""},"to":{"screen":"/author/{id}","state":""},"via":{"name":"Иванов","kind":"link"},"source":"observed","count":3},
          {"from":{"screen":"/campaigns","state":""},"to":{"screen":"/author/{id}","state":""},"via":{"name":"Петров","kind":"link"},"source":"link","count":0},
          {"from":{"screen":"/campaigns","state":""},"to":{"screen":"/old","state":""},"via":{"name":"Старое","kind":"nav"},"source":"link","count":0}],
 "aliases":{"/authors/list":"/campaigns"},
 "threads":{"/campaigns":{"open":2,"fixed":1}}}`

func TestMCPMap(t *testing.T) {
	var calls []string
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := new(bytes.Buffer)
		_, _ = body.ReadFrom(r.Body)
		calls = append(calls, r.Method+" "+r.URL.RequestURI()+" "+strings.TrimSpace(body.String()))
		switch {
		case r.URL.Path == "/api/v1/map":
			_, _ = w.Write([]byte(fakeMap))
		case r.URL.Path == "/api/v1/map/snapshot":
			_, _ = w.Write([]byte(`{"outline":{"title":"Кампании","headings":["Активные кампании"],"actions":["Создать"]}}`))
		case r.URL.Path == "/api/v1/map/shot":
			_, _ = w.Write([]byte("\x89PNG\r\n\x1a\n0000"))
		case r.URL.Path == "/api/v1/threads":
			_, _ = w.Write([]byte(`{"data":[{"id":"t1","number":1,"status":"open","route":"/campaigns","body":"Поиск","author":{"name":"Анна"},"updatedAt":"2026-11-06T12:00:00Z"}],"meta":{"total":1}}`))
		case r.Method == http.MethodPatch:
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"ok":true}`))
		}
	}))
	defer api.Close()
	base, _ := url.Parse(api.URL + "/")
	s := &mcpServer{api: &client{base: base, token: "bsp_test", http: &http.Client{Timeout: 5 * time.Second}}}

	call := func(name, args string) (string, bool) {
		t.Helper()
		content, err := s.call(name, json.RawMessage(args))
		if err != nil {
			return err.Error(), false
		}
		if content[0].Type == "image" {
			return content[0].MimeType, true
		}
		return content[0].Text, true
	}

	text, _ := call("get_map", `{}`)
	var m struct {
		Sections []struct {
			Name    string
			Screens []struct {
				Key           string
				ActiveThreads int
				States        []struct{ Look bool }
				To            []struct {
					Screen string
					Via    []string
				}
			}
		}
		HiddenScreens int
	}
	if err := json.Unmarshal([]byte(text), &m); err != nil {
		t.Fatal(err)
	}
	if len(m.Sections) != 2 || m.Sections[0].Name != "CRM" || m.Sections[1].Name != "(no section)" || m.HiddenScreens != 1 {
		t.Fatalf("get_map = %s", text)
	}
	campaigns := m.Sections[0].Screens[0]
	if campaigns.ActiveThreads != 3 || !campaigns.States[0].Look || campaigns.States[1].Look ||
		len(campaigns.To) != 1 || strings.Join(campaigns.To[0].Via, ",") != "Иванов,Петров" {
		t.Fatalf("campaigns = %+v", campaigns)
	}
	if text, _ := call("get_map", `{"include_hidden":true}`); !strings.Contains(text, `"key":"/old"`) {
		t.Fatalf("hidden screens when asked: %s", text)
	}
	if text, _ := call("get_map", `{"include_nav":true}`); !strings.Contains(text, "Старое") {
		t.Fatalf("menu transitions when asked: %s", text)
	}

	text, ok := call("get_screen", `{"screen":"/authors/list"}`)
	if !ok || !strings.Contains(text, `"key":"/campaigns"`) || !strings.Contains(text, "Активные кампании") ||
		!strings.Contains(text, `"number":1`) {
		t.Fatalf("get_screen by an alias = %s", text)
	}
	if text, ok := call("get_screen", `{"screen":"/nope"}`); ok || !strings.Contains(text, "no screen") {
		t.Fatalf("unknown screen = %s", text)
	}
	if mime, ok := call("get_screen_image", `{"screen":"/campaigns"}`); !ok || mime != "image/png" {
		t.Fatalf("get_screen_image = %s", mime)
	}
	if _, ok := call("update_screens", `{"screens":[{"key":"/campaigns","description":"Все кампании"}]}`); !ok {
		t.Fatal("update_screens failed")
	}
	if text, ok := call("update_states", `{}`); ok || !strings.Contains(text, "states is required") {
		t.Fatalf("update_states without states = %s", text)
	}
	if _, ok := call("add_screen", `{"key":"/reports","name":"Отчёты"}`); !ok {
		t.Fatal("add_screen failed")
	}
	if _, ok := call("add_edge", `{"from":{"screen":"/campaigns"},"to":{"screen":"/reports"},"via":{"name":"Отчёт"}}`); !ok {
		t.Fatal("add_edge failed")
	}
	joined := strings.Join(calls, "\n")
	for _, want := range []string{
		"GET /api/v1/map/snapshot?screen=%2Fcampaigns&state=&fields=outline ",
		"GET /api/v1/threads?limit=50&route=%2Fcampaigns&screen=%2Fcampaigns&status=open%2Cin_progress%2Cfixed ",
		"GET /api/v1/map/shot?screen=%2Fcampaigns&state= ",
		`PATCH /api/v1/map/screens [{"key":"/campaigns","description":"Все кампании"}]`,
		`POST /api/v1/map/screens {"key":"/reports","name":"Отчёты"}`,
		`POST /api/v1/map/edges {"from":{"screen":"/campaigns"},"to":{"screen":"/reports"},"via":{"name":"Отчёт"}}`,
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("no call %q in:\n%s", want, joined)
		}
	}
}
