// Package httpapi serves the widget files and the JSON API on one handler, so a single
// container (or binary) is the whole backend.
package httpapi

import (
	"io/fs"
	"log/slog"
	"net/http"
	"net/netip"
	"time"

	"github.com/svyatoslavratov/bugspot/internal/auth"
	"github.com/svyatoslavratov/bugspot/internal/ratelimit"
	"github.com/svyatoslavratov/bugspot/internal/store"
)

// Options configure a Server.
type Options struct {
	Project string
	Enabled bool
	Store   store.Store
	Chain   auth.Chain
	// Keys turns on access links (POST /api/v1/session/key); nil when the key provider is off.
	Keys           *auth.Key
	Policy         auth.Policy
	AllowedOrigins []string
	// TrustedProxies may set X-Forwarded-For and X-Forwarded-Proto.
	TrustedProxies     []netip.Prefix
	CookieSecure       string
	KeyTTL             time.Duration
	ScreenshotMaxBytes int64
	RateRead           int
	RateWrite          int
	// Widget holds widget.js and assets/; nil serves no widget.
	Widget  fs.FS
	Version string
	Logger  *slog.Logger
	Now     func() time.Time
}

// Server is the bugspot HTTP API.
type Server struct {
	o       Options
	origins map[string]bool
	read    *ratelimit.Limiter
	write   *ratelimit.Limiter
	widget  *widget
}

// Limits the API enforces; the session endpoint tells the widget about them.
const (
	maxBody       = 10_000
	maxRoute      = 2048
	maxAnchor     = 16 << 10
	maxContext    = 64 << 10
	maxJSONBody   = 128 << 10
	maxAuthorName = 80
)

// New builds a server.
func New(o Options) *Server {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Logger == nil {
		o.Logger = slog.New(slog.DiscardHandler)
	}
	s := &Server{
		o:       o,
		origins: map[string]bool{},
		read:    ratelimit.New(o.RateRead, o.Now),
		write:   ratelimit.New(o.RateWrite, o.Now),
	}
	for _, origin := range o.AllowedOrigins {
		s.origins[origin] = true
	}
	if o.Widget != nil {
		s.widget = newWidget(o.Widget)
	}
	return s
}

// Handler returns the routes wrapped in the common middleware.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", s.root)
	mux.HandleFunc("GET /healthz", s.healthz)
	mux.HandleFunc("GET /widget.js", s.serveLoader)
	mux.HandleFunc("GET /assets/{file}", s.serveAsset)

	mux.Handle("GET /api/v1/session", s.api(s.session, false))
	mux.Handle("POST /api/v1/session/key", s.api(s.openKey, true))
	mux.Handle("DELETE /api/v1/session/key", s.api(s.closeKey, true))

	mux.Handle("GET /api/v1/threads", s.api(s.listThreads, false))
	mux.Handle("POST /api/v1/threads", s.api(s.createThread, true))
	mux.Handle("GET /api/v1/threads/summary", s.api(s.summary, false))
	mux.Handle("GET /api/v1/threads/{id}", s.api(s.getThread, false))
	mux.Handle("PATCH /api/v1/threads/{id}", s.api(s.updateThread, true))
	mux.Handle("DELETE /api/v1/threads/{id}", s.api(s.deleteThread, true))
	mux.Handle("POST /api/v1/threads/{id}/replies", s.api(s.reply, true))
	mux.Handle("PUT /api/v1/threads/{id}/screenshot", s.api(s.putScreenshot, true))
	mux.Handle("GET /api/v1/threads/{id}/screenshot", s.api(s.getScreenshot, false))
	mux.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "no such API route")
	})
	return s.recover(s.log(s.securityHeaders(s.cors(mux))))
}

func (s *Server) root(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"name": "bugspot", "version": s.o.Version})
}

func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	if _, err := s.o.Store.Summary(r.Context(), s.o.Project, ""); err != nil {
		writeError(w, http.StatusServiceUnavailable, "unhealthy", "storage is unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
