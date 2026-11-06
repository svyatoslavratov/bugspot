// Package storetest is the behaviour every store.Store must share; each store runs it in its tests.
package storetest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/svyatoslavratov/bugspot/internal/domain"
	"github.com/svyatoslavratov/bugspot/internal/store"
)

var base = time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)

func thread(id, route, body string, at time.Time) *domain.Thread {
	return &domain.Thread{
		ID: id, Project: "p", Route: route, URL: "https://app.test" + route, Title: "Page",
		Kind: domain.KindIssue, Status: domain.StatusOpen, Body: body,
		Anchor:    json.RawMessage(`{"selector":"#x"}`),
		Context:   json.RawMessage(`{"viewport":{"w":1440,"h":900}}`),
		Author:    domain.Author{ID: "u1", Name: "Анна", Kind: domain.AuthorUser},
		CreatedAt: at, UpdatedAt: at,
	}
}

// Run checks a fresh store returned by open.
func Run(t *testing.T, open func(t *testing.T) store.Store) {
	t.Run("threads", func(t *testing.T) { threads(t, open(t)) })
	t.Run("replies and screenshots", func(t *testing.T) { replies(t, open(t)) })
	t.Run("credentials", func(t *testing.T) { credentials(t, open(t)) })
}

func threads(t *testing.T, s store.Store) {
	ctx := context.Background()
	for i, route := range []string{"/a", "/a", "/b"} {
		th := thread(fmt.Sprint("t", i+1), route, fmt.Sprint("Кнопка ", i+1), base.Add(time.Duration(i)*time.Minute))
		if err := s.CreateThread(ctx, th); err != nil {
			t.Fatal(err)
		}
		if th.Number != i+1 {
			t.Fatalf("number = %d, want %d", th.Number, i+1)
		}
	}
	other := thread("x1", "/a", "чужой проект", base)
	other.Project = "q"
	if err := s.CreateThread(ctx, other); err != nil || other.Number != 1 {
		t.Fatalf("other project: number %d, err %v", other.Number, err)
	}

	list, total, err := s.ListThreads(ctx, domain.ThreadFilter{Project: "p"})
	if err != nil || total != 3 || len(list) != 3 || list[0].ID != "t3" {
		t.Fatalf("list = %v total %d err %v, want newest first", ids(list), total, err)
	}
	list, total, _ = s.ListThreads(ctx, domain.ThreadFilter{Project: "p", Route: "/a", Limit: 1, Page: 2})
	if total != 2 || len(list) != 1 || list[0].ID != "t1" {
		t.Fatalf("route page 2 = %v total %d", ids(list), total)
	}
	list, _, _ = s.ListThreads(ctx, domain.ThreadFilter{Project: "p", Number: 3})
	if len(list) != 1 || list[0].ID != "t3" {
		t.Fatalf("by number = %v", ids(list))
	}
	list, _, _ = s.ListThreads(ctx, domain.ThreadFilter{Project: "p", Query: "КНОПКА 2"})
	if len(list) != 1 || list[0].ID != "t2" {
		t.Fatalf("case-insensitive Cyrillic search = %v", ids(list))
	}

	at := base.Add(time.Hour)
	updated, err := s.UpdateThread(ctx, "p", "t1", func(th *domain.Thread) error {
		th.Status, th.StatusAt, th.UpdatedAt = domain.StatusFixed, &at, at
		th.StatusBy = &domain.Author{ID: "bot", Name: "Agent", Kind: domain.AuthorAgent}
		th.Verified, th.VerifiedAt = true, &at
		th.VerifiedBy = &domain.Author{ID: "u2", Name: "Борис", Kind: domain.AuthorUser}
		return nil
	})
	if err != nil || updated.Status != domain.StatusFixed {
		t.Fatalf("update: %v %v", updated.Status, err)
	}
	got, err := s.GetThread(ctx, "p", "t1")
	if err != nil || got.StatusBy == nil || got.StatusBy.Kind != domain.AuthorAgent || !got.UpdatedAt.Equal(at) {
		t.Fatalf("get after update = %+v, %v", got, err)
	}
	if !got.Verified || got.VerifiedBy == nil || got.VerifiedBy.Name != "Борис" || !got.VerifiedAt.Equal(at) {
		t.Fatalf("verification after update = %v %+v %v", got.Verified, got.VerifiedBy, got.VerifiedAt)
	}
	if string(got.Anchor) != `{"selector":"#x"}` {
		t.Fatalf("anchor = %s", got.Anchor)
	}
	stop := errors.New("stop")
	if _, err := s.UpdateThread(ctx, "p", "t2", func(*domain.Thread) error { return stop }); !errors.Is(err, stop) {
		t.Fatalf("update error = %v", err)
	}
	if _, err := s.GetThread(ctx, "q", "t1"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("thread of another project: %v", err)
	}

	list, _, _ = s.ListThreads(ctx, domain.ThreadFilter{Project: "p", Statuses: []domain.Status{domain.StatusFixed, domain.StatusResolved}})
	if len(list) != 1 || list[0].ID != "t1" {
		t.Fatalf("status filter = %v", ids(list))
	}
	sum, err := s.Summary(ctx, "p", "/a")
	if err != nil || sum.Total[domain.StatusOpen] != 2 || sum.Total[domain.StatusFixed] != 1 ||
		sum.Route[domain.StatusOpen] != 1 || sum.Route[domain.StatusWontfix] != 0 {
		t.Fatalf("summary = %+v, %v", sum, err)
	}

	if err := s.DeleteThread(ctx, "p", "t2", at); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetThread(ctx, "p", "t2"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("deleted thread: %v", err)
	}
	if err := s.DeleteThread(ctx, "p", "t2", at); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("delete twice: %v", err)
	}
	next := thread("t4", "/c", "после удаления", at)
	if err := s.CreateThread(ctx, next); err != nil || next.Number != 4 {
		t.Fatalf("numbers are not reused: %d %v", next.Number, err)
	}
}

func replies(t *testing.T, s store.Store) {
	ctx := context.Background()
	if err := s.CreateThread(ctx, thread("t1", "/a", "x", base)); err != nil {
		t.Fatal(err)
	}
	for i := range 2 {
		r := &domain.Reply{ID: fmt.Sprint("r", i), ThreadID: "t1", Body: fmt.Sprint("ответ ", i),
			Author: domain.Author{ID: "bot", Name: "Agent", Kind: domain.AuthorAgent}, CreatedAt: base.Add(time.Duration(i+1) * time.Minute)}
		if err := s.AddReply(ctx, "p", r); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.AddReply(ctx, "p", &domain.Reply{ID: "r9", ThreadID: "missing", CreatedAt: base}); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("reply to a missing thread: %v", err)
	}
	got, _ := s.GetThread(ctx, "p", "t1")
	if got.ReplyCount != 2 || !got.UpdatedAt.Equal(base.Add(2*time.Minute)) {
		t.Fatalf("reply count %d, updated %v", got.ReplyCount, got.UpdatedAt)
	}
	list, err := s.Replies(ctx, "p", "t1")
	if err != nil || len(list) != 2 || list[0].ID != "r0" || list[1].Author.Kind != domain.AuthorAgent {
		t.Fatalf("replies = %+v, %v", list, err)
	}

	if _, _, err := s.Screenshot(ctx, "p", "t1"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("no screenshot yet: %v", err)
	}
	if err := s.PutScreenshot(ctx, "p", "t1", "image/png", []byte{1, 2, 3}); err != nil {
		t.Fatal(err)
	}
	if err := s.PutScreenshot(ctx, "p", "t1", "image/jpeg", []byte{4, 5}); err != nil {
		t.Fatal(err)
	}
	ct, data, err := s.Screenshot(ctx, "p", "t1")
	if err != nil || ct != "image/jpeg" || len(data) != 2 {
		t.Fatalf("screenshot = %s %v %v", ct, data, err)
	}
	if got, _ := s.GetThread(ctx, "p", "t1"); !got.HasScreenshot {
		t.Fatal("thread does not know about its screenshot")
	}
	if _, _, err := s.Screenshot(ctx, "q", "t1"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("screenshot from another project: %v", err)
	}
	if err := s.DeleteThread(ctx, "p", "t1", base); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Screenshot(ctx, "p", "t1"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("screenshot of a deleted thread: %v", err)
	}
}

func credentials(t *testing.T, s store.Store) {
	ctx := context.Background()
	expires := base.Add(24 * time.Hour)
	agent := domain.Credential{ID: "c1", Kind: domain.CredentialAgent, Name: "claude", Hash: "h1",
		Scopes: []string{domain.ScopeRead, domain.ScopeReply}, CreatedAt: base}
	key := domain.Credential{ID: "c2", Kind: domain.CredentialKey, Name: "Заказчик", Hash: "h2",
		Roles: []string{"customer"}, CreatedAt: base, ExpiresAt: &expires}
	for _, c := range []domain.Credential{agent, key} {
		if err := s.CreateCredential(ctx, c); err != nil {
			t.Fatal(err)
		}
	}
	got, err := s.CredentialByHash(ctx, "h2")
	if err != nil || got.ID != "c2" || got.Roles[0] != "customer" || got.ExpiresAt == nil || !got.Active(base) || got.Active(expires) {
		t.Fatalf("by hash = %+v, %v", got, err)
	}
	if _, err := s.CredentialByHash(ctx, "nope"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("unknown hash: %v", err)
	}
	list, err := s.ListCredentials(ctx, domain.CredentialAgent)
	if err != nil || len(list) != 1 || list[0].Hash != "" || len(list[0].Scopes) != 2 {
		t.Fatalf("list agents = %+v, %v", list, err)
	}
	if err := s.TouchCredential(ctx, "c1", base.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := s.RevokeCredential(ctx, "c1", base.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := s.RevokeCredential(ctx, "c1", base); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("revoke twice: %v", err)
	}
	got, _ = s.CredentialByHash(ctx, "h1")
	if got.Active(base.Add(time.Hour)) || got.LastUsedAt == nil {
		t.Fatalf("revoked credential = %+v", got)
	}
	if all, _ := s.ListCredentials(ctx, ""); len(all) != 2 {
		t.Fatalf("list all = %d", len(all))
	}
}

func ids(list []domain.Thread) []string {
	out := make([]string, len(list))
	for i, t := range list {
		out[i] = t.ID
	}
	return out
}
