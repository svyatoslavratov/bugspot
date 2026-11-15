package domain

import (
	"encoding/json"
	"strings"
	"time"
)

// Manifest is the part of the screen map people and agents write, kept as a file next to the app:
// screens with their names, sections and descriptions, descriptions of their states, and the
// transitions the widget cannot see. Exporting writes it from the map; importing applies it, and
// screens the map does not have yet become planned ones. Fields left out stay as they are.
type Manifest struct {
	// Version of the format; 1.
	Version int              `json:"version,omitempty"`
	Screens []ManifestScreen `json:"screens"`
}

// ManifestScreen is one screen. Key is a screen key or a route pattern of the app's router:
// parameters (:id, [id], {id}, <id>, *) fold into {id} as the widget folds ids.
type ManifestScreen struct {
	Key         string          `json:"key"`
	Name        *string         `json:"name,omitempty"`
	Section     *string         `json:"section,omitempty"`
	Description *string         `json:"description,omitempty"`
	Order       *int            `json:"order,omitempty"`
	Hidden      *bool           `json:"hidden,omitempty"`
	States      []ManifestState `json:"states,omitempty"`
	To          []ManifestEdge  `json:"to,omitempty"`
}

// ManifestState describes a state of the screen: "" is the page, "tab:<names>" a selected tab,
// "dialog:<title>" an open dialog.
type ManifestState struct {
	Key         string  `json:"key"`
	Name        *string `json:"name,omitempty"`
	Description *string `json:"description,omitempty"`
}

// ManifestEdge is a declared transition from the screen (its state From) to a state of another
// screen through an element named Via. In a file it may be just the target key: "to": ["/reports"].
type ManifestEdge struct {
	Screen string  `json:"screen"`
	State  string  `json:"state,omitempty"`
	From   string  `json:"from,omitempty"`
	Via    string  `json:"via,omitempty"`
	Kind   ViaKind `json:"kind,omitempty"`
}

// UnmarshalJSON takes a transition as an object or as a bare screen key.
func (e *ManifestEdge) UnmarshalJSON(data []byte) error {
	var key string
	if err := json.Unmarshal(data, &key); err == nil {
		*e = ManifestEdge{Screen: key}
		return nil
	}
	type plain ManifestEdge
	return json.Unmarshal(data, (*plain)(e))
}

// Patch is the change the screen's fields make to a screen that exists.
func (ms ManifestScreen) Patch() ScreenPatch {
	return ScreenPatch{Key: ms.Key, Name: ms.Name, Section: ms.Section, Description: ms.Description, Order: ms.Order,
		Hidden: ms.Hidden}
}

// Changes reports whether the patch sets anything.
func (p ScreenPatch) Changes() bool {
	return p.Name != nil || p.Section != nil || p.Description != nil || p.Order != nil || p.Hidden != nil ||
		p.Position != nil || p.MergeInto != nil
}

// Edges are the declared transitions of the screen with the key it has on the map.
func (ms ManifestScreen) Edges(key string, at time.Time) []Edge {
	edges := make([]Edge, 0, len(ms.To))
	for _, t := range ms.To {
		kind := t.Kind
		if kind == "" {
			kind = ViaButton
		}
		edges = append(edges, Edge{
			From:   StateRef{Screen: key, State: t.From},
			To:     StateRef{Screen: t.Screen, State: t.State},
			Via:    Via{Name: t.Via, Kind: kind, Selector: "declared:" + t.Via},
			Source: EdgeDeclared, LastSeen: at,
		})
	}
	return edges
}

// ImportResult counts what an import changed.
type ImportResult struct {
	Created int `json:"created"`
	Updated int `json:"updated"`
	States  int `json:"states"`
	Edges   int `json:"edges"`
}

// PatternKey turns a route pattern into a screen key: /authors/:id/edit → /authors/{id}/edit.
// Keys that are not routes (data-bugspot-screen names) stay as they are; a query stays too.
func PatternKey(key string) string {
	if !strings.HasPrefix(key, "/") {
		return key
	}
	path, query, hasQuery := strings.Cut(key, "?")
	parts := strings.Split(path, "/")
	for i, p := range parts {
		if param(p) || IDLike(p) {
			parts[i] = "{id}"
		}
	}
	path = strings.Join(parts, "/")
	if hasQuery {
		return path + "?" + query
	}
	return path
}

func param(seg string) bool {
	if seg == "*" || strings.HasPrefix(seg, ":") {
		return true
	}
	for _, pair := range []string{"[]", "{}", "<>"} {
		if len(seg) > 2 && seg[0] == pair[0] && seg[len(seg)-1] == pair[1] {
			return true
		}
	}
	return false
}
