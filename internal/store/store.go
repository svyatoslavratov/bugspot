// Package store defines where threads, replies, screenshots and credentials live. The server
// ships SQLite (one file, nothing to set up); the browser demo and tests use the memory store.
package store

import (
	"context"
	"time"

	"github.com/svyatoslavratov/bugspot/internal/domain"
)

// Store is the storage the API needs. Every thread method is scoped to a project.
type Store interface {
	// CreateThread saves t and assigns its project-wide Number.
	CreateThread(ctx context.Context, t *domain.Thread) error
	// ListThreads returns a page of threads without deleted ones, newest activity first, and the
	// total count for the filter.
	ListThreads(ctx context.Context, f domain.ThreadFilter) ([]domain.Thread, int, error)
	// Summary counts threads by status in the project and on a page: its route, or its screen.
	Summary(ctx context.Context, project, route, screen string) (domain.Summary, error)
	GetThread(ctx context.Context, project, id string) (domain.Thread, error)
	// UpdateThread loads the thread, lets fn change it and saves it atomically.
	UpdateThread(ctx context.Context, project, id string, fn func(*domain.Thread) error) (domain.Thread, error)
	DeleteThread(ctx context.Context, project, id string, at time.Time) error

	// AddReply saves r and bumps the thread's reply count and update time.
	AddReply(ctx context.Context, project string, r *domain.Reply) error
	Replies(ctx context.Context, project, threadID string) ([]domain.Reply, error)

	// PutScreenshot replaces the thread's screenshot.
	PutScreenshot(ctx context.Context, project, threadID, contentType string, data []byte) error
	Screenshot(ctx context.Context, project, threadID string) (contentType string, data []byte, err error)

	MapStore

	CreateCredential(ctx context.Context, c domain.Credential) error
	CredentialByHash(ctx context.Context, hash string) (domain.Credential, error)
	ListCredentials(ctx context.Context, kind domain.CredentialKind) ([]domain.Credential, error)
	RevokeCredential(ctx context.Context, id string, at time.Time) error
	TouchCredential(ctx context.Context, id string, at time.Time) error

	Close() error
}

// MapStore keeps the screen map of each project: screens and their states, the look of each state
// (a thumbnail and a DOM snapshot whose stylesheets are stored once as assets), the transitions,
// and the aliases of merged screens. Keys that are aliases land on their screens everywhere.
type MapStore interface {
	// ScreenMap returns every screen with its states (without the looks), the transitions and the
	// aliases, screens in section and order.
	ScreenMap(ctx context.Context, project string) (domain.ScreenMap, error)
	// RecordVisits saves what people saw: screens and states are created or touched, transitions
	// counted (a link or an observed transition never downgrades a declared one).
	RecordVisits(ctx context.Context, project string, visits []domain.Visit, edges []domain.Edge, at time.Time) error
	// AddScreen creates a planned screen; a key that is already taken is domain.ErrConflict.
	AddScreen(ctx context.Context, project string, s domain.Screen) error
	// PatchScreens changes screens all together; an unknown key is domain.ErrNotFound, merging into
	// itself or into an unknown screen domain.ErrConflict.
	PatchScreens(ctx context.Context, project string, patches []domain.ScreenPatch, at time.Time) error
	// PatchStates changes states all together; an unknown state is domain.ErrNotFound.
	PatchStates(ctx context.Context, project string, patches []domain.StatePatch, at time.Time) error
	// ImportMap applies a manifest all together: screens it names are created as planned or
	// updated with the fields it gives, states are created or described, its transitions declared.
	// Keys must already be normalized (domain.PatternKey); aliases land on their screens.
	ImportMap(ctx context.Context, project string, m domain.Manifest, at time.Time) (domain.ImportResult, error)

	// PutShot replaces the thumbnail of a state, creating the screen and the state if needed.
	PutShot(ctx context.Context, project string, ref domain.StateRef, contentType string, data []byte, at time.Time) error
	Shot(ctx context.Context, project string, ref domain.StateRef) (contentType string, data []byte, err error)
	// PutSnapshot replaces the DOM snapshot of a state, creating the screen and the state if needed.
	PutSnapshot(ctx context.Context, project string, s domain.Snapshot) error
	Snapshot(ctx context.Context, project string, ref domain.StateRef) (domain.Snapshot, error)

	// MissingAssets returns those of hashes the store does not have, in their order.
	MissingAssets(ctx context.Context, project string, hashes []string) ([]string, error)
	// PutAsset stores a stylesheet of snapshots under its hash; storing it again changes nothing.
	PutAsset(ctx context.Context, project, hash, contentType string, data []byte) error
	Asset(ctx context.Context, project, hash string) (contentType string, data []byte, err error)

	// ThreadCounts counts the threads that are not deleted by screen, route and status.
	ThreadCounts(ctx context.Context, project string) ([]domain.ThreadCount, error)
}

// DefaultLimit and MaxLimit bound thread pages.
const (
	DefaultLimit = 50
	MaxLimit     = 100
)

// Page normalizes the page and limit of a filter.
func Page(f domain.ThreadFilter) (page, limit int) {
	page, limit = f.Page, f.Limit
	if page < 1 {
		page = 1
	}
	if limit < 1 {
		limit = DefaultLimit
	}
	if limit > MaxLimit {
		limit = MaxLimit
	}
	return page, limit
}

// EmptySummary returns a summary with every status counted as zero.
func EmptySummary() domain.Summary {
	s := domain.Summary{Total: map[domain.Status]int{}, Route: map[domain.Status]int{}}
	for _, st := range domain.Statuses {
		s.Total[st] = 0
		s.Route[st] = 0
	}
	return s
}
