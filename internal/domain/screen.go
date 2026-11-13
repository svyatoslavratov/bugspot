package domain

import (
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"
)

// The screen map: the screens of the app, their states (the page itself, a selected tab, an open
// dialog), what leads from one to another, and a real look at each state — a thumbnail and a DOM
// snapshot. The widget builds it while people use the app; people and agents name, group and
// describe the screens.

// StateKind is what a state of a screen is.
type StateKind string

// State kinds.
const (
	StatePage   StateKind = "page"
	StateTab    StateKind = "tab"
	StateDialog StateKind = "dialog"
)

// Valid reports whether k is a known kind.
func (k StateKind) Valid() bool { return k == StatePage || k == StateTab || k == StateDialog }

// StateKindOf tells the kind by the key the widget gives a state: "" is the page itself,
// "tab:<names>" a selected tab, "dialog:<title>" an open dialog.
func StateKindOf(key string) StateKind {
	switch {
	case strings.HasPrefix(key, "tab:"):
		return StateTab
	case strings.HasPrefix(key, "dialog:"):
		return StateDialog
	}
	return StatePage
}

// StateNameOf is the name a state key carries: the tab names or the dialog title.
func StateNameOf(key string) string {
	_, name, _ := strings.Cut(key, ":")
	return name
}

// EdgeSource tells how a transition became known: seen after a click, read from a link on the
// page, or declared by the app (data-bugspot-to) or by a person or an agent.
type EdgeSource string

// Edge sources.
const (
	EdgeObserved EdgeSource = "observed"
	EdgeLink     EdgeSource = "link"
	EdgeDeclared EdgeSource = "declared"
)

// Valid reports whether s is a known source.
func (s EdgeSource) Valid() bool { return s == EdgeObserved || s == EdgeLink || s == EdgeDeclared }

// ViaKind is what was used to go: a link, a button, a tab, an item of the app's navigation, or
// nothing (a redirect).
type ViaKind string

// Via kinds.
const (
	ViaLink   ViaKind = "link"
	ViaButton ViaKind = "button"
	ViaTab    ViaKind = "tab"
	ViaNav    ViaKind = "nav"
	ViaAuto   ViaKind = "auto"
)

// Valid reports whether k is a known kind.
func (k ViaKind) Valid() bool {
	return k == ViaLink || k == ViaButton || k == ViaTab || k == ViaNav || k == ViaAuto
}

// Point is a position on the map canvas.
type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// Size is a width and a height in CSS pixels.
type Size struct {
	W int `json:"w"`
	H int `json:"h"`
}

// Screen is one screen of the app. Key is how the widget names it: the route with ids folded
// into {id}, or the value of data-bugspot-screen.
type Screen struct {
	Key string `json:"key"`
	// Name, Section and Description are given by people or agents; Title is what the page said.
	Name        string `json:"name"`
	Section     string `json:"section"`
	Description string `json:"description"`
	Title       string `json:"title"`
	// Order sorts screens inside a section.
	Order int `json:"order"`
	// ExampleURL is a real address of the screen, the last one seen; comments made on the map
	// carry it, and "open in the app" goes there.
	ExampleURL   string `json:"exampleUrl,omitempty"`
	ExampleRoute string `json:"exampleRoute,omitempty"`
	// Roles of the people the screen was seen by.
	Roles []string `json:"roles"`
	// Hidden screens stay out of the map unless asked for.
	Hidden bool `json:"hidden"`
	// Planned screens were declared, not seen: no state has a look yet.
	Planned   bool          `json:"planned"`
	Position  *Point        `json:"position,omitempty"`
	States    []ScreenState `json:"states"`
	FirstSeen *time.Time    `json:"firstSeen,omitempty"`
	LastSeen  *time.Time    `json:"lastSeen,omitempty"`
	UpdatedAt time.Time     `json:"updatedAt"`
}

// ScreenState is a state of a screen: the page itself (key ""), a selected tab or an open dialog.
type ScreenState struct {
	Key         string    `json:"key"`
	Kind        StateKind `json:"kind"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	HasShot     bool      `json:"hasShot"`
	HasSnapshot bool      `json:"hasSnapshot"`
	// Hash fingerprints the DOM structure of the captured look: a new capture is taken when it
	// changes.
	Hash       string     `json:"hash,omitempty"`
	Viewport   *Size      `json:"viewport,omitempty"`
	CapturedAt *time.Time `json:"capturedAt,omitempty"`
	LastSeen   *time.Time `json:"lastSeen,omitempty"`
}

// StateRef points at a state of a screen.
type StateRef struct {
	Screen string `json:"screen"`
	State  string `json:"state"`
}

// Via is the element a transition goes through: its accessible name, its kind and a selector that
// finds it in the snapshot of the state it is on.
type Via struct {
	Name     string  `json:"name"`
	Kind     ViaKind `json:"kind"`
	Selector string  `json:"selector"`
}

// Edge is a transition from a state to a state through an element.
type Edge struct {
	From   StateRef   `json:"from"`
	To     StateRef   `json:"to"`
	Via    Via        `json:"via"`
	Source EdgeSource `json:"source"`
	// Count is how many times it was reported (once per page load of a person).
	Count    int       `json:"count"`
	LastSeen time.Time `json:"lastSeen"`
}

// Visit is a person seeing a state of a screen.
type Visit struct {
	Screen string    `json:"screen"`
	State  string    `json:"state"`
	Kind   StateKind `json:"kind"`
	Name   string    `json:"name"`
	Title  string    `json:"title"`
	URL    string    `json:"url"`
	Route  string    `json:"route"`
	Roles  []string  `json:"-"`
	At     time.Time `json:"-"`
}

// Snapshot is the DOM of a state without scripts: HTML (compressed by the API) whose stylesheets
// are stored once as assets and named by their SHA-256, the outline of the page for agents, and
// the viewport it was taken in.
type Snapshot struct {
	Screen   string          `json:"screen"`
	State    string          `json:"state"`
	HTML     []byte          `json:"-"`
	CSS      []string        `json:"css"`
	Outline  json.RawMessage `json:"outline"`
	Viewport Size            `json:"viewport"`
	Hash     string          `json:"hash"`
	At       time.Time       `json:"capturedAt"`
}

// ScreenMap is the whole map of a project.
type ScreenMap struct {
	Screens []Screen `json:"screens"`
	Edges   []Edge   `json:"edges"`
	// Aliases are screen keys merged into others: alias → screen.
	Aliases map[string]string `json:"aliases"`
}

// ScreenPatch changes a screen; nil fields stay. MergeInto moves the states, transitions and
// threads count of the screen into another one and keeps its key as an alias, so visits under the
// old key land there too.
type ScreenPatch struct {
	Key         string  `json:"key"`
	Name        *string `json:"name,omitempty"`
	Section     *string `json:"section,omitempty"`
	Description *string `json:"description,omitempty"`
	Order       *int    `json:"order,omitempty"`
	Hidden      *bool   `json:"hidden,omitempty"`
	Position    *Point  `json:"position,omitempty"`
	MergeInto   *string `json:"mergeInto,omitempty"`
}

// StatePatch changes a state of a screen; nil fields stay.
type StatePatch struct {
	Screen      string  `json:"screen"`
	State       string  `json:"state"`
	Name        *string `json:"name,omitempty"`
	Description *string `json:"description,omitempty"`
}

// ThreadCount is the number of threads with one status on one screen key or route.
type ThreadCount struct {
	Screen string `json:"screen"`
	Route  string `json:"route"`
	Status Status `json:"status"`
	Count  int    `json:"count"`
}

// ErrConflict is returned when a change would break the map: merging a screen into itself or into
// a screen that does not exist, or adding a screen that is already there.
var ErrConflict = errors.New("conflict")

var (
	uuidSegment = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	hexSegment  = regexp.MustCompile(`^[0-9a-fA-F]{12,}$`)
	numSegment  = regexp.MustCompile(`^\d+$`)
	tokenChars  = regexp.MustCompile(`^[A-Za-z0-9_-]{16,}$`)
	hasDigit    = regexp.MustCompile(`\d`)
)

// IDLike reports whether a path segment looks like an id rather than a name: a number, a UUID, a
// long hex string or a long token with digits (ULIDs, hashes). The widget folds such segments
// into {id}; this is the same rule for threads written before the map existed.
func IDLike(seg string) bool {
	return numSegment.MatchString(seg) || uuidSegment.MatchString(seg) || hexSegment.MatchString(seg) ||
		(tokenChars.MatchString(seg) && hasDigit.MatchString(seg))
}

// ScreenKey folds the id-like segments of a route into {id}: /author/0193…/edit → /author/{id}/edit.
func ScreenKey(route string) string {
	parts := strings.Split(route, "/")
	for i, p := range parts {
		if IDLike(p) {
			parts[i] = "{id}"
		}
	}
	return strings.Join(parts, "/")
}
