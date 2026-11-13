package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/svyatoslavratov/bugspot/internal/domain"
)

type queryer interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// aliases maps merged screen keys to the screens they were merged into.
func aliases(ctx context.Context, q queryer, project string) (map[string]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT alias, screen FROM screen_aliases WHERE project = ?`, project)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := map[string]string{}
	for rows.Next() {
		var alias, screen string
		if err := rows.Scan(&alias, &screen); err != nil {
			return nil, err
		}
		out[alias] = screen
	}
	return out, rows.Err()
}

func resolve(aliases map[string]string, key string) string {
	if to, ok := aliases[key]; ok {
		return to
	}
	return key
}

func optJSON(v any) any {
	if v == nil {
		return nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return string(b)
}

// ScreenMap implements store.MapStore.
func (s *Store) ScreenMap(ctx context.Context, project string) (domain.ScreenMap, error) {
	m := domain.ScreenMap{Screens: []domain.Screen{}, Edges: []domain.Edge{}, Aliases: map[string]string{}}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return m, err
	}
	defer func() { _ = tx.Rollback() }()
	if m.Aliases, err = aliases(ctx, tx, project); err != nil {
		return m, err
	}
	screens, err := scanScreens(ctx, tx, project)
	if err != nil {
		return m, err
	}
	index := map[string]int{}
	for i, sc := range screens {
		index[sc.Key] = i
	}
	rows, err := tx.QueryContext(ctx, `SELECT screen, key, kind, name, description, shot IS NOT NULL,
		snapshot IS NOT NULL, coalesce(hash, ''), viewport, captured_at, last_seen
		FROM screen_states WHERE project = ? ORDER BY screen, key <> '', key`, project)
	if err != nil {
		return m, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var (
			st                       domain.ScreenState
			screen, kind             string
			viewport, captured, seen sql.NullString
		)
		if err := rows.Scan(&screen, &st.Key, &kind, &st.Name, &st.Description, &st.HasShot, &st.HasSnapshot,
			&st.Hash, &viewport, &captured, &seen); err != nil {
			return m, err
		}
		st.Kind, st.CapturedAt, st.LastSeen = domain.StateKind(kind), parseOptTS(captured), parseOptTS(seen)
		if viewport.Valid {
			var size domain.Size
			if json.Unmarshal([]byte(viewport.String), &size) == nil {
				st.Viewport = &size
			}
		}
		if i, ok := index[screen]; ok {
			screens[i].States = append(screens[i].States, st)
		}
	}
	if err := rows.Err(); err != nil {
		return m, err
	}
	m.Screens = screens
	if m.Edges, err = scanEdges(ctx, tx, `project = ?`, project); err != nil {
		return m, err
	}
	return m, nil
}

const screenColumns = `key, name, section, description, title, sort_order, example_url, example_route, roles,
	hidden, planned, position, first_seen, last_seen, updated_at`

func scanScreens(ctx context.Context, q queryer, project string) ([]domain.Screen, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+screenColumns+` FROM screens WHERE project = ?
		ORDER BY section = '', section, sort_order, key`, project)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	screens := []domain.Screen{}
	for rows.Next() {
		sc, err := scanScreen(rows)
		if err != nil {
			return nil, err
		}
		screens = append(screens, sc)
	}
	return screens, rows.Err()
}

func scanScreen(row scanner) (domain.Screen, error) {
	var (
		sc                    domain.Screen
		roles, updated        string
		position, first, last sql.NullString
	)
	err := row.Scan(&sc.Key, &sc.Name, &sc.Section, &sc.Description, &sc.Title, &sc.Order, &sc.ExampleURL,
		&sc.ExampleRoute, &roles, &sc.Hidden, &sc.Planned, &position, &first, &last, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return sc, domain.ErrNotFound
	}
	if err != nil {
		return sc, err
	}
	sc.Roles = []string{}
	_ = json.Unmarshal([]byte(roles), &sc.Roles)
	if position.Valid {
		var p domain.Point
		if json.Unmarshal([]byte(position.String), &p) == nil {
			sc.Position = &p
		}
	}
	sc.FirstSeen, sc.LastSeen, sc.UpdatedAt = parseOptTS(first), parseOptTS(last), parseTS(updated)
	sc.States = []domain.ScreenState{}
	return sc, nil
}

func scanEdges(ctx context.Context, q queryer, cond string, args ...any) ([]domain.Edge, error) {
	rows, err := q.QueryContext(ctx, `SELECT from_screen, from_state, to_screen, to_state, via_selector, via_name,
		via_kind, source, count, last_seen FROM screen_edges WHERE `+cond+` ORDER BY from_screen, from_state, to_screen, via_name`, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	edges := []domain.Edge{}
	for rows.Next() {
		var (
			e                  domain.Edge
			kind, source, seen string
		)
		if err := rows.Scan(&e.From.Screen, &e.From.State, &e.To.Screen, &e.To.State, &e.Via.Selector, &e.Via.Name,
			&kind, &source, &e.Count, &seen); err != nil {
			return nil, err
		}
		e.Via.Kind, e.Source, e.LastSeen = domain.ViaKind(kind), domain.EdgeSource(source), parseTS(seen)
		edges = append(edges, e)
	}
	return edges, rows.Err()
}

// ensureState creates the screen and the state when they are not there yet.
func ensureState(ctx context.Context, q queryer, project string, ref domain.StateRef, at time.Time) error {
	if _, err := q.ExecContext(ctx, `INSERT INTO screens (project, key, updated_at) VALUES (?, ?, ?)
		ON CONFLICT (project, key) DO NOTHING`, project, ref.Screen, ts(at)); err != nil {
		return err
	}
	_, err := q.ExecContext(ctx, `INSERT INTO screen_states (project, screen, key, kind, name) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (project, screen, key) DO NOTHING`,
		project, ref.Screen, ref.State, string(domain.StateKindOf(ref.State)), domain.StateNameOf(ref.State))
	return err
}

func mergeRoles(ctx context.Context, q queryer, project, key string, add []string) error {
	if len(add) == 0 {
		return nil
	}
	var raw string
	if err := q.QueryRowContext(ctx, `SELECT roles FROM screens WHERE project = ? AND key = ?`, project, key).Scan(&raw); err != nil {
		return err
	}
	var roles []string
	_ = json.Unmarshal([]byte(raw), &roles)
	changed := false
	for _, r := range add {
		if r != "" && !slices.Contains(roles, r) {
			roles = append(roles, r)
			changed = true
		}
	}
	if !changed {
		return nil
	}
	slices.Sort(roles)
	_, err := q.ExecContext(ctx, `UPDATE screens SET roles = ? WHERE project = ? AND key = ?`, optJSON(roles), project, key)
	return err
}

// upsertEdge counts an edge; a declared edge stays declared, an observed one beats a link.
func upsertEdge(ctx context.Context, q queryer, project string, e domain.Edge) error {
	_, err := q.ExecContext(ctx, `INSERT INTO screen_edges (project, from_screen, from_state, to_screen, to_state,
		via_selector, via_name, via_kind, source, count, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (project, from_screen, from_state, to_screen, to_state, via_selector) DO UPDATE SET
			count = screen_edges.count + excluded.count,
			last_seen = max(screen_edges.last_seen, excluded.last_seen),
			via_name = CASE WHEN excluded.via_name <> '' THEN excluded.via_name ELSE screen_edges.via_name END,
			via_kind = excluded.via_kind,
			source = CASE
				WHEN screen_edges.source = 'declared' OR excluded.source = 'declared' THEN 'declared'
				WHEN screen_edges.source = 'observed' OR excluded.source = 'observed' THEN 'observed'
				ELSE 'link' END`,
		project, e.From.Screen, e.From.State, e.To.Screen, e.To.State, e.Via.Selector, e.Via.Name, string(e.Via.Kind),
		string(e.Source), e.Count, ts(e.LastSeen))
	return err
}

// RecordVisits implements store.MapStore.
func (s *Store) RecordVisits(ctx context.Context, project string, visits []domain.Visit, edges []domain.Edge, at time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	known, err := aliases(ctx, tx, project)
	if err != nil {
		return err
	}
	for _, v := range visits {
		key := resolve(known, v.Screen)
		seen := v.At
		if seen.IsZero() {
			seen = at
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO screens (project, key, title, example_url, example_route, first_seen,
			last_seen, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (project, key) DO UPDATE SET
				title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE screens.title END,
				example_url = CASE WHEN excluded.example_url <> '' THEN excluded.example_url ELSE screens.example_url END,
				example_route = CASE WHEN excluded.example_route <> '' THEN excluded.example_route ELSE screens.example_route END,
				first_seen = coalesce(screens.first_seen, excluded.first_seen),
				last_seen = excluded.last_seen,
				planned = 0`,
			project, key, v.Title, v.URL, v.Route, ts(seen), ts(seen), ts(at))
		if err != nil {
			return err
		}
		if err := mergeRoles(ctx, tx, project, key, v.Roles); err != nil {
			return err
		}
		kind := v.Kind
		if !kind.Valid() {
			kind = domain.StateKindOf(v.State)
		}
		name := v.Name
		if name == "" {
			name = domain.StateNameOf(v.State)
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO screen_states (project, screen, key, kind, name, last_seen)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT (project, screen, key) DO UPDATE SET last_seen = excluded.last_seen, kind = excluded.kind`,
			project, key, v.State, string(kind), name, ts(seen))
		if err != nil {
			return err
		}
	}
	for _, e := range edges {
		e.From.Screen, e.To.Screen = resolve(known, e.From.Screen), resolve(known, e.To.Screen)
		if e.LastSeen.IsZero() {
			e.LastSeen = at
		}
		for _, ref := range []domain.StateRef{e.From, e.To} {
			if err := ensureState(ctx, tx, project, ref, at); err != nil {
				return err
			}
		}
		if err := upsertEdge(ctx, tx, project, e); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// AddScreen implements store.MapStore.
func (s *Store) AddScreen(ctx context.Context, project string, sc domain.Screen) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	known, err := aliases(ctx, tx, project)
	if err != nil {
		return err
	}
	if _, ok := known[sc.Key]; ok {
		return domain.ErrConflict
	}
	res, err := tx.ExecContext(ctx, `INSERT INTO screens (project, key, name, section, description, sort_order,
		planned, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT (project, key) DO NOTHING`,
		project, sc.Key, sc.Name, sc.Section, sc.Description, sc.Order, ts(sc.UpdatedAt))
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return domain.ErrConflict
	}
	return tx.Commit()
}

func screenExists(ctx context.Context, q queryer, project, key string) (bool, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT count(*) FROM screens WHERE project = ? AND key = ?`, project, key).Scan(&n)
	return n > 0, err
}

// PatchScreens implements store.MapStore.
func (s *Store) PatchScreens(ctx context.Context, project string, patches []domain.ScreenPatch, at time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, p := range patches {
		known, err := aliases(ctx, tx, project)
		if err != nil {
			return err
		}
		key := resolve(known, p.Key)
		ok, err := screenExists(ctx, tx, project, key)
		if err != nil {
			return err
		}
		if !ok {
			return domain.ErrNotFound
		}
		if err := updateScreen(ctx, tx, project, key, p, at); err != nil {
			return err
		}
		if p.MergeInto != nil {
			if err := mergeScreen(ctx, tx, project, key, resolve(known, *p.MergeInto), at); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

// mergeScreen moves the states, transitions and threads of from into to and keeps from as an alias.
// updateScreen sets the fields a patch gives (not the merge).
func updateScreen(ctx context.Context, q queryer, project, key string, p domain.ScreenPatch, at time.Time) error {
	sets, args := []string{"updated_at = ?"}, []any{ts(at)}
	add := func(column string, v any) {
		sets = append(sets, column+" = ?")
		args = append(args, v)
	}
	if p.Name != nil {
		add("name", *p.Name)
	}
	if p.Section != nil {
		add("section", *p.Section)
	}
	if p.Description != nil {
		add("description", *p.Description)
	}
	if p.Order != nil {
		add("sort_order", *p.Order)
	}
	if p.Hidden != nil {
		add("hidden", *p.Hidden)
	}
	if p.Position != nil {
		add("position", optJSON(p.Position))
	}
	args = append(args, project, key)
	// sets are fixed column names with placeholders.
	_, err := q.ExecContext(ctx, `UPDATE screens SET `+strings.Join(sets, ", ")+` WHERE project = ? AND key = ?`, args...)
	return err
}

func mergeScreen(ctx context.Context, tx *sql.Tx, project, from, to string, at time.Time) error {
	if from == to {
		return domain.ErrConflict
	}
	target, err := scanScreen(tx.QueryRowContext(ctx, `SELECT `+screenColumns+` FROM screens WHERE project = ? AND key = ?`, project, to))
	if errors.Is(err, domain.ErrNotFound) {
		return domain.ErrConflict
	}
	if err != nil {
		return err
	}
	source, err := scanScreen(tx.QueryRowContext(ctx, `SELECT `+screenColumns+` FROM screens WHERE project = ? AND key = ?`, project, from))
	if err != nil {
		return err
	}
	// States the target already has keep the target's look.
	if _, err := tx.ExecContext(ctx, `INSERT INTO screen_states (project, screen, key, kind, name, description, shot_type,
		shot, snapshot, snapshot_css, outline, viewport, hash, captured_at, last_seen)
		SELECT project, ?, key, kind, name, description, shot_type, shot, snapshot, snapshot_css, outline, viewport, hash,
			captured_at, last_seen FROM screen_states WHERE project = ? AND screen = ?
		ON CONFLICT (project, screen, key) DO NOTHING`, to, project, from); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM screen_states WHERE project = ? AND screen = ?`, project, from); err != nil {
		return err
	}
	edges, err := scanEdges(ctx, tx, `project = ? AND (from_screen = ? OR to_screen = ?)`, project, from, from)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM screen_edges WHERE project = ? AND (from_screen = ? OR to_screen = ?)`,
		project, from, from); err != nil {
		return err
	}
	for _, e := range edges {
		if e.From.Screen == from {
			e.From.Screen = to
		}
		if e.To.Screen == from {
			e.To.Screen = to
		}
		if err := upsertEdge(ctx, tx, project, e); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE threads SET screen = ? WHERE project = ? AND screen = ?`, to, project, from); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE screen_aliases SET screen = ? WHERE project = ? AND screen = ?`, to, project, from); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO screen_aliases (project, alias, screen) VALUES (?, ?, ?)
		ON CONFLICT (project, alias) DO UPDATE SET screen = excluded.screen`, project, from, to); err != nil {
		return err
	}
	if err := mergeRoles(ctx, tx, project, to, source.Roles); err != nil {
		return err
	}
	first, last := target.FirstSeen, target.LastSeen
	if source.FirstSeen != nil && (first == nil || source.FirstSeen.Before(*first)) {
		first = source.FirstSeen
	}
	if source.LastSeen != nil && (last == nil || source.LastSeen.After(*last)) {
		last = source.LastSeen
	}
	exampleURL, exampleRoute := target.ExampleURL, target.ExampleRoute
	if exampleURL == "" {
		exampleURL, exampleRoute = source.ExampleURL, source.ExampleRoute
	}
	if _, err := tx.ExecContext(ctx, `UPDATE screens SET first_seen = ?, last_seen = ?, example_url = ?, example_route = ?,
		planned = planned AND ?, updated_at = ? WHERE project = ? AND key = ?`,
		optTS(first), optTS(last), exampleURL, exampleRoute, source.Planned, ts(at), project, to); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `DELETE FROM screens WHERE project = ? AND key = ?`, project, from)
	return err
}

// PatchStates implements store.MapStore.
func (s *Store) PatchStates(ctx context.Context, project string, patches []domain.StatePatch, at time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	known, err := aliases(ctx, tx, project)
	if err != nil {
		return err
	}
	for _, p := range patches {
		screen := resolve(known, p.Screen)
		res, err := tx.ExecContext(ctx, `UPDATE screen_states SET name = coalesce(?, name), description = coalesce(?, description)
			WHERE project = ? AND screen = ? AND key = ?`, p.Name, p.Description, project, screen, p.State)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return domain.ErrNotFound
		}
		if _, err := tx.ExecContext(ctx, `UPDATE screens SET updated_at = ? WHERE project = ? AND key = ?`, ts(at), project, screen); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// PutShot implements store.MapStore.
func (s *Store) PutShot(ctx context.Context, project string, ref domain.StateRef, contentType string, data []byte, at time.Time) error {
	return s.capture(ctx, project, &ref, at, `UPDATE screen_states SET shot_type = ?, shot = ?
		WHERE project = ? AND screen = ? AND key = ?`, contentType, data)
}

// PutSnapshot implements store.MapStore.
func (s *Store) PutSnapshot(ctx context.Context, project string, snap domain.Snapshot) error {
	ref := domain.StateRef{Screen: snap.Screen, State: snap.State}
	outline := string(snap.Outline)
	if outline == "" {
		outline = "{}"
	}
	return s.capture(ctx, project, &ref, snap.At, `UPDATE screen_states SET snapshot = ?, snapshot_css = ?, outline = ?,
		viewport = ?, hash = ?, captured_at = ? WHERE project = ? AND screen = ? AND key = ?`,
		snap.HTML, optJSON(snap.CSS), outline, optJSON(snap.Viewport), snap.Hash, ts(snap.At))
}

// capture writes a look of a state, creating the screen and the state first; set ends with the
// project, screen and state placeholders.
func (s *Store) capture(ctx context.Context, project string, ref *domain.StateRef, at time.Time, set string, args ...any) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	known, err := aliases(ctx, tx, project)
	if err != nil {
		return err
	}
	ref.Screen = resolve(known, ref.Screen)
	if err := ensureState(ctx, tx, project, *ref, at); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, set, append(args, project, ref.Screen, ref.State)...); err != nil {
		return err
	}
	return tx.Commit()
}

// Shot implements store.MapStore.
func (s *Store) Shot(ctx context.Context, project string, ref domain.StateRef) (string, []byte, error) {
	known, err := aliases(ctx, s.db, project)
	if err != nil {
		return "", nil, err
	}
	var (
		contentType string
		data        []byte
	)
	err = s.db.QueryRowContext(ctx, `SELECT shot_type, shot FROM screen_states
		WHERE project = ? AND screen = ? AND key = ? AND shot IS NOT NULL`,
		project, resolve(known, ref.Screen), ref.State).Scan(&contentType, &data)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil, domain.ErrNotFound
	}
	return contentType, data, err
}

// Snapshot implements store.MapStore.
func (s *Store) Snapshot(ctx context.Context, project string, ref domain.StateRef) (domain.Snapshot, error) {
	known, err := aliases(ctx, s.db, project)
	if err != nil {
		return domain.Snapshot{}, err
	}
	snap := domain.Snapshot{Screen: resolve(known, ref.Screen), State: ref.State}
	var css, outline, viewport, captured sql.NullString
	err = s.db.QueryRowContext(ctx, `SELECT snapshot, snapshot_css, outline, viewport, coalesce(hash, ''), captured_at
		FROM screen_states WHERE project = ? AND screen = ? AND key = ? AND snapshot IS NOT NULL`,
		project, snap.Screen, snap.State).Scan(&snap.HTML, &css, &outline, &viewport, &snap.Hash, &captured)
	if errors.Is(err, sql.ErrNoRows) {
		return snap, domain.ErrNotFound
	}
	if err != nil {
		return snap, err
	}
	snap.CSS = []string{}
	if css.Valid {
		_ = json.Unmarshal([]byte(css.String), &snap.CSS)
	}
	snap.Outline = json.RawMessage(outline.String)
	if !outline.Valid || outline.String == "" {
		snap.Outline = json.RawMessage("{}")
	}
	if viewport.Valid {
		_ = json.Unmarshal([]byte(viewport.String), &snap.Viewport)
	}
	if captured.Valid {
		snap.At = parseTS(captured.String)
	}
	return snap, nil
}

// MissingAssets implements store.MapStore.
func (s *Store) MissingAssets(ctx context.Context, project string, hashes []string) ([]string, error) {
	missing := []string{}
	for _, h := range hashes {
		var n int
		if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM screen_assets WHERE project = ? AND hash = ?`,
			project, h).Scan(&n); err != nil {
			return nil, err
		}
		if n == 0 && !slices.Contains(missing, h) {
			missing = append(missing, h)
		}
	}
	return missing, nil
}

// PutAsset implements store.MapStore.
func (s *Store) PutAsset(ctx context.Context, project, hash, contentType string, data []byte) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO screen_assets (project, hash, content_type, data, created_at)
		VALUES (?, ?, ?, ?, ?) ON CONFLICT (project, hash) DO NOTHING`, project, hash, contentType, data, ts(time.Now()))
	return err
}

// Asset implements store.MapStore.
func (s *Store) Asset(ctx context.Context, project, hash string) (string, []byte, error) {
	var (
		contentType string
		data        []byte
	)
	err := s.db.QueryRowContext(ctx, `SELECT content_type, data FROM screen_assets WHERE project = ? AND hash = ?`,
		project, hash).Scan(&contentType, &data)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil, domain.ErrNotFound
	}
	return contentType, data, err
}

// ThreadCounts implements store.MapStore.
func (s *Store) ThreadCounts(ctx context.Context, project string) ([]domain.ThreadCount, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT screen, route, status, count(*) FROM threads
		WHERE project = ? AND deleted_at IS NULL GROUP BY screen, route, status`, project)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	counts := []domain.ThreadCount{}
	for rows.Next() {
		var (
			c      domain.ThreadCount
			status string
		)
		if err := rows.Scan(&c.Screen, &c.Route, &status, &c.Count); err != nil {
			return nil, err
		}
		c.Status = domain.Status(status)
		counts = append(counts, c)
	}
	return counts, rows.Err()
}

// ImportMap applies a manifest in one transaction.
func (s *Store) ImportMap(ctx context.Context, project string, m domain.Manifest, at time.Time) (domain.ImportResult, error) {
	var res domain.ImportResult
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return res, err
	}
	defer func() { _ = tx.Rollback() }()
	known, err := aliases(ctx, tx, project)
	if err != nil {
		return res, err
	}
	// Screens first: a transition to a screen named later in the file must not create it unplanned.
	for _, ms := range m.Screens {
		key := resolve(known, ms.Key)
		exists, err := screenExists(ctx, tx, project, key)
		if err != nil {
			return res, err
		}
		patch := ms.Patch()
		if !exists {
			if _, err := tx.ExecContext(ctx, `INSERT INTO screens (project, key, planned, updated_at) VALUES (?, ?, 1, ?)`,
				project, key, ts(at)); err != nil {
				return res, err
			}
			res.Created++
		} else if patch.Changes() {
			res.Updated++
		}
		if patch.Changes() {
			if err := updateScreen(ctx, tx, project, key, patch, at); err != nil {
				return res, err
			}
		}
		for _, st := range ms.States {
			ref := domain.StateRef{Screen: key, State: st.Key}
			if err := ensureState(ctx, tx, project, ref, at); err != nil {
				return res, err
			}
			if st.Name == nil && st.Description == nil {
				continue
			}
			if _, err := tx.ExecContext(ctx, `UPDATE screen_states SET name = coalesce(?, name),
				description = coalesce(?, description) WHERE project = ? AND screen = ? AND key = ?`,
				st.Name, st.Description, project, key, st.Key); err != nil {
				return res, err
			}
			res.States++
		}
	}
	for _, ms := range m.Screens {
		for _, e := range ms.Edges(resolve(known, ms.Key), at) {
			e.To.Screen = resolve(known, e.To.Screen)
			for _, ref := range []domain.StateRef{e.From, e.To} {
				if err := ensureState(ctx, tx, project, ref, at); err != nil {
					return res, err
				}
			}
			if err := upsertEdge(ctx, tx, project, e); err != nil {
				return res, err
			}
			res.Edges++
		}
	}
	return res, tx.Commit()
}
