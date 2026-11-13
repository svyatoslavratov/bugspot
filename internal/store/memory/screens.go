package memory

import (
	"cmp"
	"context"
	"slices"
	"time"

	"github.com/svyatoslavratov/bugspot/internal/domain"
)

// screenMap is the map of one project. Looks (thumbnails, snapshots, stylesheets) stay out of the
// export: the demo keeps its state in localStorage, which is small.
type screenMap struct {
	Screens map[string]*domain.Screen `json:"screens"`
	Edges   []domain.Edge             `json:"edges"`
	Aliases map[string]string         `json:"aliases"`

	shots     map[domain.StateRef]screenshot
	snapshots map[domain.StateRef]domain.Snapshot
	assets    map[string]screenshot
}

func (sm *screenMap) init() {
	if sm.Screens == nil {
		sm.Screens = map[string]*domain.Screen{}
	}
	if sm.Aliases == nil {
		sm.Aliases = map[string]string{}
	}
	if sm.shots == nil {
		sm.shots = map[domain.StateRef]screenshot{}
		sm.snapshots = map[domain.StateRef]domain.Snapshot{}
		sm.assets = map[string]screenshot{}
	}
}

// afterImport drops the marks of looks an export does not carry.
func (sm *screenMap) afterImport() {
	sm.init()
	for _, sc := range sm.Screens {
		for i := range sc.States {
			sc.States[i].HasShot, sc.States[i].HasSnapshot = false, false
		}
	}
}

func (m *Store) screenMap(project string) *screenMap {
	if m.s.Maps == nil {
		m.s.Maps = map[string]*screenMap{}
	}
	sm, ok := m.s.Maps[project]
	if !ok {
		sm = &screenMap{}
		m.s.Maps[project] = sm
	}
	sm.init()
	return sm
}

func (sm *screenMap) resolve(key string) string {
	if to, ok := sm.Aliases[key]; ok {
		return to
	}
	return key
}

func (sm *screenMap) state(ref domain.StateRef) *domain.ScreenState {
	sc, ok := sm.Screens[ref.Screen]
	if !ok {
		return nil
	}
	for i := range sc.States {
		if sc.States[i].Key == ref.State {
			return &sc.States[i]
		}
	}
	return nil
}

// ensure creates the screen and the state when they are not there yet.
func (sm *screenMap) ensure(ref domain.StateRef, at time.Time) *domain.ScreenState {
	sc, ok := sm.Screens[ref.Screen]
	if !ok {
		sc = &domain.Screen{Key: ref.Screen, Roles: []string{}, States: []domain.ScreenState{}, UpdatedAt: at}
		sm.Screens[ref.Screen] = sc
	}
	if st := sm.state(ref); st != nil {
		return st
	}
	sc.States = append(sc.States, domain.ScreenState{Key: ref.State, Kind: domain.StateKindOf(ref.State), Name: domain.StateNameOf(ref.State)})
	slices.SortFunc(sc.States, func(a, b domain.ScreenState) int { return cmp.Compare(a.Key, b.Key) })
	return sm.state(ref)
}

func sameEdge(a, b domain.Edge) bool {
	return a.From == b.From && a.To == b.To && a.Via.Selector == b.Via.Selector
}

func strongerSource(a, b domain.EdgeSource) domain.EdgeSource {
	rank := map[domain.EdgeSource]int{domain.EdgeLink: 0, domain.EdgeObserved: 1, domain.EdgeDeclared: 2}
	if rank[b] > rank[a] {
		return b
	}
	return a
}

func (sm *screenMap) upsertEdge(e domain.Edge) {
	for i := range sm.Edges {
		old := &sm.Edges[i]
		if !sameEdge(*old, e) {
			continue
		}
		old.Count += e.Count
		if e.LastSeen.After(old.LastSeen) {
			old.LastSeen = e.LastSeen
		}
		if e.Via.Name != "" {
			old.Via.Name = e.Via.Name
		}
		old.Via.Kind = e.Via.Kind
		old.Source = strongerSource(old.Source, e.Source)
		return
	}
	sm.Edges = append(sm.Edges, e)
}

func addRoles(sc *domain.Screen, roles []string) {
	for _, r := range roles {
		if r != "" && !slices.Contains(sc.Roles, r) {
			sc.Roles = append(sc.Roles, r)
		}
	}
	slices.Sort(sc.Roles)
}

func copyScreen(sc *domain.Screen) domain.Screen {
	out := *sc
	out.Roles = slices.Clone(sc.Roles)
	out.States = slices.Clone(sc.States)
	if sc.Position != nil {
		p := *sc.Position
		out.Position = &p
	}
	return out
}

// ScreenMap implements store.MapStore.
func (m *Store) ScreenMap(_ context.Context, project string) (domain.ScreenMap, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	sm := m.screenMap(project)
	out := domain.ScreenMap{Screens: []domain.Screen{}, Edges: slices.Clone(sm.Edges), Aliases: map[string]string{}}
	for _, sc := range sm.Screens {
		out.Screens = append(out.Screens, copyScreen(sc))
	}
	slices.SortFunc(out.Screens, func(a, b domain.Screen) int {
		return cmp.Or(cmp.Compare(boolInt(a.Section == ""), boolInt(b.Section == "")), cmp.Compare(a.Section, b.Section),
			cmp.Compare(a.Order, b.Order), cmp.Compare(a.Key, b.Key))
	})
	slices.SortFunc(out.Edges, func(a, b domain.Edge) int {
		return cmp.Or(cmp.Compare(a.From.Screen, b.From.Screen), cmp.Compare(a.From.State, b.From.State),
			cmp.Compare(a.To.Screen, b.To.Screen), cmp.Compare(a.Via.Name, b.Via.Name))
	})
	for k, v := range sm.Aliases {
		out.Aliases[k] = v
	}
	return out, nil
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// RecordVisits implements store.MapStore.
func (m *Store) RecordVisits(_ context.Context, project string, visits []domain.Visit, edges []domain.Edge, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	sm := m.screenMap(project)
	for _, v := range visits {
		seen := v.At
		if seen.IsZero() {
			seen = at
		}
		ref := domain.StateRef{Screen: sm.resolve(v.Screen), State: v.State}
		st := sm.ensure(ref, at)
		sc := sm.Screens[ref.Screen]
		if v.Title != "" {
			sc.Title = v.Title
		}
		if v.URL != "" {
			sc.ExampleURL, sc.ExampleRoute = v.URL, v.Route
		}
		if sc.FirstSeen == nil {
			sc.FirstSeen = &seen
		}
		sc.LastSeen, sc.Planned = &seen, false
		addRoles(sc, v.Roles)
		if v.Kind.Valid() {
			st.Kind = v.Kind
		}
		if st.Name == "" && v.Name != "" {
			st.Name = v.Name
		}
		st.LastSeen = &seen
	}
	for _, e := range edges {
		e.From.Screen, e.To.Screen = sm.resolve(e.From.Screen), sm.resolve(e.To.Screen)
		if e.LastSeen.IsZero() {
			e.LastSeen = at
		}
		sm.ensure(e.From, at)
		sm.ensure(e.To, at)
		sm.upsertEdge(e)
	}
	return nil
}

// AddScreen implements store.MapStore.
func (m *Store) AddScreen(_ context.Context, project string, sc domain.Screen) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	sm := m.screenMap(project)
	if _, ok := sm.Screens[sc.Key]; ok {
		return domain.ErrConflict
	}
	if _, ok := sm.Aliases[sc.Key]; ok {
		return domain.ErrConflict
	}
	sm.Screens[sc.Key] = &domain.Screen{Key: sc.Key, Name: sc.Name, Section: sc.Section, Description: sc.Description,
		Order: sc.Order, Planned: true, Roles: []string{}, States: []domain.ScreenState{}, UpdatedAt: sc.UpdatedAt}
	return nil
}

// PatchScreens implements store.MapStore. Patches are checked first, so a failing one changes
// nothing.
func (m *Store) PatchScreens(_ context.Context, project string, patches []domain.ScreenPatch, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	sm := m.screenMap(project)
	backup := sm.clone()
	for _, p := range patches {
		if err := sm.patch(p, at); err != nil {
			*sm = *backup
			return err
		}
	}
	m.mergeThreads(project, sm)
	return nil
}

func (sm *screenMap) clone() *screenMap {
	c := &screenMap{Screens: map[string]*domain.Screen{}, Edges: slices.Clone(sm.Edges), Aliases: map[string]string{},
		shots: sm.shots, snapshots: sm.snapshots, assets: sm.assets}
	for k, v := range sm.Screens {
		cp := copyScreen(v)
		c.Screens[k] = &cp
	}
	for k, v := range sm.Aliases {
		c.Aliases[k] = v
	}
	return c
}

func (sm *screenMap) patch(p domain.ScreenPatch, at time.Time) error {
	key := sm.resolve(p.Key)
	sc, ok := sm.Screens[key]
	if !ok {
		return domain.ErrNotFound
	}
	if p.Name != nil {
		sc.Name = *p.Name
	}
	if p.Section != nil {
		sc.Section = *p.Section
	}
	if p.Description != nil {
		sc.Description = *p.Description
	}
	if p.Order != nil {
		sc.Order = *p.Order
	}
	if p.Hidden != nil {
		sc.Hidden = *p.Hidden
	}
	if p.Position != nil {
		pos := *p.Position
		sc.Position = &pos
	}
	sc.UpdatedAt = at
	if p.MergeInto != nil {
		return sm.merge(key, sm.resolve(*p.MergeInto), at)
	}
	return nil
}

func (sm *screenMap) merge(from, to string, at time.Time) error {
	if from == to {
		return domain.ErrConflict
	}
	target, ok := sm.Screens[to]
	if !ok {
		return domain.ErrConflict
	}
	source := sm.Screens[from]
	for _, st := range source.States {
		ref := domain.StateRef{Screen: to, State: st.Key}
		if sm.state(ref) != nil {
			continue
		}
		target.States = append(target.States, st)
		old := domain.StateRef{Screen: from, State: st.Key}
		if shot, ok := sm.shots[old]; ok {
			sm.shots[ref] = shot
		}
		if snap, ok := sm.snapshots[old]; ok {
			snap.Screen = to
			sm.snapshots[ref] = snap
		}
	}
	slices.SortFunc(target.States, func(a, b domain.ScreenState) int { return cmp.Compare(a.Key, b.Key) })
	edges := sm.Edges
	sm.Edges = nil
	for _, e := range edges {
		if e.From.Screen == from {
			e.From.Screen = to
		}
		if e.To.Screen == from {
			e.To.Screen = to
		}
		sm.upsertEdge(e)
	}
	for alias, screen := range sm.Aliases {
		if screen == from {
			sm.Aliases[alias] = to
		}
	}
	sm.Aliases[from] = to
	addRoles(target, source.Roles)
	if source.FirstSeen != nil && (target.FirstSeen == nil || source.FirstSeen.Before(*target.FirstSeen)) {
		target.FirstSeen = source.FirstSeen
	}
	if source.LastSeen != nil && (target.LastSeen == nil || source.LastSeen.After(*target.LastSeen)) {
		target.LastSeen = source.LastSeen
	}
	if target.ExampleURL == "" {
		target.ExampleURL, target.ExampleRoute = source.ExampleURL, source.ExampleRoute
	}
	target.Planned = target.Planned && source.Planned
	target.UpdatedAt = at
	delete(sm.Screens, from)
	return nil
}

// mergeThreads moves the threads of merged screens to the screens they were merged into.
func (m *Store) mergeThreads(project string, sm *screenMap) {
	for i := range m.s.Threads {
		t := &m.s.Threads[i]
		if t.Project == project && t.Screen != "" {
			t.Screen = sm.resolve(t.Screen)
		}
	}
}

// PatchStates implements store.MapStore.
func (m *Store) PatchStates(_ context.Context, project string, patches []domain.StatePatch, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	sm := m.screenMap(project)
	for _, p := range patches {
		if sm.state(domain.StateRef{Screen: sm.resolve(p.Screen), State: p.State}) == nil {
			return domain.ErrNotFound
		}
	}
	for _, p := range patches {
		ref := domain.StateRef{Screen: sm.resolve(p.Screen), State: p.State}
		st := sm.state(ref)
		if p.Name != nil {
			st.Name = *p.Name
		}
		if p.Description != nil {
			st.Description = *p.Description
		}
		sm.Screens[ref.Screen].UpdatedAt = at
	}
	return nil
}

// PutShot implements store.MapStore.
func (m *Store) PutShot(_ context.Context, project string, ref domain.StateRef, contentType string, data []byte, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	sm := m.screenMap(project)
	ref.Screen = sm.resolve(ref.Screen)
	sm.ensure(ref, at).HasShot = true
	sm.shots[ref] = screenshot{ContentType: contentType, Data: slices.Clone(data)}
	return nil
}

// Shot implements store.MapStore.
func (m *Store) Shot(_ context.Context, project string, ref domain.StateRef) (string, []byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	sm := m.screenMap(project)
	ref.Screen = sm.resolve(ref.Screen)
	shot, ok := sm.shots[ref]
	if !ok {
		return "", nil, domain.ErrNotFound
	}
	return shot.ContentType, slices.Clone(shot.Data), nil
}

// PutSnapshot implements store.MapStore.
func (m *Store) PutSnapshot(_ context.Context, project string, snap domain.Snapshot) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	sm := m.screenMap(project)
	ref := domain.StateRef{Screen: sm.resolve(snap.Screen), State: snap.State}
	st := sm.ensure(ref, snap.At)
	st.HasSnapshot, st.Hash = true, snap.Hash
	viewport, at := snap.Viewport, snap.At
	st.Viewport, st.CapturedAt = &viewport, &at
	snap.Screen = ref.Screen
	snap.HTML, snap.CSS, snap.Outline = slices.Clone(snap.HTML), slices.Clone(snap.CSS), slices.Clone(snap.Outline)
	sm.snapshots[ref] = snap
	return nil
}

// Snapshot implements store.MapStore.
func (m *Store) Snapshot(_ context.Context, project string, ref domain.StateRef) (domain.Snapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	sm := m.screenMap(project)
	ref.Screen = sm.resolve(ref.Screen)
	snap, ok := sm.snapshots[ref]
	if !ok {
		return domain.Snapshot{Screen: ref.Screen, State: ref.State}, domain.ErrNotFound
	}
	if snap.CSS == nil {
		snap.CSS = []string{}
	}
	return snap, nil
}

// MissingAssets implements store.MapStore.
func (m *Store) MissingAssets(_ context.Context, project string, hashes []string) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	sm := m.screenMap(project)
	missing := []string{}
	for _, h := range hashes {
		if _, ok := sm.assets[h]; !ok && !slices.Contains(missing, h) {
			missing = append(missing, h)
		}
	}
	return missing, nil
}

// PutAsset implements store.MapStore.
func (m *Store) PutAsset(_ context.Context, project, hash, contentType string, data []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	sm := m.screenMap(project)
	if _, ok := sm.assets[hash]; !ok {
		sm.assets[hash] = screenshot{ContentType: contentType, Data: slices.Clone(data)}
	}
	return nil
}

// Asset implements store.MapStore.
func (m *Store) Asset(_ context.Context, project, hash string) (string, []byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	asset, ok := m.screenMap(project).assets[hash]
	if !ok {
		return "", nil, domain.ErrNotFound
	}
	return asset.ContentType, slices.Clone(asset.Data), nil
}

// ThreadCounts implements store.MapStore.
func (m *Store) ThreadCounts(_ context.Context, project string) ([]domain.ThreadCount, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	counts := []domain.ThreadCount{}
	for _, t := range m.s.Threads {
		if t.Project != project || t.DeletedAt != nil {
			continue
		}
		i := slices.IndexFunc(counts, func(c domain.ThreadCount) bool {
			return c.Screen == t.Screen && c.Route == t.Route && c.Status == t.Status
		})
		if i < 0 {
			counts = append(counts, domain.ThreadCount{Screen: t.Screen, Route: t.Route, Status: t.Status})
			i = len(counts) - 1
		}
		counts[i].Count++
	}
	return counts, nil
}

// ImportMap applies a manifest.
func (m *Store) ImportMap(_ context.Context, project string, man domain.Manifest, at time.Time) (domain.ImportResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var res domain.ImportResult
	sm := m.screenMap(project)
	// Screens first: a transition to a screen named later must not create it unplanned.
	for _, ms := range man.Screens {
		key := sm.resolve(ms.Key)
		patch := ms.Patch()
		if _, ok := sm.Screens[key]; !ok {
			sm.Screens[key] = &domain.Screen{Key: key, Planned: true, Roles: []string{}, States: []domain.ScreenState{},
				UpdatedAt: at}
			res.Created++
		} else if patch.Changes() {
			res.Updated++
		}
		patch.Key = key
		if err := sm.patch(patch, at); err != nil {
			return res, err
		}
		for _, st := range ms.States {
			state := sm.ensure(domain.StateRef{Screen: key, State: st.Key}, at)
			if st.Name == nil && st.Description == nil {
				continue
			}
			if st.Name != nil {
				state.Name = *st.Name
			}
			if st.Description != nil {
				state.Description = *st.Description
			}
			res.States++
		}
	}
	for _, ms := range man.Screens {
		for _, e := range ms.Edges(sm.resolve(ms.Key), at) {
			e.To.Screen = sm.resolve(e.To.Screen)
			sm.ensure(e.From, at)
			sm.ensure(e.To, at)
			sm.upsertEdge(e)
			res.Edges++
		}
	}
	return res, nil
}
