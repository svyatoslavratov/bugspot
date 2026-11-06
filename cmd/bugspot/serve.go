package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/svyatoslavratov/bugspot/internal/auth"
	"github.com/svyatoslavratov/bugspot/internal/config"
	"github.com/svyatoslavratov/bugspot/internal/httpapi"
	"github.com/svyatoslavratov/bugspot/internal/store/sqlite"
	"github.com/svyatoslavratov/bugspot/internal/widgetfs"
)

func openStore(ctx context.Context, cfg config.Config) (*sqlite.Store, error) {
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		return nil, err
	}
	return sqlite.Open(ctx, filepath.Join(cfg.DataDir, "bugspot.db"))
}

func serve(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	_ = fs.Parse(args)
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return fmt.Errorf("configuration:\n%w", err)
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel}))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

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
		logger.Warn("no identity providers (BUGSPOT_AUTH): the widget stays hidden unless the policy is public")
	}
	api := httpapi.New(httpapi.Options{
		Project: cfg.Project, Enabled: cfg.Enabled, Store: st, Chain: chain, Keys: keys, Policy: cfg.Policy,
		AllowedOrigins: cfg.AllowedOrigins, TrustedProxies: cfg.TrustedProxies, CookieSecure: cfg.CookieSecure,
		KeyTTL: cfg.KeyTTL, ScreenshotMaxBytes: cfg.ScreenshotMaxBytes, RateRead: cfg.RateRead, RateWrite: cfg.RateWrite,
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
	errs := make(chan error, 1)
	go func() { errs <- srv.ListenAndServe() }()
	logger.Info("bugspot started", "addr", cfg.Addr, "version", version, "project", cfg.Project,
		"providers", cfg.Providers, "view", cfg.Policy.View.String(), "comment", cfg.Policy.Comment.String(),
		"moderate", cfg.Policy.Moderate.String())
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
func healthcheck(args []string) error {
	fs := flag.NewFlagSet("healthcheck", flag.ExitOnError)
	addr := fs.String("url", "", "health URL (default: http://127.0.0.1<BUGSPOT_ADDR>/healthz)")
	_ = fs.Parse(args)
	url := *addr
	if url == "" {
		listen := os.Getenv("BUGSPOT_ADDR")
		if listen == "" {
			listen = ":8090"
		}
		if listen[0] == ':' {
			listen = "127.0.0.1" + listen
		}
		url = "http://" + listen + "/healthz"
	}
	client := &http.Client{Timeout: 3 * time.Second}
	res, err := client.Get(url) //nolint:noctx,gosec // a one-shot probe of the configured local address
	if err != nil {
		return err
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("%s answered %d", url, res.StatusCode)
	}
	return nil
}
