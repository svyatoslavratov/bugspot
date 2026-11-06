// Package memory is an in-memory store for tests and the browser demo. It can export and import
// its whole state as JSON, which the demo keeps in localStorage.
package memory

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/svyatoslavratov/bugspot/internal/domain"
	"github.com/svyatoslavratov/bugspot/internal/store"
)

type screenshot struct {
	ContentType string `json:"contentType"`
	Data        []byte `json:"data"`
}

type deletedThread struct {
	domain.Thread
	DeletedAt *time.Time `json:"deletedAt,omitempty"`
}

// state is everything the store keeps; it is also the export format.
type state struct {
	Threads     []deletedThread       `json:"threads"`
	Replies     []domain.Reply        `json:"replies"`
	Screenshots map[string]screenshot `json:"screenshots"`
	Credentials []credential          `json:"credentials"`
}

// credential keeps the hash in the export, which domain.Credential hides from JSON.
type credential struct {
	domain.Credential
	Hash string `json:"hash"`
}

// Store is safe for concurrent use.
type Store struct {
	mu sync.Mutex
	s  state
}

var _ store.Store = (*Store)(nil)

// New returns an empty store.
func New() *Store { return &Store{s: state{Screenshots: map[string]screenshot{}}} }

// Export returns the whole state as JSON.
func (m *Store) Export() ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return json.Marshal(m.s)
}

// Import replaces the state with an export.
func (m *Store) Import(data []byte) error {
	var s state
	if err := json.Unmarshal(data, &s); err != nil {
		return err
	}
	if s.Screenshots == nil {
		s.Screenshots = map[string]screenshot{}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.s = s
	return nil
}

func (m *Store) find(project, id string) (int, bool) {
	for i, t := range m.s.Threads {
		if t.ID == id && t.Project == project && t.DeletedAt == nil {
			return i, true
		}
	}
	return 0, false
}

// CreateThread implements store.Store.
func (m *Store) CreateThread(_ context.Context, t *domain.Thread) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	number := 0
	for _, existing := range m.s.Threads {
		if existing.Project == t.Project && existing.Number > number {
			number = existing.Number
		}
	}
	t.Number = number + 1
	m.s.Threads = append(m.s.Threads, deletedThread{Thread: *t})
	return nil
}

func matches(t domain.Thread, f domain.ThreadFilter) bool {
	if t.Project != f.Project || (f.Route != "" && t.Route != f.Route) {
		return false
	}
	if len(f.Statuses) > 0 && !slices.Contains(f.Statuses, t.Status) {
		return false
	}
	if f.Kind != "" && t.Kind != f.Kind {
		return false
	}
	if f.Number != 0 && t.Number != f.Number {
		return false
	}
	if f.Query != "" {
		text := strings.ToLower(t.Body + " " + t.Author.Name + " " + t.Route)
		return strings.Contains(text, strings.ToLower(f.Query))
	}
	return true
}

// ListThreads implements store.Store.
func (m *Store) ListThreads(_ context.Context, f domain.ThreadFilter) ([]domain.Thread, int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var all []domain.Thread
	for _, t := range m.s.Threads {
		if t.DeletedAt == nil && matches(t.Thread, f) {
			all = append(all, t.Thread)
		}
	}
	slices.SortStableFunc(all, func(a, b domain.Thread) int { return b.UpdatedAt.Compare(a.UpdatedAt) })
	page, limit := store.Page(f)
	from := min((page-1)*limit, len(all))
	to := min(from+limit, len(all))
	return slices.Clone(all[from:to]), len(all), nil
}

// Summary implements store.Store.
func (m *Store) Summary(_ context.Context, project, route string) (domain.Summary, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := store.EmptySummary()
	for _, t := range m.s.Threads {
		if t.Project != project || t.DeletedAt != nil {
			continue
		}
		s.Total[t.Status]++
		if route != "" && t.Route == route {
			s.Route[t.Status]++
		}
	}
	return s, nil
}

// GetThread implements store.Store.
func (m *Store) GetThread(_ context.Context, project, id string) (domain.Thread, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	i, ok := m.find(project, id)
	if !ok {
		return domain.Thread{}, domain.ErrNotFound
	}
	return m.s.Threads[i].Thread, nil
}

// UpdateThread implements store.Store.
func (m *Store) UpdateThread(_ context.Context, project, id string, fn func(*domain.Thread) error) (domain.Thread, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	i, ok := m.find(project, id)
	if !ok {
		return domain.Thread{}, domain.ErrNotFound
	}
	t := m.s.Threads[i].Thread
	if err := fn(&t); err != nil {
		return domain.Thread{}, err
	}
	m.s.Threads[i].Thread = t
	return t, nil
}

// DeleteThread implements store.Store.
func (m *Store) DeleteThread(_ context.Context, project, id string, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	i, ok := m.find(project, id)
	if !ok {
		return domain.ErrNotFound
	}
	m.s.Threads[i].DeletedAt = &at
	delete(m.s.Screenshots, id)
	return nil
}

// AddReply implements store.Store.
func (m *Store) AddReply(_ context.Context, project string, r *domain.Reply) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	i, ok := m.find(project, r.ThreadID)
	if !ok {
		return domain.ErrNotFound
	}
	m.s.Replies = append(m.s.Replies, *r)
	m.s.Threads[i].ReplyCount++
	m.s.Threads[i].UpdatedAt = r.CreatedAt
	return nil
}

// Replies implements store.Store.
func (m *Store) Replies(_ context.Context, project, threadID string) ([]domain.Reply, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.find(project, threadID); !ok {
		return nil, domain.ErrNotFound
	}
	replies := []domain.Reply{}
	for _, r := range m.s.Replies {
		if r.ThreadID == threadID {
			replies = append(replies, r)
		}
	}
	return replies, nil
}

// PutScreenshot implements store.Store.
func (m *Store) PutScreenshot(_ context.Context, project, threadID, contentType string, data []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	i, ok := m.find(project, threadID)
	if !ok {
		return domain.ErrNotFound
	}
	m.s.Screenshots[threadID] = screenshot{ContentType: contentType, Data: slices.Clone(data)}
	m.s.Threads[i].HasScreenshot = true
	return nil
}

// Screenshot implements store.Store.
func (m *Store) Screenshot(_ context.Context, project, threadID string) (string, []byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.find(project, threadID); !ok {
		return "", nil, domain.ErrNotFound
	}
	s, ok := m.s.Screenshots[threadID]
	if !ok {
		return "", nil, domain.ErrNotFound
	}
	return s.ContentType, slices.Clone(s.Data), nil
}

// CreateCredential implements store.Store.
func (m *Store) CreateCredential(_ context.Context, c domain.Credential) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.s.Credentials = append(m.s.Credentials, credential{Credential: c, Hash: c.Hash})
	return nil
}

// CredentialByHash implements store.Store.
func (m *Store) CredentialByHash(_ context.Context, hash string) (domain.Credential, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, c := range m.s.Credentials {
		if c.Hash == hash {
			out := c.Credential
			out.Hash = c.Hash
			return out, nil
		}
	}
	return domain.Credential{}, domain.ErrNotFound
}

// ListCredentials implements store.Store.
func (m *Store) ListCredentials(_ context.Context, kind domain.CredentialKind) ([]domain.Credential, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []domain.Credential{}
	for _, c := range m.s.Credentials {
		if kind == "" || c.Kind == kind {
			listed := c.Credential
			listed.Hash = ""
			out = append(out, listed)
		}
	}
	return out, nil
}

// RevokeCredential implements store.Store.
func (m *Store) RevokeCredential(_ context.Context, id string, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i, c := range m.s.Credentials {
		if c.ID == id && c.RevokedAt == nil {
			m.s.Credentials[i].RevokedAt = &at
			return nil
		}
	}
	return domain.ErrNotFound
}

// TouchCredential implements store.Store.
func (m *Store) TouchCredential(_ context.Context, id string, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i, c := range m.s.Credentials {
		if c.ID == id {
			m.s.Credentials[i].LastUsedAt = &at
			return nil
		}
	}
	return domain.ErrNotFound
}

// Close implements store.Store.
func (m *Store) Close() error { return nil }
