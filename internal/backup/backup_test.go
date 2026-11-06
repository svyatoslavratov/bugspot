package backup

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// fake writes the path it is asked for, or fails.
type fake struct {
	mu    sync.Mutex
	paths []string
	err   error
}

func (f *fake) Backup(_ context.Context, path string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return f.err
	}
	f.paths = append(f.paths, path)
	return os.WriteFile(path, []byte("db"), 0o600)
}

func (f *fake) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.paths)
}

func files(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

var day = time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)

func TestTakeNamesBySnapshotTime(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested")
	path, err := Take(context.Background(), &fake{}, dir, day)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(path) != "bugspot-20261106-120000.db" {
		t.Fatalf("path = %s", path)
	}
	if info, err := os.Stat(dir); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("dir = %v, %v", info, err)
	}
}

func TestPruneKeepsRecentNewestAndForeignFiles(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{
		Name(day.AddDate(0, 0, -30)), Name(day.AddDate(0, 0, -15)), Name(day.AddDate(0, 0, -2)), Name(day),
		"notes.txt", "bugspot-latest.db",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	removed, err := Prune(dir, 14, day)
	if err != nil || removed != 2 {
		t.Fatalf("removed = %d, %v", removed, err)
	}
	want := []string{"bugspot-20261104-120000.db", "bugspot-20261106-120000.db", "bugspot-latest.db", "notes.txt"}
	if got := files(t, dir); !slices.Equal(got, want) {
		t.Fatalf("left = %v", got)
	}

	// The newest snapshot stays even when it is past the retention.
	if removed, err := Prune(dir, 1, day.AddDate(0, 1, 0)); err != nil || removed != 1 {
		t.Fatalf("removed = %d, %v", removed, err)
	}
	if got := files(t, dir); !slices.Contains(got, "bugspot-20261106-120000.db") {
		t.Fatalf("the newest snapshot is gone: %v", got)
	}
	if removed, err := Prune(dir, 0, day.AddDate(1, 0, 0)); err != nil || removed != 0 {
		t.Fatalf("keep forever removed %d, %v", removed, err)
	}
	if _, err := Prune(filepath.Join(dir, "missing"), 14, day); err == nil {
		t.Fatal("no error for a missing dir")
	}
}

func TestRunSnapshotsAtStartAndOnEveryTick(t *testing.T) {
	dir := t.TempDir()
	st := &fake{}
	var logs bytes.Buffer
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	tick := day
	var mu sync.Mutex
	now := func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		tick = tick.Add(time.Minute)
		return tick
	}
	go func() {
		Run(ctx, Options{Dir: dir, Every: 20 * time.Millisecond, KeepDays: 14, Store: st,
			Logger: slog.New(slog.NewTextHandler(&logs, nil)), Now: now})
		close(done)
	}()
	deadline := time.Now().Add(5 * time.Second)
	for st.count() < 3 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	<-done
	if st.count() < 3 {
		t.Fatalf("snapshots = %d", st.count())
	}
	if !strings.Contains(logs.String(), "backup written") {
		t.Fatalf("logs = %s", logs.String())
	}
}

func TestRunSkipsTheStartSnapshotWhenOneIsFresh(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, Name(day.Add(-time.Minute))), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	st := &fake{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	Run(ctx, Options{Dir: dir, Every: time.Hour, Store: st, Logger: slog.New(slog.DiscardHandler),
		Now: func() time.Time { return day }})
	if st.count() != 0 {
		t.Fatalf("snapshots = %d", st.count())
	}
}

func TestRunLogsFailures(t *testing.T) {
	var logs bytes.Buffer
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	Run(ctx, Options{Dir: t.TempDir(), Every: time.Hour, Store: &fake{err: errors.New("disk full")},
		Logger: slog.New(slog.NewTextHandler(&logs, nil))})
	if !strings.Contains(logs.String(), "backup failed") || !strings.Contains(logs.String(), "disk full") {
		t.Fatalf("logs = %s", logs.String())
	}
}

func TestDescribe(t *testing.T) {
	if got := Describe(Options{}); got != "off" {
		t.Fatalf("off = %q", got)
	}
	if got := Describe(Options{Dir: "/backups", Every: 24 * time.Hour, KeepDays: 14}); got != "/backups every 24h0m0s, kept 14 days" {
		t.Fatalf("on = %q", got)
	}
	if got := Describe(Options{Dir: "/b", Every: time.Hour}); !strings.HasSuffix(got, "kept forever") {
		t.Fatalf("forever = %q", got)
	}
}
