// Package domain holds the feedback model shared by the store, the API and the CLI.
package domain

import (
	"encoding/json"
	"errors"
	"time"
)

// Status is where a thread is in its life: open, taken into work, fixed and waiting for a check,
// resolved by a person or declined.
type Status string

// Thread statuses.
const (
	StatusOpen       Status = "open"
	StatusInProgress Status = "in_progress"
	StatusFixed      Status = "fixed"
	StatusResolved   Status = "resolved"
	StatusWontfix    Status = "wontfix"
)

// Statuses lists every status in display order.
var Statuses = []Status{StatusOpen, StatusInProgress, StatusFixed, StatusResolved, StatusWontfix}

// Valid reports whether s is a known status.
func (s Status) Valid() bool {
	for _, known := range Statuses {
		if s == known {
			return true
		}
	}
	return false
}

// Closed reports whether the thread needs no more work.
func (s Status) Closed() bool { return s == StatusResolved || s == StatusWontfix }

// Kind is what the author left: a defect, a question or an idea.
type Kind string

// Thread kinds.
const (
	KindIssue    Kind = "issue"
	KindQuestion Kind = "question"
	KindIdea     Kind = "idea"
)

// Valid reports whether k is a known kind.
func (k Kind) Valid() bool { return k == KindIssue || k == KindQuestion || k == KindIdea }

// AuthorKind tells a person from an API agent.
type AuthorKind string

// Author kinds.
const (
	AuthorUser  AuthorKind = "user"
	AuthorAgent AuthorKind = "agent"
)

// Author is who wrote a thread or a reply, as the identity provider named them at that moment.
type Author struct {
	ID   string     `json:"id"`
	Name string     `json:"name"`
	Kind AuthorKind `json:"kind"`
}

// Thread is a comment pinned to an element of a page, with its replies counted.
type Thread struct {
	ID      string `json:"id"`
	Number  int    `json:"number"`
	Project string `json:"project"`
	// Route is the page key the widget matches pins by: the path, or the hash path of a hash router.
	Route string `json:"route"`
	URL   string `json:"url"`
	Title string `json:"title"`
	Kind  Kind   `json:"kind"`
	// Status changes are kept with who and when.
	Status   Status     `json:"status"`
	StatusBy *Author    `json:"statusBy,omitempty"`
	StatusAt *time.Time `json:"statusAt,omitempty"`
	Body     string     `json:"body"`
	// Anchor finds the element again: selector, text, offset, page point and viewport.
	Anchor json.RawMessage `json:"anchor"`
	// Context is what the widget captured: browser, viewport, app version, console errors and
	// failed requests.
	Context       json.RawMessage `json:"context"`
	Author        Author          `json:"author"`
	HasScreenshot bool            `json:"hasScreenshot"`
	ReplyCount    int             `json:"replyCount"`
	CreatedAt     time.Time       `json:"createdAt"`
	UpdatedAt     time.Time       `json:"updatedAt"`
}

// Reply is an answer in a thread.
type Reply struct {
	ID        string    `json:"id"`
	ThreadID  string    `json:"threadId"`
	Body      string    `json:"body"`
	Author    Author    `json:"author"`
	CreatedAt time.Time `json:"createdAt"`
}

// ThreadFilter narrows a thread list; empty fields do not filter.
type ThreadFilter struct {
	Project  string
	Route    string
	Statuses []Status
	Kind     Kind
	// Query is matched case-insensitively against the body, the author and the route.
	Query string
	// Number finds one thread by its project-wide number.
	Number int
	Page   int
	Limit  int
}

// Summary counts threads by status in the project and on one route.
type Summary struct {
	Total map[Status]int `json:"total"`
	Route map[Status]int `json:"route"`
}

// CredentialKind tells agent API tokens from access keys for people.
type CredentialKind string

// Credential kinds.
const (
	CredentialAgent CredentialKind = "agent"
	CredentialKey   CredentialKind = "key"
)

// Credential is an agent token or an access key; only its SHA-256 hash is stored.
type Credential struct {
	ID         string         `json:"id"`
	Kind       CredentialKind `json:"kind"`
	Name       string         `json:"name"`
	Hash       string         `json:"-"`
	Scopes     []string       `json:"scopes,omitempty"`
	Roles      []string       `json:"roles,omitempty"`
	CreatedAt  time.Time      `json:"createdAt"`
	ExpiresAt  *time.Time     `json:"expiresAt,omitempty"`
	RevokedAt  *time.Time     `json:"revokedAt,omitempty"`
	LastUsedAt *time.Time     `json:"lastUsedAt,omitempty"`
}

// Active reports whether the credential still works at now.
func (c Credential) Active(now time.Time) bool {
	if c.RevokedAt != nil {
		return false
	}
	return c.ExpiresAt == nil || now.Before(*c.ExpiresAt)
}

// Agent token scopes.
const (
	ScopeRead   = "read"
	ScopeReply  = "reply"
	ScopeStatus = "status"
)

// ErrNotFound is returned for a missing thread, reply, screenshot or credential.
var ErrNotFound = errors.New("not found")
