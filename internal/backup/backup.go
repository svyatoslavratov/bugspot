// Package backup keeps dated snapshots of the database in a directory: one when the service
// starts (so every upgrade leaves a copy of the data it started from), then one per interval, and
// removes snapshots older than the retention.
package backup

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	prefix = "bugspot-"
	suffix = ".db"
	stamp  = "20060102-150405"
	// fresh: a snapshot younger than this makes the one at start unnecessary, so a container that
	// restarts in a loop does not fill the disk.
	fresh = 10 * time.Minute
)

// Snapshotter writes a consistent copy of the database to a file.
type Snapshotter interface {
	Backup(ctx context.Context, path string) error
}

// Options configure Run.
type Options struct {
	Dir   string
	Every time.Duration
	// KeepDays removes snapshots older than this many days; 0 keeps them all.
	KeepDays int
	Store    Snapshotter
	Logger   *slog.Logger
	Now      func() time.Time
}

// Name is the file name of a snapshot taken at t.
func Name(t time.Time) string { return prefix + t.UTC().Format(stamp) + suffix }

// Take writes one snapshot into dir and returns its path.
func Take(ctx context.Context, st Snapshotter, dir string, now time.Time) (string, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	path := filepath.Join(dir, Name(now))
	if err := st.Backup(ctx, path); err != nil {
		return "", err
	}
	return path, nil
}

// snapshots lists the snapshot files of dir with their times, oldest first (the time stamp in the
// name sorts the same way as the time).
func snapshots(dir string) ([]string, []time.Time, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, nil, err
	}
	var names []string
	var times []time.Time
	for _, e := range entries { // os.ReadDir sorts by name
		n := e.Name()
		if e.IsDir() || !strings.HasPrefix(n, prefix) || !strings.HasSuffix(n, suffix) {
			continue
		}
		t, err := time.Parse(stamp, strings.TrimSuffix(strings.TrimPrefix(n, prefix), suffix))
		if err != nil {
			continue
		}
		names = append(names, n)
		times = append(times, t)
	}
	return names, times, nil
}

// Prune removes snapshots older than keepDays and returns how many it removed. The newest
// snapshot always stays, however old it is.
func Prune(dir string, keepDays int, now time.Time) (int, error) {
	if keepDays <= 0 {
		return 0, nil
	}
	names, times, err := snapshots(dir)
	if err != nil {
		return 0, err
	}
	cutoff := now.Add(-time.Duration(keepDays) * 24 * time.Hour)
	removed := 0
	for i := 0; i < len(names)-1; i++ {
		if times[i].Before(cutoff) {
			if err := os.Remove(filepath.Join(dir, names[i])); err != nil {
				return removed, err
			}
			removed++
		}
	}
	return removed, nil
}

// latest is the time of the newest snapshot in dir, or zero.
func latest(dir string) time.Time {
	_, times, err := snapshots(dir)
	if err != nil || len(times) == 0 {
		return time.Time{}
	}
	return times[len(times)-1]
}

// Run takes snapshots until ctx ends. Errors are logged and retried at the next tick: a failed
// backup must not take the service down.
func Run(ctx context.Context, o Options) {
	now := o.Now
	if now == nil {
		now = time.Now
	}
	once := func() {
		path, err := Take(ctx, o.Store, o.Dir, now())
		if err != nil {
			o.Logger.Error("backup failed", "dir", o.Dir, "error", err)
			return
		}
		removed, err := Prune(o.Dir, o.KeepDays, now())
		if err != nil {
			o.Logger.Error("removing old backups failed", "dir", o.Dir, "error", err)
		}
		o.Logger.Info("backup written", "path", path, "removed", removed)
	}
	if last := latest(o.Dir); last.IsZero() || now().Sub(last) >= fresh {
		once()
	}
	ticker := time.NewTicker(o.Every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			once()
		}
	}
}

// Describe is a one-line summary of the settings for the start log.
func Describe(o Options) string {
	if o.Dir == "" {
		return "off"
	}
	keep := "forever"
	if o.KeepDays > 0 {
		keep = fmt.Sprintf("%d days", o.KeepDays)
	}
	return fmt.Sprintf("%s every %s, kept %s", o.Dir, o.Every, keep)
}
