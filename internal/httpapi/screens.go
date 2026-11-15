package httpapi

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/svyatoslavratov/bugspot/internal/domain"
)

// The screen map API: the widget reports visits, transitions and the look of states (people who
// build the map); the map page and agents read it and name, group and describe screens (people and
// agents who may open the map).

// Limits of the map API.
const (
	maxSnapshot    = 8 << 20
	maxAsset       = 2 << 20
	maxOutline     = 64 << 10
	maxVisitBatch  = 100
	maxPatchBatch  = 200
	maxAssetHashes = 200
	maxScreenName  = 120
	maxScreenText  = 4000
	maxStateKey    = 300
	maxViaName     = 200
	maxViaSelector = 2048
)

var assetHash = regexp.MustCompile(`^[0-9a-f]{64}$`)

func (s *Server) mapMask() string {
	if s.o.MapMask == "" {
		return "inputs"
	}
	return s.o.MapMask
}

func screenParam(field, v string) (string, error) {
	v, err := checkText(field, v, maxScreenKey, true)
	if err != nil {
		return "", err
	}
	return v, nil
}

func stateParam(field, v string) (string, error) {
	return checkText(field, v, maxStateKey, false)
}

func (s *Server) stateRef(r *http.Request) (domain.StateRef, error) {
	q := r.URL.Query()
	screen, err := screenParam("screen", q.Get("screen"))
	if err != nil {
		return domain.StateRef{}, err
	}
	state, err := stateParam("state", q.Get("state"))
	return domain.StateRef{Screen: screen, State: state}, err
}

func checkRef(field string, ref *domain.StateRef) error {
	var err error
	if ref.Screen, err = screenParam(field+".screen", ref.Screen); err != nil {
		return err
	}
	ref.State, err = stateParam(field+".state", ref.State)
	return err
}

// activeCounts are the threads that still need work on each screen: those with a screen count
// there, older ones by their route with ids folded; aliases land on their screens.
func activeCounts(counts []domain.ThreadCount, aliases map[string]string) map[string]map[domain.Status]int {
	out := map[string]map[domain.Status]int{}
	for _, c := range counts {
		if c.Status.Closed() {
			continue
		}
		key := c.Screen
		if key == "" {
			key = domain.ScreenKey(c.Route)
		}
		if to, ok := aliases[key]; ok {
			key = to
		}
		if out[key] == nil {
			out[key] = map[domain.Status]int{}
		}
		out[key][c.Status] += c.Count
	}
	return out
}

func (s *Server) getMap(w http.ResponseWriter, r *http.Request, c caller) error {
	if !c.perms.Map {
		return errForbidden
	}
	m, err := s.o.Store.ScreenMap(r.Context(), s.o.Project)
	if err != nil {
		return err
	}
	counts, err := s.o.Store.ThreadCounts(r.Context(), s.o.Project)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"screens": m.Screens, "edges": m.Edges, "aliases": m.Aliases, "threads": activeCounts(counts, m.Aliases),
	})
	return nil
}

// captureInfo is what the widget needs to decide whether a state needs a new look.
type captureInfo struct {
	Screen     string `json:"screen"`
	State      string `json:"state"`
	Hash       string `json:"hash,omitempty"`
	HasShot    bool   `json:"hasShot"`
	CapturedAt string `json:"capturedAt,omitempty"`
}

func (s *Server) captures(w http.ResponseWriter, r *http.Request, c caller) error {
	if !c.perms.Collect {
		return errForbidden
	}
	m, err := s.o.Store.ScreenMap(r.Context(), s.o.Project)
	if err != nil {
		return err
	}
	states := []captureInfo{}
	for _, sc := range m.Screens {
		for _, st := range sc.States {
			info := captureInfo{Screen: sc.Key, State: st.Key, Hash: st.Hash, HasShot: st.HasShot}
			if st.CapturedAt != nil {
				info.CapturedAt = st.CapturedAt.UTC().Format("2006-01-02T15:04:05Z")
			}
			states = append(states, info)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"states": states, "aliases": m.Aliases})
	return nil
}

type visitInput struct {
	Screen string           `json:"screen"`
	State  string           `json:"state"`
	Kind   domain.StateKind `json:"kind"`
	Name   string           `json:"name"`
	Title  string           `json:"title"`
	URL    string           `json:"url"`
	Route  string           `json:"route"`
}

type edgeInput struct {
	From   domain.StateRef   `json:"from"`
	To     domain.StateRef   `json:"to"`
	Via    domain.Via        `json:"via"`
	Source domain.EdgeSource `json:"source"`
}

func (e *edgeInput) check(sources ...domain.EdgeSource) error {
	if err := checkRef("from", &e.From); err != nil {
		return err
	}
	if err := checkRef("to", &e.To); err != nil {
		return err
	}
	var err error
	if e.Via.Name, err = checkText("via.name", e.Via.Name, maxViaName, false); err != nil {
		return err
	}
	if e.Via.Selector, err = checkText("via.selector", e.Via.Selector, maxViaSelector, false); err != nil {
		return err
	}
	if e.Via.Kind == "" {
		e.Via.Kind = domain.ViaButton
	}
	if !e.Via.Kind.Valid() {
		return badRequest("unknown via.kind %q", e.Via.Kind)
	}
	if !e.Source.Valid() || !containsSource(sources, e.Source) {
		return badRequest("source %q is not allowed here", e.Source)
	}
	return nil
}

func containsSource(list []domain.EdgeSource, s domain.EdgeSource) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func (v *visitInput) check() error {
	var err error
	if v.Screen, err = screenParam("screen", v.Screen); err != nil {
		return err
	}
	if v.State, err = stateParam("state", v.State); err != nil {
		return err
	}
	if v.Kind == "" {
		v.Kind = domain.StateKindOf(v.State)
	}
	if !v.Kind.Valid() {
		return badRequest("unknown kind %q", v.Kind)
	}
	if v.Name, err = checkText("name", v.Name, maxStateKey, false); err != nil {
		return err
	}
	if v.Title, err = checkText("title", v.Title, 300, false); err != nil {
		return err
	}
	if v.Route, err = checkText("route", v.Route, maxRoute, false); err != nil {
		return err
	}
	if v.URL, err = checkText("url", v.URL, maxRoute, false); err != nil {
		return err
	}
	if v.URL != "" && !strings.HasPrefix(v.URL, "https://") && !strings.HasPrefix(v.URL, "http://") {
		return badRequest("url must be an http(s) address")
	}
	return nil
}

// visits saves what the widget saw: states of screens and transitions (observed after a click,
// read from links, or declared by the page with data-bugspot-to).
func (s *Server) visits(w http.ResponseWriter, r *http.Request, c caller) error {
	if !c.perms.Collect {
		return errForbidden
	}
	var in struct {
		Visits []visitInput `json:"visits"`
		Edges  []edgeInput  `json:"edges"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if len(in.Visits) > maxVisitBatch || len(in.Edges) > maxVisitBatch {
		return badRequest("at most %d visits and %d edges at once", maxVisitBatch, maxVisitBatch)
	}
	now := s.o.Now().UTC()
	visits := make([]domain.Visit, 0, len(in.Visits))
	for i := range in.Visits {
		v := &in.Visits[i]
		if err := v.check(); err != nil {
			return err
		}
		visits = append(visits, domain.Visit{Screen: v.Screen, State: v.State, Kind: v.Kind, Name: v.Name, Title: v.Title,
			URL: v.URL, Route: v.Route, Roles: c.id.Roles, At: now})
	}
	edges := make([]domain.Edge, 0, len(in.Edges))
	for i := range in.Edges {
		e := &in.Edges[i]
		if err := e.check(domain.EdgeObserved, domain.EdgeLink, domain.EdgeDeclared); err != nil {
			return err
		}
		count := 0
		if e.Source == domain.EdgeObserved {
			count = 1
		}
		edges = append(edges, domain.Edge{From: e.From, To: e.To, Via: e.Via, Source: e.Source, Count: count, LastSeen: now})
	}
	if err := s.o.Store.RecordVisits(r.Context(), s.o.Project, visits, edges, now); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) missingAssets(w http.ResponseWriter, r *http.Request, c caller) error {
	if !c.perms.Collect {
		return errForbidden
	}
	var in struct {
		Hashes []string `json:"hashes"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if len(in.Hashes) > maxAssetHashes {
		return badRequest("at most %d hashes at once", maxAssetHashes)
	}
	for _, h := range in.Hashes {
		if !assetHash.MatchString(h) {
			return badRequest("%q is not a SHA-256 in hex", h)
		}
	}
	missing, err := s.o.Store.MissingAssets(r.Context(), s.o.Project, in.Hashes)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"missing": missing})
	return nil
}

func readBody(w http.ResponseWriter, r *http.Request, limit int64) ([]byte, error) {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return nil, errTooLarge
	}
	return data, err
}

func compress(data []byte) ([]byte, error) {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write(data); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func decompress(data []byte) ([]byte, error) {
	zr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	defer func() { _ = zr.Close() }()
	return io.ReadAll(io.LimitReader(zr, 4*maxSnapshot))
}

// putAsset stores a stylesheet of snapshots under its SHA-256, which must match.
func (s *Server) putAsset(w http.ResponseWriter, r *http.Request, c caller) error {
	if !c.perms.Collect {
		return errForbidden
	}
	hash := r.PathValue("hash")
	if !assetHash.MatchString(hash) {
		return badRequest("the asset name must be its SHA-256 in hex")
	}
	data, err := readBody(w, r, maxAsset)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != hash {
		return badRequest("the asset does not match its hash")
	}
	if !utf8.Valid(data) {
		return badRequest("the asset must be UTF-8 CSS")
	}
	packed, err := compress(data)
	if err != nil {
		return err
	}
	if err := s.o.Store.PutAsset(r.Context(), s.o.Project, hash, "text/css", packed); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) putShot(w http.ResponseWriter, r *http.Request, c caller) error {
	if !c.perms.Collect {
		return errForbidden
	}
	ref, err := s.stateRef(r)
	if err != nil {
		return err
	}
	data, err := readBody(w, r, s.o.ScreenshotMaxBytes)
	if err != nil {
		return err
	}
	contentType := imageType(data)
	if contentType == "" {
		return badRequest("the thumbnail must be a PNG, JPEG or WebP image")
	}
	if err := s.o.Store.PutShot(r.Context(), s.o.Project, ref, contentType, data, s.o.Now().UTC()); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) getShot(w http.ResponseWriter, r *http.Request, c caller) error {
	if !c.perms.Map {
		return errForbidden
	}
	ref, err := s.stateRef(r)
	if err != nil {
		return err
	}
	contentType, data, err := s.o.Store.Shot(r.Context(), s.o.Project, ref)
	if err != nil {
		return err
	}
	h := w.Header()
	h.Set("Content-Type", contentType)
	h.Set("Content-Length", strconv.Itoa(len(data)))
	h.Set("Content-Disposition", "inline")
	h.Set("Cache-Control", "private, max-age=60")
	_, _ = w.Write(data) //nolint:gosec // a sniffed PNG/JPEG/WebP served with its own type and nosniff, not HTML
	return nil
}

type snapshotInput struct {
	HTML     string          `json:"html"`
	CSS      []string        `json:"css"`
	Outline  json.RawMessage `json:"outline"`
	Viewport domain.Size     `json:"viewport"`
	Hash     string          `json:"hash"`
}

// putSnapshot stores the DOM of a state; its stylesheets must be uploaded first.
func (s *Server) putSnapshot(w http.ResponseWriter, r *http.Request, c caller) error {
	if !c.perms.Collect {
		return errForbidden
	}
	ref, err := s.stateRef(r)
	if err != nil {
		return err
	}
	data, err := readBody(w, r, maxSnapshot)
	if err != nil {
		return err
	}
	var in snapshotInput
	if err := json.Unmarshal(data, &in); err != nil {
		return badRequest("invalid JSON: %v", err)
	}
	if in.HTML == "" || !utf8.ValidString(in.HTML) {
		return badRequest("html is required and must be UTF-8")
	}
	if len(in.CSS) > maxAssetHashes {
		return badRequest("at most %d stylesheets", maxAssetHashes)
	}
	for _, h := range in.CSS {
		if !assetHash.MatchString(h) {
			return badRequest("css: %q is not a SHA-256 in hex", h)
		}
	}
	if in.Outline, err = checkObject("outline", in.Outline, maxOutline); err != nil {
		return err
	}
	if in.Viewport.W <= 0 || in.Viewport.H <= 0 || in.Viewport.W > 10000 || in.Viewport.H > 10000 {
		return badRequest("viewport must be the window size")
	}
	if in.Hash, err = checkText("hash", in.Hash, 128, false); err != nil {
		return err
	}
	missing, err := s.o.Store.MissingAssets(r.Context(), s.o.Project, in.CSS)
	if err != nil {
		return err
	}
	if len(missing) > 0 {
		return badRequest("upload the stylesheets first: %s", strings.Join(missing, ", "))
	}
	html, err := compress([]byte(in.HTML))
	if err != nil {
		return err
	}
	snap := domain.Snapshot{Screen: ref.Screen, State: ref.State, HTML: html, CSS: in.CSS, Outline: in.Outline,
		Viewport: in.Viewport, Hash: in.Hash, At: s.o.Now().UTC()}
	if err := s.o.Store.PutSnapshot(r.Context(), s.o.Project, snap); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// getSnapshot returns the DOM of a state with its stylesheets: the map page renders it in a
// sandboxed frame without scripts.
func (s *Server) getSnapshot(w http.ResponseWriter, r *http.Request, c caller) error {
	if !c.perms.Map {
		return errForbidden
	}
	ref, err := s.stateRef(r)
	if err != nil {
		return err
	}
	snap, err := s.o.Store.Snapshot(r.Context(), s.o.Project, ref)
	if err != nil {
		return err
	}
	// Agents read what is on the page from the outline; the HTML is for the map page.
	if r.URL.Query().Get("fields") == "outline" {
		writeJSON(w, http.StatusOK, map[string]any{"screen": snap.Screen, "state": snap.State, "outline": snap.Outline,
			"viewport": snap.Viewport, "capturedAt": snap.At})
		return nil
	}
	html, err := decompress(snap.HTML)
	if err != nil {
		return err
	}
	css := map[string]string{}
	for _, h := range snap.CSS {
		_, packed, err := s.o.Store.Asset(r.Context(), s.o.Project, h)
		if errors.Is(err, domain.ErrNotFound) {
			continue
		}
		if err != nil {
			return err
		}
		text, err := decompress(packed)
		if err != nil {
			return err
		}
		css[h] = string(text)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"screen": snap.Screen, "state": snap.State, "html": string(html), "css": css, "outline": snap.Outline,
		"viewport": snap.Viewport, "hash": snap.Hash, "capturedAt": snap.At,
	})
	return nil
}

type screenInput struct {
	Key         string `json:"key"`
	Name        string `json:"name"`
	Section     string `json:"section"`
	Description string `json:"description"`
	Order       int    `json:"order"`
}

// addScreen declares a screen that is not in the app yet (or nobody reached): a planned screen.
func (s *Server) addScreen(w http.ResponseWriter, r *http.Request, c caller) error {
	if !c.perms.Map {
		return errForbidden
	}
	var in screenInput
	if err := decode(r, &in); err != nil {
		return err
	}
	var err error
	if in.Key, err = screenParam("key", in.Key); err != nil {
		return err
	}
	if err := checkScreenTexts(&in.Name, &in.Section, &in.Description); err != nil {
		return err
	}
	sc := domain.Screen{Key: in.Key, Name: in.Name, Section: in.Section, Description: in.Description, Order: in.Order,
		Planned: true, UpdatedAt: s.o.Now().UTC()}
	if err := s.o.Store.AddScreen(r.Context(), s.o.Project, sc); err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, sc)
	return nil
}

func checkScreenTexts(name, section, description *string) error {
	var err error
	if name != nil {
		if *name, err = checkText("name", *name, maxScreenName, false); err != nil {
			return err
		}
	}
	if section != nil {
		if *section, err = checkText("section", *section, maxScreenName, false); err != nil {
			return err
		}
	}
	if description != nil {
		if *description, err = checkText("description", *description, maxScreenText, false); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) patchScreens(w http.ResponseWriter, r *http.Request, c caller) error {
	if !c.perms.Map {
		return errForbidden
	}
	var in []domain.ScreenPatch
	if err := decode(r, &in); err != nil {
		return err
	}
	if len(in) == 0 || len(in) > maxPatchBatch {
		return badRequest("send from 1 to %d screens", maxPatchBatch)
	}
	for i := range in {
		p := &in[i]
		var err error
		if p.Key, err = screenParam("key", p.Key); err != nil {
			return err
		}
		if err := checkScreenTexts(p.Name, p.Section, p.Description); err != nil {
			return err
		}
		if p.MergeInto != nil {
			if *p.MergeInto, err = screenParam("mergeInto", *p.MergeInto); err != nil {
				return err
			}
		}
	}
	if err := s.o.Store.PatchScreens(r.Context(), s.o.Project, in, s.o.Now().UTC()); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) patchStates(w http.ResponseWriter, r *http.Request, c caller) error {
	if !c.perms.Map {
		return errForbidden
	}
	var in []domain.StatePatch
	if err := decode(r, &in); err != nil {
		return err
	}
	if len(in) == 0 || len(in) > maxPatchBatch {
		return badRequest("send from 1 to %d states", maxPatchBatch)
	}
	for i := range in {
		p := &in[i]
		var err error
		if p.Screen, err = screenParam("screen", p.Screen); err != nil {
			return err
		}
		if p.State, err = stateParam("state", p.State); err != nil {
			return err
		}
		if err := checkScreenTexts(p.Name, nil, p.Description); err != nil {
			return err
		}
	}
	if err := s.o.Store.PatchStates(r.Context(), s.o.Project, in, s.o.Now().UTC()); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// addEdge declares a transition the widget cannot see by itself, e.g. one that only follows a
// successful save.
func (s *Server) addEdge(w http.ResponseWriter, r *http.Request, c caller) error {
	if !c.perms.Map {
		return errForbidden
	}
	var in edgeInput
	if err := decode(r, &in); err != nil {
		return err
	}
	in.Source = domain.EdgeDeclared
	if err := in.check(domain.EdgeDeclared); err != nil {
		return err
	}
	if in.Via.Selector == "" {
		in.Via.Selector = "declared:" + in.Via.Name
	}
	now := s.o.Now().UTC()
	e := domain.Edge{From: in.From, To: in.To, Via: in.Via, Source: domain.EdgeDeclared, LastSeen: now}
	if err := s.o.Store.RecordVisits(r.Context(), s.o.Project, nil, []domain.Edge{e}, now); err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, e)
	return nil
}

// Limits of a manifest.
const (
	maxManifestBody   = 4 << 20
	maxManifestScreen = 2000
	maxManifestItems  = 200
)

// exportMap writes the part of the map people and agents wrote as a manifest: every screen with
// its name, section, description, order and hidden flag, the states that have a description, and
// the declared transitions.
func (s *Server) exportMap(w http.ResponseWriter, r *http.Request, c caller) error {
	if !c.perms.Map {
		return errForbidden
	}
	m, err := s.o.Store.ScreenMap(r.Context(), s.o.Project)
	if err != nil {
		return err
	}
	text := func(v string) *string {
		if v == "" {
			return nil
		}
		return &v
	}
	out := domain.Manifest{Version: 1, Screens: make([]domain.ManifestScreen, 0, len(m.Screens))}
	index := map[string]int{}
	for _, sc := range m.Screens {
		ms := domain.ManifestScreen{Key: sc.Key, Name: text(sc.Name), Section: text(sc.Section), Description: text(sc.Description)}
		if sc.Order != 0 {
			ms.Order = &sc.Order
		}
		if sc.Hidden {
			ms.Hidden = &sc.Hidden
		}
		for _, st := range sc.States {
			if st.Description != "" {
				ms.States = append(ms.States, domain.ManifestState{Key: st.Key, Description: text(st.Description)})
			}
		}
		index[sc.Key] = len(out.Screens)
		out.Screens = append(out.Screens, ms)
	}
	for _, e := range m.Edges {
		i, ok := index[e.From.Screen]
		if e.Source != domain.EdgeDeclared || !ok {
			continue
		}
		edge := domain.ManifestEdge{Screen: e.To.Screen, State: e.To.State, From: e.From.State, Via: e.Via.Name}
		if e.Via.Kind != domain.ViaButton {
			edge.Kind = e.Via.Kind
		}
		out.Screens[i].To = append(out.Screens[i].To, edge)
	}
	w.Header().Set("Content-Disposition", `attachment; filename="bugspot-map.json"`)
	writeJSON(w, http.StatusOK, out)
	return nil
}

// importMap applies a manifest: a file kept next to the app, written by people, agents or a
// script that reads the app's router.
func (s *Server) importMap(w http.ResponseWriter, r *http.Request, c caller) error {
	if !c.perms.Map {
		return errForbidden
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxManifestBody)
	var m domain.Manifest
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&m); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return errTooLarge
		}
		return badRequest("invalid manifest: %v", err)
	}
	if m.Version > 1 {
		return badRequest("manifest version %d is newer than this service reads (1)", m.Version)
	}
	if err := checkManifest(&m); err != nil {
		return err
	}
	res, err := s.o.Store.ImportMap(r.Context(), s.o.Project, m, s.o.Now().UTC())
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, res)
	return nil
}

// checkManifest validates a manifest and folds its keys the way the widget does.
func checkManifest(m *domain.Manifest) error {
	if len(m.Screens) > maxManifestScreen {
		return badRequest("at most %d screens in a manifest", maxManifestScreen)
	}
	for i := range m.Screens {
		ms := &m.Screens[i]
		field := fmt.Sprintf("screens[%d]", i)
		key, err := screenParam(field+".key", ms.Key)
		if err != nil {
			return err
		}
		ms.Key = domain.PatternKey(key)
		if err := checkScreenTexts(ms.Name, ms.Section, ms.Description); err != nil {
			return err
		}
		if len(ms.States) > maxManifestItems || len(ms.To) > maxManifestItems {
			return badRequest("%s: at most %d states and %d transitions", field, maxManifestItems, maxManifestItems)
		}
		for j := range ms.States {
			st := &ms.States[j]
			if st.Key, err = stateParam(fmt.Sprintf("%s.states[%d].key", field, j), st.Key); err != nil {
				return err
			}
			if err := checkScreenTexts(st.Name, nil, st.Description); err != nil {
				return err
			}
		}
		for j := range ms.To {
			e := &ms.To[j]
			to := fmt.Sprintf("%s.to[%d]", field, j)
			target, err := screenParam(to+".screen", e.Screen)
			if err != nil {
				return err
			}
			e.Screen = domain.PatternKey(target)
			if e.State, err = stateParam(to+".state", e.State); err != nil {
				return err
			}
			if e.From, err = stateParam(to+".from", e.From); err != nil {
				return err
			}
			if e.Via, err = checkText(to+".via", e.Via, maxViaName, false); err != nil {
				return err
			}
			if e.Kind != "" && !e.Kind.Valid() {
				return badRequest("%s.kind: unknown kind %q", to, e.Kind)
			}
		}
	}
	return nil
}
