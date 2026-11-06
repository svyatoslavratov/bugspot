package sqlite_test

import (
	"context"
	"errors"
	"os"
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

func TestBackupIsAWorkingCopy(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s := open(t, filepath.Join(dir, "bugspot.db"))
	if err := s.CreateThread(ctx, &domain.Thread{ID: "t1", Project: "p", Status: domain.StatusOpen, Body: "first"}); err != nil {
		t.Fatal(err)
	}
	if err := s.PutScreenshot(ctx, "p", "t1", "image/webp", []byte("pixels")); err != nil {
		t.Fatal(err)
	}
	copyPath := filepath.Join(dir, "copy.db")
	if err := s.Backup(ctx, copyPath); err != nil {
		t.Fatal(err)
	}
	// A second backup to the same path replaces the file instead of failing.
	if err := s.CreateThread(ctx, &domain.Thread{ID: "t2", Project: "p", Status: domain.StatusOpen}); err != nil {
		t.Fatal(err)
	}
	if err := s.Backup(ctx, copyPath); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(copyPath); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("copy mode = %v, %v", info.Mode(), err)
	}
	if _, err := os.Stat(copyPath + ".part"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("temporary file left: %v", err)
	}
	c := open(t, copyPath)
	for _, id := range []string{"t1", "t2"} {
		if _, err := c.GetThread(ctx, "p", id); err != nil {
			t.Fatalf("%s in the copy: %v", id, err)
		}
	}
	if _, data, err := c.Screenshot(ctx, "p", "t1"); err != nil || string(data) != "pixels" {
		t.Fatalf("screenshot in the copy = %q, %v", data, err)
	}
	if err := s.Backup(ctx, filepath.Join(dir, "missing", "copy.db")); err == nil {
		t.Fatal("no error for a missing directory")
	}
}
