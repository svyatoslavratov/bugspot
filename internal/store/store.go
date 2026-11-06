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
	Summary(ctx context.Context, project, route string) (domain.Summary, error)
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

	CreateCredential(ctx context.Context, c domain.Credential) error
	CredentialByHash(ctx context.Context, hash string) (domain.Credential, error)
	ListCredentials(ctx context.Context, kind domain.CredentialKind) ([]domain.Credential, error)
	RevokeCredential(ctx context.Context, id string, at time.Time) error
	TouchCredential(ctx context.Context, id string, at time.Time) error

	Close() error
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
