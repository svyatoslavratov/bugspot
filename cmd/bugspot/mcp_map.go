package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
)

// The screen map tools: the agent reads the map (screens, their states, what leads where, the
// outline and the look of a page) and makes it readable for people — names screens, groups them
// into sections, writes what each screen and state is for, merges duplicates, declares screens and
// transitions the widget cannot see. They need a token with the map scope.

const mcpMapInstructions = `

The screen map (tools *_map, *_screen*, *_states, add_*) shows the screens of the app, their states
(the page itself "", a selected tab "tab:…", an open dialog "dialog:…") and the transitions between
them, built by the widget while people use the app. Make it readable: get_map, then for screens
without a name or description get_screen (the page outline: headings, actions, fields, tables) and
get_screen_image (a real thumbnail); then update_screens with a short name, a section (a group of
screens people think of together, e.g. by role or area) and a description of what the screen is
for and who uses it; update_states for tabs and dialogs; merge duplicates with mergeInto. Screen
keys are routes with ids folded into {id}. A map that is empty or missing screens is built at once
by "bugspot map crawl <app address>" (a token with the read and map scopes) or by "Build the map" in
the widget; suggest it rather than guessing screens.`

var stateRefSchema = object(map[string]any{
	"screen": map[string]any{"type": "string", "description": "Screen key, e.g. /author/{id}"},
	"state":  map[string]any{"type": "string", "description": `State key: "" for the page, "tab:…", "dialog:…"`},
}, "screen")

var mapTools = []mcpTool{
	{
		Name: "get_map", Title: "Read the screen map",
		Description: "Screens by section with their names, descriptions, roles, states, active threads and where each state leads (via which elements). Hidden screens and transitions through the app's menu only when asked.",
		InputSchema: object(map[string]any{"include_hidden": map[string]any{"type": "boolean"}, "include_nav": map[string]any{"type": "boolean"}}),
		Annotations: readOnly,
	},
	{
		Name: "get_screen", Title: "Read a screen",
		Description: "One screen: its states with the page outline of each (title, headings, actions, fields, tables), transitions in and out (the app's menu only when asked), and its active threads.",
		InputSchema: object(map[string]any{"screen": map[string]any{"type": "string"}, "include_nav": map[string]any{"type": "boolean"}}, "screen"),
		Annotations: readOnly,
	},
	{
		Name: "get_screen_image", Title: "Look at a screen",
		Description: "The real thumbnail of a state of a screen.",
		InputSchema: stateRefSchema,
		Annotations: readOnly,
	},
	{
		Name: "update_screens", Title: "Name, group and describe screens",
		Description: "Change several screens at once: name, section (group), description (what it is for, who uses it), order inside the section, hidden; mergeInto moves a duplicate into another screen and keeps its key as an alias.",
		InputSchema: object(map[string]any{"screens": map[string]any{"type": "array", "minItems": 1, "maxItems": 200,
			"items": object(map[string]any{
				"key":         map[string]any{"type": "string"},
				"name":        map[string]any{"type": "string", "maxLength": 120},
				"section":     map[string]any{"type": "string", "maxLength": 120},
				"description": map[string]any{"type": "string", "maxLength": 4000},
				"order":       map[string]any{"type": "integer"},
				"hidden":      map[string]any{"type": "boolean"},
				"mergeInto":   map[string]any{"type": "string"},
			}, "key")}}, "screens"),
		Annotations: writes,
	},
	{
		Name: "update_states", Title: "Name and describe states",
		Description: "Change several states (tabs, dialogs, the page itself) at once: name and description.",
		InputSchema: object(map[string]any{"states": map[string]any{"type": "array", "minItems": 1, "maxItems": 200,
			"items": object(map[string]any{
				"screen":      map[string]any{"type": "string"},
				"state":       map[string]any{"type": "string"},
				"name":        map[string]any{"type": "string", "maxLength": 120},
				"description": map[string]any{"type": "string", "maxLength": 4000},
			}, "screen", "state")}}, "states"),
		Annotations: writes,
	},
	{
		Name: "add_screen", Title: "Declare a planned screen",
		Description: "A screen that is not in the app yet (or nobody reached): it shows on the map without a look until people visit it.",
		InputSchema: object(map[string]any{
			"key":         map[string]any{"type": "string", "description": "Its route, e.g. /reports or /report/{id}"},
			"name":        map[string]any{"type": "string"},
			"section":     map[string]any{"type": "string"},
			"description": map[string]any{"type": "string"},
		}, "key"),
		Annotations: writes,
	},
	{
		Name: "add_edge", Title: "Declare a transition",
		Description: "A transition the widget cannot see by itself, e.g. one that only follows a successful save, or one to a planned screen.",
		InputSchema: object(map[string]any{
			"from": stateRefSchema,
			"to":   stateRefSchema,
			"via": object(map[string]any{
				"name": map[string]any{"type": "string", "description": "The button or link, as people see it"},
				"kind": map[string]any{"type": "string", "enum": []string{"link", "button", "tab", "nav", "auto"}},
			}, "name"),
		}, "from", "to", "via"),
		Annotations: writes,
	},
}

// mapScreen is what the API returns for a screen.
type mapScreen struct {
	Key          string     `json:"key"`
	Name         string     `json:"name"`
	Section      string     `json:"section"`
	Description  string     `json:"description"`
	Title        string     `json:"title"`
	Order        int        `json:"order"`
	ExampleURL   string     `json:"exampleUrl"`
	ExampleRoute string     `json:"exampleRoute"`
	Roles        []string   `json:"roles"`
	Hidden       bool       `json:"hidden"`
	Planned      bool       `json:"planned"`
	States       []mapState `json:"states"`
}

type mapState struct {
	Key         string `json:"key"`
	Kind        string `json:"kind"`
	Name        string `json:"name"`
	Description string `json:"description"`
	HasShot     bool   `json:"hasShot"`
	HasSnapshot bool   `json:"hasSnapshot"`
}

type mapRef struct {
	Screen string `json:"screen"`
	State  string `json:"state"`
}

type mapEdge struct {
	From mapRef `json:"from"`
	To   mapRef `json:"to"`
	Via  struct {
		Name string `json:"name"`
		Kind string `json:"kind"`
	} `json:"via"`
	Source string `json:"source"`
	Count  int    `json:"count"`
}

type mapBody struct {
	Screens []mapScreen               `json:"screens"`
	Edges   []mapEdge                 `json:"edges"`
	Aliases map[string]string         `json:"aliases"`
	Threads map[string]map[string]int `json:"threads"`
}

// compactEdge is a transition as the agent reads it from one screen: from (or into) which of its
// states, the other screen and state, and the elements it goes through.
type compactEdge struct {
	From   string   `json:"from,omitempty"`
	Into   string   `json:"into,omitempty"`
	Screen string   `json:"screen"`
	State  string   `json:"state,omitempty"`
	Via    []string `json:"via,omitempty"`
	Kind   string   `json:"kind"`
	Source string   `json:"source"`
	Count  int      `json:"count,omitempty"`
}

type compactState struct {
	Key         string `json:"key"`
	Kind        string `json:"kind"`
	Name        string `json:"name,omitempty"`
	Description string `json:"description,omitempty"`
	Look        bool   `json:"look"`
}

type compactScreen struct {
	Key         string         `json:"key"`
	Name        string         `json:"name,omitempty"`
	Title       string         `json:"title,omitempty"`
	Description string         `json:"description,omitempty"`
	Roles       []string       `json:"roles,omitempty"`
	Planned     bool           `json:"planned,omitempty"`
	Hidden      bool           `json:"hidden,omitempty"`
	Threads     int            `json:"activeThreads,omitempty"`
	States      []compactState `json:"states"`
	To          []compactEdge  `json:"to,omitempty"`
}

func activeThreads(counts map[string]int) int {
	n := 0
	for _, c := range counts {
		n += c
	}
	return n
}

func compactStates(states []mapState) []compactState {
	out := make([]compactState, len(states))
	for i, st := range states {
		out[i] = compactState{Key: st.Key, Kind: st.Kind, Name: st.Name, Description: st.Description, Look: st.HasShot || st.HasSnapshot}
	}
	return out
}

var sourceRank = map[string]int{"link": 0, "observed": 1, "declared": 2}

// sideOf reads the transitions of a screen from one side, merged by the states they join: out —
// where its states lead, in — what leads to it. The app's menu leads everywhere, so it is left out
// unless asked for.
func sideOf(edges []mapEdge, screen string, out, nav bool) []compactEdge {
	var list []compactEdge
	index := map[string]int{}
	for _, e := range edges {
		here, there := e.From, e.To
		if !out {
			here, there = e.To, e.From
		}
		if here.Screen != screen || (e.Via.Kind == "nav" && !nav) {
			continue
		}
		key := here.State + "\x00" + there.Screen + "\x00" + there.State
		i, ok := index[key]
		if !ok {
			c := compactEdge{Screen: there.Screen, State: there.State, Kind: e.Via.Kind, Source: e.Source}
			if out {
				c.From = here.State
			} else {
				c.Into = here.State
			}
			list = append(list, c)
			i = len(list) - 1
			index[key] = i
		}
		c := &list[i]
		if e.Via.Name != "" && !slices.Contains(c.Via, e.Via.Name) {
			c.Via = append(c.Via, e.Via.Name)
		}
		if sourceRank[e.Source] > sourceRank[c.Source] {
			c.Source = e.Source
		}
		c.Count += e.Count
	}
	return list
}

func (s *mcpServer) loadMap() (mapBody, error) {
	var raw []byte
	if err := s.api.do(http.MethodGet, "api/v1/map", nil, &raw); err != nil {
		return mapBody{}, err
	}
	var m mapBody
	err := json.Unmarshal(raw, &m)
	return m, err
}

func stateQuery(screen, state string) string {
	return url.Values{"screen": {screen}, "state": {state}}.Encode()
}

// callMap runs a map tool; handled is false for other tools.
func (s *mcpServer) callMap(name string, raw json.RawMessage) (content []mcpContent, handled bool, err error) {
	var out []byte
	switch name {
	case "get_map":
		var a struct {
			IncludeHidden bool `json:"include_hidden"`
			IncludeNav    bool `json:"include_nav"`
		}
		_ = json.Unmarshal(raw, &a)
		m, err := s.loadMap()
		if err != nil {
			return nil, true, err
		}
		content, err := compactMap(m, a.IncludeHidden, a.IncludeNav)
		return content, true, err
	case "get_screen":
		var a struct {
			Screen     string `json:"screen"`
			IncludeNav bool   `json:"include_nav"`
		}
		if err := json.Unmarshal(raw, &a); err != nil || strings.TrimSpace(a.Screen) == "" {
			return nil, true, errors.New("screen is required")
		}
		content, err := s.screenDetail(a.Screen, a.IncludeNav)
		return content, true, err
	case "get_screen_image":
		var a mapRef
		if err := json.Unmarshal(raw, &a); err != nil || strings.TrimSpace(a.Screen) == "" {
			return nil, true, errors.New("screen is required")
		}
		if err := s.api.do(http.MethodGet, "api/v1/map/shot?"+stateQuery(a.Screen, a.State), nil, &out); err != nil {
			return nil, true, err
		}
		return []mcpContent{{Type: "image", Data: base64.StdEncoding.EncodeToString(out), MimeType: http.DetectContentType(out)}}, true, nil
	case "update_screens", "update_states":
		field, path := "screens", "api/v1/map/screens"
		if name == "update_states" {
			field, path = "states", "api/v1/map/states"
		}
		var a map[string]json.RawMessage
		if err := json.Unmarshal(raw, &a); err != nil || len(a[field]) == 0 {
			return nil, true, fmt.Errorf("%s is required", field)
		}
		if err := s.api.do(http.MethodPatch, path, a[field], &out); err != nil {
			return nil, true, err
		}
		return textJSON([]byte(`{"ok":true}`)), true, nil
	case "add_screen":
		if err := s.api.do(http.MethodPost, "api/v1/map/screens", raw, &out); err != nil {
			return nil, true, err
		}
		return textJSON(out), true, nil
	case "add_edge":
		if err := s.api.do(http.MethodPost, "api/v1/map/edges", raw, &out); err != nil {
			return nil, true, err
		}
		return textJSON(out), true, nil
	}
	return nil, false, nil
}

func compactMap(m mapBody, includeHidden, includeNav bool) ([]mcpContent, error) {
	type section struct {
		Name    string          `json:"name"`
		Screens []compactScreen `json:"screens"`
	}
	var sections []section
	hidden := 0
	for _, sc := range m.Screens {
		if sc.Hidden && !includeHidden {
			hidden++
			continue
		}
		name := sc.Section
		if name == "" {
			name = "(no section)"
		}
		if len(sections) == 0 || sections[len(sections)-1].Name != name {
			sections = append(sections, section{Name: name})
		}
		last := &sections[len(sections)-1]
		last.Screens = append(last.Screens, compactScreen{Key: sc.Key, Name: sc.Name, Title: sc.Title,
			Description: sc.Description, Roles: sc.Roles, Planned: sc.Planned, Hidden: sc.Hidden,
			Threads: activeThreads(m.Threads[sc.Key]), States: compactStates(sc.States), To: sideOf(m.Edges, sc.Key, true, includeNav)})
	}
	out, err := json.Marshal(map[string]any{"sections": sections, "hiddenScreens": hidden, "aliases": m.Aliases})
	return textJSON(out), err
}

// screenDetail is one screen with the outline of each captured state, its transitions and its
// active threads.
func (s *mcpServer) screenDetail(key string, nav bool) ([]mcpContent, error) {
	m, err := s.loadMap()
	if err != nil {
		return nil, err
	}
	if to, ok := m.Aliases[key]; ok {
		key = to
	}
	var screen *mapScreen
	for i := range m.Screens {
		if m.Screens[i].Key == key {
			screen = &m.Screens[i]
		}
	}
	if screen == nil {
		return nil, fmt.Errorf("no screen %q on the map", key)
	}
	type stateDetail struct {
		compactState
		Outline json.RawMessage `json:"outline,omitempty"`
	}
	states := make([]stateDetail, len(screen.States))
	for i, st := range screen.States {
		states[i] = stateDetail{compactState: compactStates([]mapState{st})[0]}
		if !st.HasSnapshot {
			continue
		}
		var raw []byte
		if err := s.api.do(http.MethodGet, "api/v1/map/snapshot?"+stateQuery(key, st.Key)+"&fields=outline", nil, &raw); err != nil {
			return nil, err
		}
		var snap struct {
			Outline json.RawMessage `json:"outline"`
		}
		if json.Unmarshal(raw, &snap) == nil {
			states[i].Outline = snap.Outline
		}
	}
	q := url.Values{"screen": {key}, "status": {"open,in_progress,fixed"}, "limit": {"50"}}
	if screen.ExampleRoute != "" {
		q.Set("route", screen.ExampleRoute)
	}
	var threads []byte
	if err := s.api.do(http.MethodGet, "api/v1/threads?"+q.Encode(), nil, &threads); err != nil {
		return nil, err
	}
	list, err := compactList(threads)
	if err != nil {
		return nil, err
	}
	out, err := json.Marshal(map[string]any{
		"key": screen.Key, "name": screen.Name, "section": screen.Section, "title": screen.Title,
		"description": screen.Description, "roles": screen.Roles, "exampleUrl": screen.ExampleURL, "planned": screen.Planned,
		"hidden": screen.Hidden, "states": states, "to": sideOf(m.Edges, key, true, nav), "from": sideOf(m.Edges, key, false, nav),
		"threads": json.RawMessage(list[0].Text),
	})
	return textJSON(out), err
}
