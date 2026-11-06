// Package sqlite stores everything in one SQLite file: threads, replies, screenshots (as blobs)
// and hashed credentials. It uses the pure Go driver, so the binary needs no cgo.
package sqlite

import (
	"context"
	"database/sql"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"strings"
	"time"

	_ "modernc.org/sqlite" // database/sql driver "sqlite"

	"github.com/svyatoslavratov/bugspot/internal/domain"
	"github.com/svyatoslavratov/bugspot/internal/store"
)

//go:embed migrations/*.sql
var migrations embed.FS

// Store is a store.Store over one SQLite database.
type Store struct {
	db *sql.DB
}

var _ store.Store = (*Store)(nil)

// Open opens or creates the database at path and applies pending migrations.
func Open(ctx context.Context, path string) (*Store, error) {
	dsn := "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)" +
		"&_pragma=foreign_keys(1)&_pragma=synchronous(NORMAL)&_txlock=immediate"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// One connection: writes are rare and small, and SQLite has one writer anyway.
	db.SetMaxOpenConns(1)
	s := &Store{db: db}
	if err := s.migrate(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) migrate(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY)`); err != nil {
		return err
	}
	names, err := fs.Glob(migrations, "migrations/*.sql")
	if err != nil {
		return err
	}
	sort.Strings(names)
	for _, name := range names {
		var done int
		if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM schema_migrations WHERE version = ?`, name).Scan(&done); err != nil {
			return err
		}
		if done > 0 {
			continue
		}
		script, err := migrations.ReadFile(name)
		if err != nil {
			return err
		}
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, string(script)); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration %s: %w", name, err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO schema_migrations (version) VALUES (?)`, name); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

// Close implements store.Store.
func (s *Store) Close() error { return s.db.Close() }

func ts(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

func optTS(t *time.Time) any {
	if t == nil {
		return nil
	}
	return ts(*t)
}

func parseTS(v string) time.Time {
	t, _ := time.Parse(time.RFC3339Nano, v)
	return t
}

func parseOptTS(v sql.NullString) *time.Time {
	if !v.Valid {
		return nil
	}
	t := parseTS(v.String)
	return &t
}

func searchText(t *domain.Thread) string {
	return strings.ToLower(t.Body + " " + t.Author.Name + " " + t.Route)
}

func authorJSON(a *domain.Author) any {
	if a == nil {
		return nil
	}
	b, _ := json.Marshal(a)
	return string(b)
}

const threadColumns = `id, number, project, route, url, title, kind, status, status_by, status_at, body,
	anchor, context, author_id, author_name, author_kind, has_screenshot, reply_count, created_at, updated_at,
	verified_by, verified_at`

type scanner interface{ Scan(dest ...any) error }

func scanThread(row scanner) (domain.Thread, error) {
	var (
		t                    domain.Thread
		statusBy, statusAt   sql.NullString
		verifiedBy, verified sql.NullString
		anchor, context      string
		created, updated     string
		kind, status, author string
	)
	err := row.Scan(&t.ID, &t.Number, &t.Project, &t.Route, &t.URL, &t.Title, &kind, &status,
		&statusBy, &statusAt, &t.Body, &anchor, &context, &t.Author.ID, &t.Author.Name, &author,
		&t.HasScreenshot, &t.ReplyCount, &created, &updated, &verifiedBy, &verified)
	if errors.Is(err, sql.ErrNoRows) {
		return t, domain.ErrNotFound
	}
	if err != nil {
		return t, err
	}
	t.Kind, t.Status, t.Author.Kind = domain.Kind(kind), domain.Status(status), domain.AuthorKind(author)
	t.Anchor, t.Context = json.RawMessage(anchor), json.RawMessage(context)
	t.CreatedAt, t.UpdatedAt = parseTS(created), parseTS(updated)
	t.StatusAt = parseOptTS(statusAt)
	t.StatusBy = parseAuthor(statusBy)
	t.VerifiedBy, t.VerifiedAt = parseAuthor(verifiedBy), parseOptTS(verified)
	t.Verified = t.VerifiedAt != nil
	return t, nil
}

func parseAuthor(v sql.NullString) *domain.Author {
	if !v.Valid {
		return nil
	}
	var a domain.Author
	if json.Unmarshal([]byte(v.String), &a) != nil {
		return nil
	}
	return &a
}

func rawOrEmpty(v json.RawMessage) string {
	if len(v) == 0 {
		return "{}"
	}
	return string(v)
}

// CreateThread implements store.Store.
func (s *Store) CreateThread(ctx context.Context, t *domain.Thread) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := tx.QueryRowContext(ctx, `SELECT coalesce(max(number), 0) + 1 FROM threads WHERE project = ?`, t.Project).Scan(&t.Number); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO threads (`+threadColumns+`, search)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		t.ID, t.Number, t.Project, t.Route, t.URL, t.Title, string(t.Kind), string(t.Status),
		authorJSON(t.StatusBy), optTS(t.StatusAt), t.Body, rawOrEmpty(t.Anchor), rawOrEmpty(t.Context),
		t.Author.ID, t.Author.Name, string(t.Author.Kind), t.HasScreenshot, t.ReplyCount,
		ts(t.CreatedAt), ts(t.UpdatedAt), authorJSON(t.VerifiedBy), optTS(t.VerifiedAt), searchText(t))
	if err != nil {
		return err
	}
	return tx.Commit()
}

func where(f domain.ThreadFilter) (string, []any) {
	clauses := []string{"project = ?", "deleted_at IS NULL"}
	args := []any{f.Project}
	if f.Route != "" {
		clauses = append(clauses, "route = ?")
		args = append(args, f.Route)
	}
	if len(f.Statuses) > 0 {
		marks := strings.TrimSuffix(strings.Repeat("?, ", len(f.Statuses)), ", ")
		clauses = append(clauses, "status IN ("+marks+")")
		for _, st := range f.Statuses {
			args = append(args, string(st))
		}
	}
	if f.Kind != "" {
		clauses = append(clauses, "kind = ?")
		args = append(args, string(f.Kind))
	}
	if f.Number != 0 {
		clauses = append(clauses, "number = ?")
		args = append(args, f.Number)
	}
	if f.Query != "" {
		clauses = append(clauses, `instr(search, ?) > 0`)
		args = append(args, strings.ToLower(f.Query))
	}
	return strings.Join(clauses, " AND "), args
}

// ListThreads implements store.Store.
func (s *Store) ListThreads(ctx context.Context, f domain.ThreadFilter) ([]domain.Thread, int, error) {
	cond, args := where(f)
	var total int
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM threads WHERE `+cond, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	page, limit := store.Page(f)
	//nolint:gosec // cond is built from fixed fragments with placeholders (see where)
	rows, err := s.db.QueryContext(ctx, `SELECT `+threadColumns+` FROM threads WHERE `+cond+
		` ORDER BY updated_at DESC, number DESC LIMIT ? OFFSET ?`, append(args, limit, (page-1)*limit)...)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = rows.Close() }()
	threads := []domain.Thread{}
	for rows.Next() {
		t, err := scanThread(rows)
		if err != nil {
			return nil, 0, err
		}
		threads = append(threads, t)
	}
	return threads, total, rows.Err()
}

// Summary implements store.Store.
func (s *Store) Summary(ctx context.Context, project, route string) (domain.Summary, error) {
	sum := store.EmptySummary()
	rows, err := s.db.QueryContext(ctx, `SELECT status, count(*), sum(route = ?) FROM threads
		WHERE project = ? AND deleted_at IS NULL GROUP BY status`, route, project)
	if err != nil {
		return sum, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var (
			status        string
			total, onPage int
		)
		if err := rows.Scan(&status, &total, &onPage); err != nil {
			return sum, err
		}
		sum.Total[domain.Status(status)] = total
		if route != "" {
			sum.Route[domain.Status(status)] = onPage
		}
	}
	return sum, rows.Err()
}

// GetThread implements store.Store.
func (s *Store) GetThread(ctx context.Context, project, id string) (domain.Thread, error) {
	return scanThread(s.db.QueryRowContext(ctx, `SELECT `+threadColumns+` FROM threads
		WHERE project = ? AND id = ? AND deleted_at IS NULL`, project, id))
}

// UpdateThread implements store.Store.
func (s *Store) UpdateThread(ctx context.Context, project, id string, fn func(*domain.Thread) error) (domain.Thread, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return domain.Thread{}, err
	}
	defer func() { _ = tx.Rollback() }()
	t, err := scanThread(tx.QueryRowContext(ctx, `SELECT `+threadColumns+` FROM threads
		WHERE project = ? AND id = ? AND deleted_at IS NULL`, project, id))
	if err != nil {
		return t, err
	}
	if err := fn(&t); err != nil {
		return domain.Thread{}, err
	}
	_, err = tx.ExecContext(ctx, `UPDATE threads SET kind = ?, status = ?, status_by = ?, status_at = ?,
		body = ?, has_screenshot = ?, reply_count = ?, updated_at = ?, verified_by = ?, verified_at = ?,
		search = ? WHERE id = ?`,
		string(t.Kind), string(t.Status), authorJSON(t.StatusBy), optTS(t.StatusAt), t.Body,
		t.HasScreenshot, t.ReplyCount, ts(t.UpdatedAt), authorJSON(t.VerifiedBy), optTS(t.VerifiedAt),
		searchText(&t), t.ID)
	if err != nil {
		return domain.Thread{}, err
	}
	return t, tx.Commit()
}

// DeleteThread implements store.Store. The thread stays as a tombstone; its screenshot goes.
func (s *Store) DeleteThread(ctx context.Context, project, id string, at time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	res, err := tx.ExecContext(ctx, `UPDATE threads SET deleted_at = ?, has_screenshot = 0
		WHERE project = ? AND id = ? AND deleted_at IS NULL`, ts(at), project, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return domain.ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM screenshots WHERE thread_id = ?`, id); err != nil {
		return err
	}
	return tx.Commit()
}

// AddReply implements store.Store.
func (s *Store) AddReply(ctx context.Context, project string, r *domain.Reply) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	res, err := tx.ExecContext(ctx, `UPDATE threads SET reply_count = reply_count + 1, updated_at = ?
		WHERE project = ? AND id = ? AND deleted_at IS NULL`, ts(r.CreatedAt), project, r.ThreadID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return domain.ErrNotFound
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO replies (id, thread_id, body, author_id, author_name,
		author_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, r.ID, r.ThreadID, r.Body,
		r.Author.ID, r.Author.Name, string(r.Author.Kind), ts(r.CreatedAt))
	if err != nil {
		return err
	}
	return tx.Commit()
}

// Replies implements store.Store.
func (s *Store) Replies(ctx context.Context, project, threadID string) ([]domain.Reply, error) {
	if _, err := s.GetThread(ctx, project, threadID); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id, thread_id, body, author_id, author_name, author_kind,
		created_at FROM replies WHERE thread_id = ? ORDER BY created_at, id`, threadID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	replies := []domain.Reply{}
	for rows.Next() {
		var (
			r             domain.Reply
			kind, created string
		)
		if err := rows.Scan(&r.ID, &r.ThreadID, &r.Body, &r.Author.ID, &r.Author.Name, &kind, &created); err != nil {
			return nil, err
		}
		r.Author.Kind, r.CreatedAt = domain.AuthorKind(kind), parseTS(created)
		replies = append(replies, r)
	}
	return replies, rows.Err()
}

// PutScreenshot implements store.Store.
func (s *Store) PutScreenshot(ctx context.Context, project, threadID, contentType string, data []byte) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	res, err := tx.ExecContext(ctx, `UPDATE threads SET has_screenshot = 1
		WHERE project = ? AND id = ? AND deleted_at IS NULL`, project, threadID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return domain.ErrNotFound
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO screenshots (thread_id, content_type, data) VALUES (?, ?, ?)
		ON CONFLICT (thread_id) DO UPDATE SET content_type = excluded.content_type, data = excluded.data`,
		threadID, contentType, data)
	if err != nil {
		return err
	}
	return tx.Commit()
}

// Screenshot implements store.Store.
func (s *Store) Screenshot(ctx context.Context, project, threadID string) (string, []byte, error) {
	var (
		contentType string
		data        []byte
	)
	err := s.db.QueryRowContext(ctx, `SELECT s.content_type, s.data FROM screenshots s
		JOIN threads t ON t.id = s.thread_id
		WHERE t.project = ? AND t.id = ? AND t.deleted_at IS NULL`, project, threadID).Scan(&contentType, &data)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil, domain.ErrNotFound
	}
	return contentType, data, err
}

func joinList(v []string) string { return strings.Join(v, ",") }

func splitList(v string) []string {
	if v == "" {
		return nil
	}
	return strings.Split(v, ",")
}

//nolint:gosec // column names, not a credential
const credentialColumns = `id, kind, name, hash, scopes, roles, created_at, expires_at, revoked_at, last_used_at`

func scanCredential(row scanner) (domain.Credential, error) {
	var (
		c                         domain.Credential
		kind, scopes, roles       string
		created                   string
		expires, revoked, touched sql.NullString
	)
	err := row.Scan(&c.ID, &kind, &c.Name, &c.Hash, &scopes, &roles, &created, &expires, &revoked, &touched)
	if errors.Is(err, sql.ErrNoRows) {
		return c, domain.ErrNotFound
	}
	if err != nil {
		return c, err
	}
	c.Kind, c.Scopes, c.Roles = domain.CredentialKind(kind), splitList(scopes), splitList(roles)
	c.CreatedAt = parseTS(created)
	c.ExpiresAt, c.RevokedAt, c.LastUsedAt = parseOptTS(expires), parseOptTS(revoked), parseOptTS(touched)
	return c, nil
}

// CreateCredential implements store.Store.
func (s *Store) CreateCredential(ctx context.Context, c domain.Credential) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO credentials (`+credentialColumns+`)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, c.ID, string(c.Kind), c.Name, c.Hash,
		joinList(c.Scopes), joinList(c.Roles), ts(c.CreatedAt), optTS(c.ExpiresAt),
		optTS(c.RevokedAt), optTS(c.LastUsedAt))
	return err
}

// CredentialByHash implements store.Store.
func (s *Store) CredentialByHash(ctx context.Context, hash string) (domain.Credential, error) {
	return scanCredential(s.db.QueryRowContext(ctx, `SELECT `+credentialColumns+` FROM credentials WHERE hash = ?`, hash))
}

// ListCredentials implements store.Store.
func (s *Store) ListCredentials(ctx context.Context, kind domain.CredentialKind) ([]domain.Credential, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+credentialColumns+` FROM credentials
		WHERE ? = '' OR kind = ? ORDER BY created_at`, string(kind), string(kind))
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []domain.Credential{}
	for rows.Next() {
		c, err := scanCredential(rows)
		if err != nil {
			return nil, err
		}
		c.Hash = ""
		out = append(out, c)
	}
	return out, rows.Err()
}

// RevokeCredential implements store.Store.
func (s *Store) RevokeCredential(ctx context.Context, id string, at time.Time) error {
	res, err := s.db.ExecContext(ctx, `UPDATE credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, ts(at), id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return domain.ErrNotFound
	}
	return nil
}

// TouchCredential implements store.Store.
func (s *Store) TouchCredential(ctx context.Context, id string, at time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE credentials SET last_used_at = ? WHERE id = ?`, ts(at), id)
	return err
}
