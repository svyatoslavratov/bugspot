package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/svyatoslavratov/bugspot/internal/domain"
	"github.com/svyatoslavratov/bugspot/internal/secret"
)

// mapEnv: admins open the map, everyone signed in builds it; an agent token may read and edit it.
func mapEnv(t *testing.T) (*env, string) {
	e := newEnv(t, func(o *Options) {
		o.Policy.Map = rules(t, "role:admin")
		o.Policy.Collect = rules(t, "authenticated")
		o.MapMask = "text"
		o.Widget = fstest.MapFS{"widget.js": {Data: []byte("/*loader*/")}, "map.html": {Data: []byte("<!doctype html><title>map</title>")}}
	})
	mapAgent := secret.New(secret.AgentPrefix)
	_ = e.store.CreateCredential(context.Background(), domain.Credential{ID: "a2", Kind: domain.CredentialAgent, Name: "Cartographer",
		Hash: secret.Hash(mapAgent), Scopes: []string{domain.ScopeRead, domain.ScopeMap}, CreatedAt: now})
	return e, mapAgent
}

type mapBody struct {
	Screens []domain.Screen                  `json:"screens"`
	Edges   []domain.Edge                    `json:"edges"`
	Aliases map[string]string                `json:"aliases"`
	Threads map[string]map[domain.Status]int `json:"threads"`
}

func (e *env) visit(user string, body any) int {
	e.t.Helper()
	return e.do(call{method: "POST", path: "/api/v1/map/visits", user: user, body: body}).Code
}

func TestMapAccess(t *testing.T) {
	e, mapAgent := mapEnv(t)
	s := decodeBody[sessionBody](t, e.do(call{method: "GET", path: "/api/v1/session", user: "anna"}))
	if !s.Can.Collect || s.Can.Map || s.Map == nil || s.Map.Mask != "text" || s.Map.SnapshotMaxBytes != maxSnapshot {
		t.Fatalf("collector session = %+v %+v", s.Can, s.Map)
	}
	admin := decodeBody[sessionBody](t, e.do(call{method: "GET", path: "/api/v1/session", user: "boss", roles: "admin"}))
	if !admin.Can.Map {
		t.Fatalf("admin may not open the map: %+v", admin.Can)
	}
	if w := e.do(call{method: "GET", path: "/api/v1/map", user: "anna"}); w.Code != http.StatusForbidden {
		t.Fatalf("map for a collector: %d", w.Code)
	}
	if w := e.do(call{method: "GET", path: "/api/v1/map", headers: map[string]string{"X-Bugspot-Token": mapAgent}}); w.Code != 200 {
		t.Fatalf("map for an agent with the map scope: %d %s", w.Code, w.Body)
	}
	if w := e.do(call{method: "GET", path: "/api/v1/map", headers: map[string]string{"X-Bugspot-Token": e.agent}}); w.Code != http.StatusForbidden {
		t.Fatalf("map for an agent without the map scope: %d", w.Code)
	}
	// An agent with the map scope crawls the app: it reports what it sees like a person.
	agentVisit := e.do(call{method: "POST", path: "/api/v1/map/visits", headers: map[string]string{"X-Bugspot-Token": mapAgent},
		body: map[string]any{"visits": []any{map[string]any{"screen": "/a"}}}})
	if agentVisit.Code != http.StatusNoContent {
		t.Fatalf("a crawling agent reports visits: %d %s", agentVisit.Code, agentVisit.Body)
	}
	otherVisit := e.do(call{method: "POST", path: "/api/v1/map/visits", headers: map[string]string{"X-Bugspot-Token": e.agent},
		body: map[string]any{"visits": []any{map[string]any{"screen": "/a"}}}})
	if otherVisit.Code != http.StatusForbidden {
		t.Fatalf("an agent without the map scope reports visits: %d", otherVisit.Code)
	}
	if w := e.do(call{method: "GET", path: "/api/v1/map/captures"}); w.Code != http.StatusForbidden {
		t.Fatalf("captures for nobody: %d", w.Code)
	}
	page := e.do(call{method: "GET", path: "/map"})
	csp := page.Header().Get("Content-Security-Policy")
	// The live app opens in a frame: the allowed origins may be framed.
	if page.Code != 200 || !strings.Contains(csp, "frame-ancestors 'self'") || !strings.Contains(csp, "frame-src 'self' https://app.example.com;") ||
		!strings.HasPrefix(page.Header().Get("Content-Type"), "text/html") {
		t.Fatalf("map page: %d %v", page.Code, page.Header())
	}
	noPage := newEnv(t, nil)
	if w := noPage.do(call{method: "GET", path: "/map"}); w.Code != http.StatusNotFound {
		t.Fatalf("map page without a build: %d", w.Code)
	}
}

func TestMapVisitsAndCounts(t *testing.T) {
	e, _ := mapEnv(t)
	body := map[string]any{
		"visits": []any{
			map[string]any{"screen": "/author/{id}", "title": "Автор", "url": "https://app.example.com/#/author/7", "route": "/author/7"},
			map[string]any{"screen": "/author/{id}", "state": "dialog:Цена", "kind": "dialog"},
		},
		"edges": []any{
			map[string]any{"from": map[string]any{"screen": "/authors"}, "to": map[string]any{"screen": "/author/{id}"},
				"via": map[string]any{"name": "Иванов", "kind": "link", "selector": "a.row"}, "source": "observed"},
			map[string]any{"from": map[string]any{"screen": "/author/{id}"}, "to": map[string]any{"screen": "/author/{id}", "state": "dialog:Цена"},
				"via": map[string]any{"name": "Изменить цену", "selector": "button#price"}, "source": "declared"},
		},
	}
	if code := e.visit("anna", body); code != http.StatusNoContent {
		t.Fatalf("visits: %d", code)
	}
	if code := e.visit("anna", map[string]any{"visits": []any{map[string]any{"screen": "/x", "kind": "popup"}}}); code != http.StatusBadRequest {
		t.Fatalf("unknown kind: %d", code)
	}
	if code := e.visit("anna", map[string]any{"visits": []any{map[string]any{"screen": ""}}}); code != http.StatusBadRequest {
		t.Fatalf("empty screen: %d", code)
	}
	if code := e.visit("anna", map[string]any{"visits": []any{map[string]any{"screen": "/x", "url": "javascript:alert(1)"}}}); code != http.StatusBadRequest {
		t.Fatalf("bad url: %d", code)
	}
	bad := map[string]any{"edges": []any{map[string]any{"from": map[string]any{"screen": "/a"}, "to": map[string]any{"screen": "/b"},
		"via": map[string]any{"kind": "teleport"}, "source": "observed"}}}
	if code := e.visit("anna", bad); code != http.StatusBadRequest {
		t.Fatalf("unknown via kind: %d", code)
	}
	many := make([]any, maxVisitBatch+1)
	for i := range many {
		many[i] = map[string]any{"screen": "/x"}
	}
	if code := e.visit("anna", map[string]any{"visits": many}); code != http.StatusBadRequest {
		t.Fatalf("too many visits: %d", code)
	}

	// Threads count on their screens: a new one by its screen, an old one by its route with ids folded.
	e.create("anna", "/author/9")
	old := domain.Thread{ID: "old", Project: "demo", Route: "/author/5", URL: "https://app.example.com/#/author/5",
		Kind: domain.KindIssue, Status: domain.StatusInProgress, Body: "до карты", Author: domain.Author{ID: "anna", Name: "anna"},
		CreatedAt: now, UpdatedAt: now}
	if err := e.store.CreateThread(context.Background(), &old); err != nil {
		t.Fatal(err)
	}

	m := decodeBody[mapBody](t, e.do(call{method: "GET", path: "/api/v1/map", user: "boss", roles: "admin"}))
	if len(m.Screens) != 2 || len(m.Edges) != 2 {
		t.Fatalf("map = %+v", m)
	}
	var author domain.Screen
	for _, sc := range m.Screens {
		if sc.Key == "/author/{id}" {
			author = sc
		}
	}
	if author.Title != "Автор" || author.ExampleRoute != "/author/7" || len(author.States) != 2 {
		t.Fatalf("author screen = %+v", author)
	}
	if got := m.Threads["/author/{id}"]; got[domain.StatusOpen] != 1 || got[domain.StatusInProgress] != 1 {
		t.Fatalf("threads on the screen = %+v", m.Threads)
	}
	captures := decodeBody[struct {
		States []captureInfo `json:"states"`
	}](t, e.do(call{method: "GET", path: "/api/v1/map/captures", user: "anna"}))
	if len(captures.States) != 3 {
		t.Fatalf("captures = %+v", captures.States)
	}
}

func sha(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func TestMapLooks(t *testing.T) {
	e, _ := mapEnv(t)
	css := "body{color:red}"
	hash := sha(css)
	missing := decodeBody[struct {
		Missing []string `json:"missing"`
	}](t, e.do(call{method: "POST", path: "/api/v1/map/assets/missing", user: "anna", body: map[string]any{"hashes": []string{hash}}}))
	if len(missing.Missing) != 1 {
		t.Fatalf("missing = %v", missing.Missing)
	}
	if w := e.do(call{method: "POST", path: "/api/v1/map/assets/missing", user: "anna", body: map[string]any{"hashes": []string{"nope"}}}); w.Code != 400 {
		t.Fatalf("bad hash: %d", w.Code)
	}
	snapshot := map[string]any{"html": `<html><head><style data-bugspot-asset="` + hash + `"></style></head><body><h1>Кампании</h1></body></html>`,
		"css": []string{hash}, "outline": map[string]any{"title": "Кампании"}, "viewport": map[string]int{"w": 1440, "h": 900}, "hash": "s1"}
	path := "/api/v1/map/snapshot?screen=/campaigns&state=tab:Активные"
	if w := e.do(call{method: "PUT", path: path, user: "anna", body: snapshot}); w.Code != 400 || !strings.Contains(w.Body.String(), "stylesheets first") {
		t.Fatalf("snapshot before its css: %d %s", w.Code, w.Body)
	}
	if w := e.do(call{method: "PUT", path: "/api/v1/map/assets/" + hash, user: "anna", raw: []byte("body{}")}); w.Code != 400 {
		t.Fatalf("css that does not match its hash: %d", w.Code)
	}
	if w := e.do(call{method: "PUT", path: "/api/v1/map/assets/" + hash, user: "anna", raw: []byte(css)}); w.Code != http.StatusNoContent {
		t.Fatalf("css: %d %s", w.Code, w.Body)
	}
	if w := e.do(call{method: "PUT", path: path, user: "anna", body: snapshot}); w.Code != http.StatusNoContent {
		t.Fatalf("snapshot: %d %s", w.Code, w.Body)
	}
	noViewport := map[string]any{"html": "<html></html>", "viewport": map[string]int{"w": 0, "h": 0}}
	if w := e.do(call{method: "PUT", path: path, user: "anna", body: noViewport}); w.Code != 400 {
		t.Fatalf("snapshot without a viewport: %d", w.Code)
	}
	if w := e.do(call{method: "GET", path: path, user: "anna"}); w.Code != http.StatusForbidden {
		t.Fatalf("a collector reads snapshots: %d", w.Code)
	}
	got := decodeBody[struct {
		HTML     string            `json:"html"`
		CSS      map[string]string `json:"css"`
		Viewport domain.Size       `json:"viewport"`
	}](t, e.do(call{method: "GET", path: path, user: "boss", roles: "admin"}))
	if !strings.Contains(got.HTML, "<h1>Кампании</h1>") || got.CSS[hash] != css || got.Viewport.W != 1440 {
		t.Fatalf("snapshot = %+v", got)
	}

	outline := e.do(call{method: "GET", path: path + "&fields=outline", user: "boss", roles: "admin"})
	if outline.Code != 200 || strings.Contains(outline.Body.String(), "html") || !strings.Contains(outline.Body.String(), "Кампании") {
		t.Fatalf("outline only: %d %s", outline.Code, outline.Body)
	}

	webp := []byte("RIFF\x00\x00\x00\x00WEBPVP8 ")
	shot := "/api/v1/map/shot?screen=/campaigns&state=tab:Активные"
	if w := e.do(call{method: "GET", path: shot, user: "boss", roles: "admin"}); w.Code != http.StatusNotFound {
		t.Fatalf("no shot yet: %d", w.Code)
	}
	if w := e.do(call{method: "PUT", path: shot, user: "anna", raw: []byte("<svg/>")}); w.Code != 400 {
		t.Fatalf("not an image: %d", w.Code)
	}
	if w := e.do(call{method: "PUT", path: shot, user: "anna", raw: webp}); w.Code != http.StatusNoContent {
		t.Fatalf("shot: %d %s", w.Code, w.Body)
	}
	img := e.do(call{method: "GET", path: shot, user: "boss", roles: "admin"})
	if img.Code != 200 || img.Header().Get("Content-Type") != "image/webp" {
		t.Fatalf("shot: %d %v", img.Code, img.Header())
	}
	if w := e.do(call{method: "PUT", path: "/api/v1/map/shot?screen=", user: "anna", raw: webp}); w.Code != 400 {
		t.Fatalf("shot without a screen: %d", w.Code)
	}
}

func TestMapEditing(t *testing.T) {
	e, mapAgent := mapEnv(t)
	if code := e.visit("anna", map[string]any{"visits": []any{
		map[string]any{"screen": "/authors"}, map[string]any{"screen": "/authors/list"}, map[string]any{"screen": "/authors", "state": "tab:Все"},
	}}); code != http.StatusNoContent {
		t.Fatalf("visits: %d", code)
	}
	asAgent := map[string]string{"X-Bugspot-Token": mapAgent}
	patch := []any{map[string]any{"key": "/authors", "name": "Авторы", "section": "База", "description": "Список авторов"},
		map[string]any{"key": "/authors/list", "mergeInto": "/authors"}}
	if w := e.do(call{method: "PATCH", path: "/api/v1/map/screens", user: "anna", body: patch}); w.Code != http.StatusForbidden {
		t.Fatalf("a collector edits the map: %d", w.Code)
	}
	if w := e.do(call{method: "PATCH", path: "/api/v1/map/screens", headers: asAgent, body: patch}); w.Code != http.StatusNoContent {
		t.Fatalf("agent patch: %d %s", w.Code, w.Body)
	}
	self := []any{map[string]any{"key": "/authors", "mergeInto": "/authors"}}
	if w := e.do(call{method: "PATCH", path: "/api/v1/map/screens", headers: asAgent, body: self}); w.Code != http.StatusConflict {
		t.Fatalf("merge into itself: %d", w.Code)
	}
	if w := e.do(call{method: "PATCH", path: "/api/v1/map/screens", headers: asAgent, body: []any{map[string]any{"key": "/nope", "name": "x"}}}); w.Code != http.StatusNotFound {
		t.Fatalf("unknown screen: %d", w.Code)
	}
	if w := e.do(call{method: "PATCH", path: "/api/v1/map/screens", headers: asAgent, body: []any{}}); w.Code != 400 {
		t.Fatalf("empty patch: %d", w.Code)
	}
	states := []any{map[string]any{"screen": "/authors", "state": "tab:Все", "description": "Все авторы базы"}}
	if w := e.do(call{method: "PATCH", path: "/api/v1/map/states", user: "boss", roles: "admin", body: states}); w.Code != http.StatusNoContent {
		t.Fatalf("states: %d %s", w.Code, w.Body)
	}
	planned := map[string]any{"key": "/reports", "name": "Отчёты", "section": "Аналитика"}
	if w := e.do(call{method: "POST", path: "/api/v1/map/screens", headers: asAgent, body: planned}); w.Code != http.StatusCreated {
		t.Fatalf("planned screen: %d %s", w.Code, w.Body)
	}
	if w := e.do(call{method: "POST", path: "/api/v1/map/screens", headers: asAgent, body: planned}); w.Code != http.StatusConflict {
		t.Fatalf("planned twice: %d", w.Code)
	}
	edge := map[string]any{"from": map[string]any{"screen": "/authors"}, "to": map[string]any{"screen": "/reports"},
		"via": map[string]any{"name": "Отчёт по авторам", "kind": "button"}}
	if w := e.do(call{method: "POST", path: "/api/v1/map/edges", headers: asAgent, body: edge}); w.Code != http.StatusCreated {
		t.Fatalf("declared edge: %d %s", w.Code, w.Body)
	}
	m := decodeBody[mapBody](t, e.do(call{method: "GET", path: "/api/v1/map", headers: asAgent}))
	if len(m.Screens) != 2 || m.Aliases["/authors/list"] != "/authors" || len(m.Edges) != 1 ||
		m.Edges[0].Source != domain.EdgeDeclared || m.Edges[0].Via.Selector != "declared:Отчёт по авторам" {
		t.Fatalf("map after editing = %+v", m)
	}
	for _, sc := range m.Screens {
		if sc.Key == "/authors" && (sc.Name != "Авторы" || sc.Section != "База" || sc.States[1].Description != "Все авторы базы") {
			t.Fatalf("authors = %+v", sc)
		}
		if sc.Key == "/reports" && !sc.Planned {
			t.Fatalf("reports = %+v", sc)
		}
	}
}

// A comment left on the map shows on every page of its screen.
func TestThreadScreens(t *testing.T) {
	e, _ := mapEnv(t)
	onMap := newThread("/author/7")
	onMap["screen"] = "author-card"
	if w := e.do(call{method: "POST", path: "/api/v1/threads", user: "anna", body: onMap}); w.Code != http.StatusCreated {
		t.Fatalf("thread with a screen: %d %s", w.Code, w.Body)
	}
	plain := e.create("anna", "/author/9")
	if plain.Screen != "/author/{id}" {
		t.Fatalf("default screen = %q", plain.Screen)
	}
	list := decodeBody[struct {
		Data []threadView `json:"data"`
	}](t, e.do(call{method: "GET", path: "/api/v1/threads?route=/author/3&screen=author-card", user: "anna"}))
	if len(list.Data) != 1 || list.Data[0].Screen != "author-card" {
		t.Fatalf("threads of the screen = %+v", list.Data)
	}
	sum := decodeBody[domain.Summary](t, e.do(call{method: "GET", path: "/api/v1/threads/summary?route=/author/9&screen=author-card", user: "anna"}))
	if sum.Route[domain.StatusOpen] != 2 {
		t.Fatalf("summary of the page = %+v", sum.Route)
	}
}

func TestMapManifest(t *testing.T) {
	e, mapAgent := mapEnv(t)
	agent := map[string]string{"X-Bugspot-Token": mapAgent}
	if code := e.visit("anna", map[string]any{"visits": []any{map[string]any{"screen": "/authors", "title": "Авторы"}}}); code != http.StatusNoContent {
		t.Fatalf("visit: %d", code)
	}
	manifest := `{"version": 1, "screens": [
		{"key": "/authors", "name": "Авторы", "section": "Каталог", "to": ["/authors/:id", {"screen": "/reports", "via": "Отчёт", "kind": "link"}],
		 "states": [{"key": "tab:Архив", "description": "Ушедшие авторы"}]},
		{"key": "/authors/[id]", "name": "Карточка автора"},
		{"key": "/reports", "name": "Отчёты", "hidden": true}
	]}`
	w := e.do(call{method: "POST", path: "/api/v1/map/manifest", headers: agent, raw: []byte(manifest)})
	if w.Code != 200 {
		t.Fatalf("import: %d %s", w.Code, w.Body)
	}
	if res := decodeBody[domain.ImportResult](t, w); res != (domain.ImportResult{Created: 2, Updated: 1, States: 1, Edges: 2}) {
		t.Fatalf("result = %+v", res)
	}
	m := decodeBody[mapBody](t, e.do(call{method: "GET", path: "/api/v1/map", headers: agent}))
	keys := []string{}
	for _, sc := range m.Screens {
		keys = append(keys, sc.Key)
	}
	if strings.Join(keys, " ") != "/authors/{id} /authors /reports" && strings.Join(keys, " ") != "/authors /authors/{id} /reports" {
		t.Fatalf("route patterns fold into screen keys: %v", keys)
	}

	w = e.do(call{method: "GET", path: "/api/v1/map/manifest", user: "boss", roles: "admin"})
	if w.Code != 200 || !strings.Contains(w.Header().Get("Content-Disposition"), "bugspot-map.json") {
		t.Fatalf("export: %d %v", w.Code, w.Header())
	}
	out := decodeBody[domain.Manifest](t, w)
	if out.Version != 1 || len(out.Screens) != 3 {
		t.Fatalf("exported = %+v", out)
	}
	for _, ms := range out.Screens {
		switch ms.Key {
		case "/authors":
			if ms.Name == nil || *ms.Name != "Авторы" || len(ms.To) != 2 || len(ms.States) != 1 || ms.States[0].Key != "tab:Архив" {
				t.Fatalf("authors = %+v", ms)
			}
		case "/reports":
			if ms.Hidden == nil || !*ms.Hidden || ms.Description != nil {
				t.Fatalf("reports = %+v", ms)
			}
		}
	}
	// What was exported imports back without changes.
	again := e.do(call{method: "POST", path: "/api/v1/map/manifest", user: "boss", roles: "admin", raw: w.Body.Bytes()})
	if again.Code != 200 || decodeBody[domain.ImportResult](t, again).Created != 0 {
		t.Fatalf("round trip: %d %s", again.Code, again.Body)
	}

	for name, c := range map[string]struct {
		body string
		code int
		user string
	}{
		"a collector":   {`{"screens": []}`, http.StatusForbidden, "anna"},
		"unknown field": {`{"screens": [{"key": "/a", "summary": "x"}]}`, http.StatusBadRequest, "boss"},
		"empty key":     {`{"screens": [{"key": " "}]}`, http.StatusBadRequest, "boss"},
		"newer version": {`{"version": 2, "screens": []}`, http.StatusBadRequest, "boss"},
		"bad kind":      {`{"screens": [{"key": "/a", "to": [{"screen": "/b", "kind": "teleport"}]}]}`, http.StatusBadRequest, "boss"},
		"long name":     {`{"screens": [{"key": "/a", "name": "` + strings.Repeat("я", maxScreenName+1) + `"}]}`, http.StatusBadRequest, "boss"},
	} {
		roles := ""
		if c.user == "boss" {
			roles = "admin"
		}
		if w := e.do(call{method: "POST", path: "/api/v1/map/manifest", user: c.user, roles: roles, raw: []byte(c.body)}); w.Code != c.code {
			t.Errorf("%s: %d %s", name, w.Code, w.Body)
		}
	}
	if w := e.do(call{method: "GET", path: "/api/v1/map/manifest", user: "anna"}); w.Code != http.StatusForbidden {
		t.Fatalf("export for a collector: %d", w.Code)
	}
}
