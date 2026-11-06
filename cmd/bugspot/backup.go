package main

import (
	"fmt"
	"path/filepath"
	"time"

	"github.com/svyatoslavratov/bugspot/internal/backup"
	"github.com/svyatoslavratov/bugspot/internal/config"
)

// backup writes one snapshot of the database; it works while the service runs.
func (a *app) backup(args []string) error {
	fs := a.flags("backup")
	out := fs.String("o", "", "file to write (default: a dated file in BUGSPOT_BACKUP_DIR, else in the current directory)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg, err := config.Load(a.getenv)
	if err != nil {
		return fmt.Errorf("configuration:\n%w", err)
	}
	st, err := openStore(a.ctx, cfg)
	if err != nil {
		return err
	}
	defer func() { _ = st.Close() }()
	path := *out
	if path == "" {
		dir := cfg.BackupDir
		if dir == "" {
			dir = "."
		}
		if path, err = backup.Take(a.ctx, st, dir, time.Now()); err != nil {
			return err
		}
	} else if err := st.Backup(a.ctx, filepath.Clean(path)); err != nil {
		return err
	}
	fmt.Fprintln(a.stdout, path)
	return nil
}
