package sqlite_test

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/svyatoslavratov/bugspot/internal/domain"
	"github.com/svyatoslavratov/bugspot/internal/store"
	"github.com/svyatoslavratov/bugspot/internal/store/sqlite"
	"github.com/svyatoslavratov/bugspot/internal/store/storetest"
)

func open(t *testing.T, path string) *sqlite.Store {
	t.Helper()
	s, err := sqlite.Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestStore(t *testing.T) {
	storetest.Run(t, func(t *testing.T) store.Store {
		return open(t, filepath.Join(t.TempDir(), "bugspot.db"))
	})
}

func TestReopenKeepsDataAndSkipsMigrations(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bugspot.db")
	ctx := context.Background()
	s, err := sqlite.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.CreateThread(ctx, &domain.Thread{ID: "t1", Project: "p", Status: domain.StatusOpen}); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := open(t, path).GetThread(ctx, "p", "t1"); err != nil {
		t.Fatalf("after reopen: %v", err)
	}
}
