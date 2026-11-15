package storetest

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/svyatoslavratov/bugspot/internal/domain"
	"github.com/svyatoslavratov/bugspot/internal/store"
)

// A comment left on the map shows on every page of its screen: the filter and the summary take the
// route or the screen.
func screenThreads(t *testing.T, s store.Store) {
	ctx := context.Background()
	onMap := thread("m1", "/author/7", "с карты", base)
	onMap.Screen = "/author/{id}"
	other := thread("m2", "/author/9", "на другой карточке", base.Add(time.Minute))
	other.Screen = "/author/{id}"
	plain := thread("m3", "/author/8", "до карты", base.Add(2*time.Minute))
	for _, th := range []*domain.Thread{onMap, other, plain} {
		if err := s.CreateThread(ctx, th); err != nil {
			t.Fatal(err)
		}
	}
	got, err := s.GetThread(ctx, "p", "m1")
	if err != nil || got.Screen != "/author/{id}" {
		t.Fatalf("screen of a thread = %q, %v", got.Screen, err)
	}
	list, total, _ := s.ListThreads(ctx, domain.ThreadFilter{Project: "p", Route: "/author/8", Screen: "/author/{id}"})
	if total != 3 || len(list) != 3 {
		t.Fatalf("route or screen = %v", ids(list))
	}
	list, _, _ = s.ListThreads(ctx, domain.ThreadFilter{Project: "p", Screen: "/author/{id}"})
	if len(list) != 2 {
		t.Fatalf("screen only = %v", ids(list))
	}
	sum, _ := s.Summary(ctx, "p", "/author/8", "/author/{id}")
	if sum.Route[domain.StatusOpen] != 3 {
		t.Fatalf("summary of the page = %+v", sum.Route)
	}
	counts, err := s.ThreadCounts(ctx, "p")
	if err != nil || len(counts) != 3 {
		t.Fatalf("thread counts = %+v, %v", counts, err)
	}
}

func refOf(screen, state string) domain.StateRef {
	return domain.StateRef{Screen: screen, State: state}
}

func screenMap(t *testing.T, s store.Store) {
	ctx := context.Background()
	at := base
	visits := []domain.Visit{
		{Screen: "/campaigns", Title: "Кампании", URL: "https://app.test/#/campaigns", Route: "/campaigns", Roles: []string{"superadmin"}},
		{Screen: "/campaigns", State: "dialog:Новая кампания", Kind: domain.StateDialog, Roles: []string{"scout"}},
		{Screen: "/author/{id}", Title: "Автор", URL: "https://app.test/#/author/7", Route: "/author/7"},
	}
	edges := []domain.Edge{
		{From: refOf("/campaigns", ""), To: refOf("/campaigns", "dialog:Новая кампания"),
			Via: domain.Via{Name: "Создать", Kind: domain.ViaButton, Selector: `button[aria-label="Создать"]`}, Source: domain.EdgeObserved, Count: 1},
		{From: refOf("/campaigns", ""), To: refOf("/brands", ""),
			Via: domain.Via{Name: "Бренды", Kind: domain.ViaLink, Selector: "a#brands"}, Source: domain.EdgeLink},
	}
	if err := s.RecordVisits(ctx, "p", visits, edges, at); err != nil {
		t.Fatal(err)
	}
	// The same transition again: counted, and a link report does not downgrade it.
	again := edges[0]
	again.Source, again.Count, again.LastSeen = domain.EdgeLink, 0, at.Add(time.Hour)
	repeat := edges[0]
	repeat.LastSeen = at.Add(time.Hour)
	if err := s.RecordVisits(ctx, "p", nil, []domain.Edge{again, repeat}, at.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	m, err := s.ScreenMap(ctx, "p")
	if err != nil {
		t.Fatal(err)
	}
	keys := screenKeys(m)
	if !slices.Equal(keys, []string{"/author/{id}", "/brands", "/campaigns"}) {
		t.Fatalf("screens = %v", keys)
	}
	campaigns := find(t, m, "/campaigns")
	if campaigns.Title != "Кампании" || campaigns.ExampleRoute != "/campaigns" || !slices.Equal(campaigns.Roles, []string{"scout", "superadmin"}) {
		t.Fatalf("campaigns = %+v", campaigns)
	}
	if len(campaigns.States) != 2 || campaigns.States[0].Key != "" || campaigns.States[1].Kind != domain.StateDialog ||
		campaigns.States[1].Name != "Новая кампания" {
		t.Fatalf("states = %+v", campaigns.States)
	}
	if brands := find(t, m, "/brands"); brands.FirstSeen != nil {
		t.Fatalf("a screen known only by a link was seen: %+v", brands)
	}
	if len(m.Edges) != 2 {
		t.Fatalf("edges = %+v", m.Edges)
	}
	for _, e := range m.Edges {
		if e.To.Screen == "/campaigns" && (e.Count != 2 || e.Source != domain.EdgeObserved || !e.LastSeen.Equal(at.Add(time.Hour))) {
			t.Fatalf("observed edge = %+v", e)
		}
	}

	if err := s.AddScreen(ctx, "p", domain.Screen{Key: "/reports", Name: "Отчёты", Section: "Аналитика", UpdatedAt: at}); err != nil {
		t.Fatal(err)
	}
	if err := s.AddScreen(ctx, "p", domain.Screen{Key: "/campaigns", UpdatedAt: at}); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("adding a seen screen: %v", err)
	}
	name, section, desc, order := "Кампании", "CRM", "Все кампании бренда", 2
	hidden := true
	err = s.PatchScreens(ctx, "p", []domain.ScreenPatch{
		{Key: "/campaigns", Name: &name, Section: &section, Description: &desc, Order: &order, Position: &domain.Point{X: 10, Y: 20}},
		{Key: "/brands", Hidden: &hidden},
	}, at)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.PatchScreens(ctx, "p", []domain.ScreenPatch{{Key: "/nope", Name: &name}}, at); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("patch of an unknown screen: %v", err)
	}
	stateName := "Создание кампании"
	if err := s.PatchStates(ctx, "p", []domain.StatePatch{{Screen: "/campaigns", State: "dialog:Новая кампания", Name: &stateName, Description: &desc}}, at); err != nil {
		t.Fatal(err)
	}
	if err := s.PatchStates(ctx, "p", []domain.StatePatch{{Screen: "/campaigns", State: "tab:нет", Name: &stateName}}, at); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("patch of an unknown state: %v", err)
	}
	m, _ = s.ScreenMap(ctx, "p")
	if keys := screenKeys(m); !slices.Equal(keys, []string{"/campaigns", "/reports", "/author/{id}", "/brands"}) {
		t.Fatalf("screens by section = %v", keys)
	}
	campaigns = find(t, m, "/campaigns")
	if campaigns.Name != name || campaigns.Section != "CRM" || campaigns.Description != desc || campaigns.Order != 2 ||
		campaigns.Position == nil || campaigns.Position.Y != 20 || campaigns.States[1].Name != stateName {
		t.Fatalf("patched = %+v", campaigns)
	}
	if reports := find(t, m, "/reports"); !reports.Planned || reports.Section != "Аналитика" {
		t.Fatalf("planned = %+v", reports)
	}
	if !find(t, m, "/brands").Hidden {
		t.Fatal("hidden screen is not hidden")
	}
	// A planned screen people reach stops being planned.
	if err := s.RecordVisits(ctx, "p", []domain.Visit{{Screen: "/reports"}}, nil, at); err != nil {
		t.Fatal(err)
	}
	m, _ = s.ScreenMap(ctx, "p")
	if find(t, m, "/reports").Planned {
		t.Fatal("a visited screen stays planned")
	}
	if other, _ := s.ScreenMap(ctx, "q"); len(other.Screens) != 0 {
		t.Fatalf("map of another project = %+v", other.Screens)
	}
}

func mergeScreens(t *testing.T, s store.Store) {
	ctx := context.Background()
	at := base
	visits := []domain.Visit{
		{Screen: "/a/x", Title: "Икс", Roles: []string{"scout"}},
		{Screen: "/a/x", State: "tab:Второй"},
		{Screen: "/a/{id}", Roles: []string{"superadmin"}},
	}
	edges := []domain.Edge{
		{From: refOf("/home", ""), To: refOf("/a/x", ""), Via: domain.Via{Name: "Икс", Kind: domain.ViaLink, Selector: "a"}, Source: domain.EdgeObserved, Count: 1},
		{From: refOf("/home", ""), To: refOf("/a/{id}", ""), Via: domain.Via{Name: "Икс", Kind: domain.ViaLink, Selector: "a"}, Source: domain.EdgeObserved, Count: 2},
	}
	if err := s.RecordVisits(ctx, "p", visits, edges, at); err != nil {
		t.Fatal(err)
	}
	th := thread("x1", "/a/x", "про икс", at)
	th.Screen = "/a/x"
	if err := s.CreateThread(ctx, th); err != nil {
		t.Fatal(err)
	}
	if err := s.PutShot(ctx, "p", refOf("/a/x", "tab:Второй"), "image/webp", []byte("RIFF....WEBP"), at); err != nil {
		t.Fatal(err)
	}
	self := "/a/x"
	if err := s.PatchScreens(ctx, "p", []domain.ScreenPatch{{Key: "/a/x", MergeInto: &self}}, at); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("merge into itself: %v", err)
	}
	nowhere := "/nowhere"
	if err := s.PatchScreens(ctx, "p", []domain.ScreenPatch{{Key: "/a/x", MergeInto: &nowhere}}, at); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("merge into an unknown screen: %v", err)
	}
	into := "/a/{id}"
	if err := s.PatchScreens(ctx, "p", []domain.ScreenPatch{{Key: "/a/x", MergeInto: &into}}, at); err != nil {
		t.Fatal(err)
	}
	m, _ := s.ScreenMap(ctx, "p")
	if keys := screenKeys(m); !slices.Equal(keys, []string{"/a/{id}", "/home"}) || m.Aliases["/a/x"] != "/a/{id}" {
		t.Fatalf("after merge: screens %v, aliases %v", keys, m.Aliases)
	}
	merged := find(t, m, "/a/{id}")
	if len(merged.States) != 2 || !slices.Equal(merged.Roles, []string{"scout", "superadmin"}) {
		t.Fatalf("merged = %+v", merged)
	}
	if len(m.Edges) != 1 || m.Edges[0].Count != 3 {
		t.Fatalf("merged edges = %+v", m.Edges)
	}
	if _, data, err := s.Shot(ctx, "p", refOf("/a/{id}", "tab:Второй")); err != nil || len(data) == 0 {
		t.Fatalf("look of a merged state: %v", err)
	}
	if got, _ := s.GetThread(ctx, "p", "x1"); got.Screen != "/a/{id}" {
		t.Fatalf("thread screen after merge = %q", got.Screen)
	}
	// Visits under the old key land on the screen it was merged into.
	if err := s.RecordVisits(ctx, "p", []domain.Visit{{Screen: "/a/x", State: "dialog:Окно"}}, nil, at); err != nil {
		t.Fatal(err)
	}
	m, _ = s.ScreenMap(ctx, "p")
	if keys := screenKeys(m); len(keys) != 2 || len(find(t, m, "/a/{id}").States) != 3 {
		t.Fatalf("visit by an alias: %v %+v", keys, find(t, m, "/a/{id}").States)
	}
	if err := s.AddScreen(ctx, "p", domain.Screen{Key: "/a/x", UpdatedAt: at}); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("adding an alias as a screen: %v", err)
	}
}

func looks(t *testing.T, s store.Store) {
	ctx := context.Background()
	ref := refOf("/campaigns", "tab:Активные")
	if _, _, err := s.Shot(ctx, "p", ref); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("no shot yet: %v", err)
	}
	if err := s.PutShot(ctx, "p", ref, "image/webp", []byte("shot-1"), base); err != nil {
		t.Fatal(err)
	}
	if err := s.PutShot(ctx, "p", ref, "image/jpeg", []byte("shot-2"), base); err != nil {
		t.Fatal(err)
	}
	if ct, data, err := s.Shot(ctx, "p", ref); err != nil || ct != "image/jpeg" || string(data) != "shot-2" {
		t.Fatalf("shot = %s %s %v", ct, data, err)
	}
	snap := domain.Snapshot{Screen: ref.Screen, State: ref.State, HTML: []byte("<html></html>"), CSS: []string{"aa", "bb"},
		Outline: json.RawMessage(`{"title":"Кампании"}`), Viewport: domain.Size{W: 1440, H: 900}, Hash: "h1", At: base}
	if err := s.PutSnapshot(ctx, "p", snap); err != nil {
		t.Fatal(err)
	}
	got, err := s.Snapshot(ctx, "p", ref)
	if err != nil || string(got.HTML) != "<html></html>" || !slices.Equal(got.CSS, []string{"aa", "bb"}) ||
		string(got.Outline) != `{"title":"Кампании"}` || got.Viewport.W != 1440 || got.Hash != "h1" || !got.At.Equal(base) {
		t.Fatalf("snapshot = %+v, %v", got, err)
	}
	m, _ := s.ScreenMap(ctx, "p")
	st := find(t, m, "/campaigns").States[0]
	if st.Kind != domain.StateTab || st.Name != "Активные" || !st.HasShot || !st.HasSnapshot || st.Hash != "h1" ||
		st.Viewport == nil || st.Viewport.H != 900 || st.CapturedAt == nil {
		t.Fatalf("state with a look = %+v", st)
	}

	missing, err := s.MissingAssets(ctx, "p", []string{"aa", "bb", "aa"})
	if err != nil || !slices.Equal(missing, []string{"aa", "bb"}) {
		t.Fatalf("missing = %v, %v", missing, err)
	}
	if err := s.PutAsset(ctx, "p", "aa", "text/css", []byte("body{}")); err != nil {
		t.Fatal(err)
	}
	if err := s.PutAsset(ctx, "p", "aa", "text/css", []byte("changed")); err != nil {
		t.Fatal(err)
	}
	if missing, _ := s.MissingAssets(ctx, "p", []string{"aa", "bb"}); !slices.Equal(missing, []string{"bb"}) {
		t.Fatalf("missing after put = %v", missing)
	}
	if ct, data, err := s.Asset(ctx, "p", "aa"); err != nil || ct != "text/css" || string(data) != "body{}" {
		t.Fatalf("asset = %s %s %v", ct, data, err)
	}
	if _, _, err := s.Asset(ctx, "q", "aa"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("asset of another project: %v", err)
	}
}

func screenKeys(m domain.ScreenMap) []string {
	keys := make([]string, len(m.Screens))
	for i, sc := range m.Screens {
		keys[i] = sc.Key
	}
	return keys
}

func find(t *testing.T, m domain.ScreenMap, key string) domain.Screen {
	t.Helper()
	for _, sc := range m.Screens {
		if sc.Key == key {
			return sc
		}
	}
	t.Fatalf("no screen %q in %v", key, screenKeys(m))
	return domain.Screen{}
}

// A manifest names seen screens, plans the others, describes states and declares transitions,
// all in one go; importing it again changes nothing new.
func importMap(t *testing.T, s store.Store) {
	ctx := context.Background()
	at := base
	if err := s.RecordVisits(ctx, "p", []domain.Visit{{Screen: "/campaigns", Title: "Кампании"}, {Screen: "/old"}}, nil, at); err != nil {
		t.Fatal(err)
	}
	into := "/campaigns"
	if err := s.PatchScreens(ctx, "p", []domain.ScreenPatch{{Key: "/old", MergeInto: &into}}, at); err != nil {
		t.Fatal(err)
	}
	str := func(v string) *string { return &v }
	order, hidden := 3, true
	man := domain.Manifest{Screens: []domain.ManifestScreen{
		{Key: "/old", Name: str("Кампании"), Section: str("CRM"), Order: &order,
			States: []domain.ManifestState{{Key: "tab:Архив", Description: str("Завершённые кампании")}, {Key: "dialog:Новая"}},
			To:     []domain.ManifestEdge{{Screen: "/reports", Via: "Отчёт", Kind: domain.ViaLink}, {Screen: "/campaigns/{id}", From: "dialog:Новая", Via: "Создать"}}},
		{Key: "/reports", Name: str("Отчёты"), Description: str("Сводка по кампаниям"), Hidden: &hidden},
	}}
	res, err := s.ImportMap(ctx, "p", man, at)
	if err != nil {
		t.Fatal(err)
	}
	if res != (domain.ImportResult{Created: 1, Updated: 1, States: 1, Edges: 2}) {
		t.Fatalf("result = %+v", res)
	}
	m, _ := s.ScreenMap(ctx, "p")
	campaigns := find(t, m, "/campaigns")
	if campaigns.Name != "Кампании" || campaigns.Section != "CRM" || campaigns.Order != 3 || campaigns.Title != "Кампании" || campaigns.Planned {
		t.Fatalf("named through an alias = %+v", campaigns)
	}
	if len(campaigns.States) != 3 || campaigns.States[2].Key != "tab:Архив" || campaigns.States[2].Description != "Завершённые кампании" ||
		campaigns.States[2].Kind != domain.StateTab {
		t.Fatalf("states = %+v", campaigns.States)
	}
	reports := find(t, m, "/reports")
	if !reports.Planned || reports.Name != "Отчёты" || !reports.Hidden || reports.Description != "Сводка по кампаниям" {
		t.Fatalf("planned from the manifest = %+v", reports)
	}
	if find(t, m, "/campaigns/{id}").Planned {
		t.Fatal("a screen only pointed at is planned")
	}
	if len(m.Edges) != 2 {
		t.Fatalf("edges = %+v", m.Edges)
	}
	for _, e := range m.Edges {
		if e.Source != domain.EdgeDeclared || e.From.Screen != "/campaigns" {
			t.Fatalf("edge = %+v", e)
		}
		if e.To.Screen == "/reports" && (e.Via.Name != "Отчёт" || e.Via.Kind != domain.ViaLink) {
			t.Fatalf("edge to reports = %+v", e)
		}
		if e.To.Screen == "/campaigns/{id}" && e.From.State != "dialog:Новая" {
			t.Fatalf("edge from the dialog = %+v", e)
		}
	}
	res, err = s.ImportMap(ctx, "p", man, at)
	if err != nil || res.Created != 0 || res.Updated != 2 {
		t.Fatalf("again = %+v, %v", res, err)
	}
	if again, _ := s.ScreenMap(ctx, "p"); len(again.Screens) != len(m.Screens) || len(again.Edges) != 2 {
		t.Fatalf("again: %d screens, %d edges", len(again.Screens), len(again.Edges))
	}
}
