package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/svyatoslavratov/pinpath/internal/auth"
	"github.com/svyatoslavratov/pinpath/internal/backup"
	"github.com/svyatoslavratov/pinpath/internal/config"
	"github.com/svyatoslavratov/pinpath/internal/httpapi"
	"github.com/svyatoslavratov/pinpath/internal/store/sqlite"
	"github.com/svyatoslavratov/pinpath/internal/widgetfs"
)

func openStore(ctx context.Context, cfg config.Config) (*sqlite.Store, error) {
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		return nil, err
	}
	return sqlite.Open(ctx, databasePath(cfg.DataDir))
}

// databasePath is pinpath.db in the data directory; a directory that has only the bugspot.db of
// the time before the rename keeps using it, so an update loses nothing.
func databasePath(dir string) string {
	current := filepath.Join(dir, "pinpath.db")
	legacy := filepath.Join(dir, "bugspot.db")
	if _, err := os.Stat(current); err == nil {
		return current
	}
	if _, err := os.Stat(legacy); err == nil {
		return legacy
	}
	return current
}

func (a *app) serve(args []string) error {
	fs := a.flags("serve")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg, err := config.Load(a.getenv)
	if err != nil {
		return fmt.Errorf("configuration:\n%w", err)
	}
	logger := slog.New(slog.NewJSONHandler(a.stdout, &slog.HandlerOptions{Level: cfg.LogLevel}))
	ctx := a.ctx

	st, err := openStore(ctx, cfg)
	if err != nil {
		return err
	}
	defer func() { _ = st.Close() }()
	var keys *auth.Key
	chain := cfg.Chain(st, time.Now)
	for _, p := range chain {
		if k, ok := p.(*auth.Key); ok {
			keys = k
		}
	}
	if len(chain) == 0 {
		logger.Warn("no identity providers (PINPATH_AUTH): the widget stays hidden unless the policy is public")
	}
	api := httpapi.New(httpapi.Options{
		Project: cfg.Project, Enabled: cfg.Enabled, Store: st, Chain: chain, Keys: keys, Policy: cfg.Policy,
		AllowedOrigins: cfg.AllowedOrigins, TrustedProxies: cfg.TrustedProxies, CookieSecure: cfg.CookieSecure,
		KeyTTL: cfg.KeyTTL, ScreenshotMaxBytes: cfg.ScreenshotMaxBytes, MapMask: cfg.MapMask, RateRead: cfg.RateRead, RateWrite: cfg.RateWrite,
		Widget: widgetfs.FS(), Version: version, Logger: logger,
	})
	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           api.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    32 << 10,
	}
	backups := backup.Options{Dir: cfg.BackupDir, Every: cfg.BackupEvery, KeepDays: cfg.BackupKeepDays, Store: st, Logger: logger}
	errs := make(chan error, 1)
	go func() { errs <- srv.ListenAndServe() }()
	if len(cfg.Legacy) > 0 {
		logger.Warn("old variable names: the project is pinpath now, rename them to PINPATH_*", "variables", cfg.Legacy)
	}
	logger.Info("pinpath started", "addr", cfg.Addr, "version", version, "project", cfg.Project,
		"providers", cfg.Providers, "view", cfg.Policy.View.String(), "comment", cfg.Policy.Comment.String(),
		"moderate", cfg.Policy.Moderate.String(), "map", cfg.Policy.Map.String(), "map_collect", cfg.Policy.Collect.String(),
		"map_mask", cfg.MapMask, "backups", backup.Describe(backups))
	if cfg.BackupDir != "" {
		go backup.Run(ctx, backups)
	}
	select {
	case err := <-errs:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		logger.Info("shutting down")
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return srv.Shutdown(shutdown)
	}
	return nil
}

// healthcheck lets a distroless container (no curl) check itself.
func (a *app) healthcheck(args []string) error {
	fs := a.flags("healthcheck")
	addr := fs.String("url", "", "health URL (default: http://127.0.0.1<PINPATH_ADDR>/healthz)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	url := *addr
	if url == "" {
		listen := a.env("PINPATH_ADDR")
		if listen == "" {
			listen = ":8090"
		}
		if listen[0] == ':' {
			listen = "127.0.0.1" + listen
		}
		url = "http://" + listen + "/healthz"
	}
	client := &http.Client{Timeout: 3 * time.Second}
	res, err := client.Get(url) //nolint:noctx // a one-shot probe of the configured local address
	if err != nil {
		return err
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("%s answered %d", url, res.StatusCode)
	}
	return nil
}
