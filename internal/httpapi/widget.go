package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strings"
)

// widget serves the loader (short cache, revalidated by ETag), the screen map page and hashed
// assets (cached forever).
type widget struct {
	files  fs.FS
	loader []byte
	etag   string
	mapper []byte
}

func newWidget(files fs.FS) *widget {
	w := &widget{files: files}
	if data, err := fs.ReadFile(files, "widget.js"); err == nil {
		sum := sha256.Sum256(data)
		w.loader, w.etag = data, `"`+hex.EncodeToString(sum[:8])+`"`
	}
	if data, err := fs.ReadFile(files, "map.html"); err == nil {
		w.mapper = data
	}
	return w
}

// mapCSP lets the map page load its own scripts, render DOM snapshots of the app in sandboxed
// frames (their stylesheets are inline, images and fonts come from wherever the app had them) and
// show the live app in a frame: the app's origins are the allowed ones.
func mapCSP(origins []string) string {
	frames := []string{"'self'"}
	for _, o := range origins {
		if u, err := url.Parse(o); err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Host != "" &&
			!strings.ContainsAny(o, " ;,'\"") {
			frames = append(frames, u.Scheme+"://"+u.Host)
		}
	}
	return "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https: http:; " +
		"img-src 'self' https: http: data: blob:; font-src 'self' https: http: data:; " +
		// Screenshots of a snapshot embed its images and fonts: they are fetched from where the app has them.
		"connect-src 'self' https: http: data: blob:; frame-src " + strings.Join(frames, " ") + "; " +
		"frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'"
}

// serveMap serves the screen map page; it reads the session and the map through the API itself.
func (s *Server) serveMap(w http.ResponseWriter, _ *http.Request) {
	if s.widget == nil || s.widget.mapper == nil {
		writeError(w, http.StatusNotFound, "no_widget", "this build has no map page: build the widget with make widget")
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	h.Set("Content-Security-Policy", s.mapPolicy)
	h.Set("Cross-Origin-Resource-Policy", "same-origin")
	_, _ = w.Write(s.widget.mapper)
}

func (s *Server) serveLoader(w http.ResponseWriter, r *http.Request) {
	if s.widget == nil || s.widget.loader == nil {
		writeError(w, http.StatusNotFound, "no_widget", "this build has no widget: build it with make widget")
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/javascript; charset=utf-8")
	h.Set("Cache-Control", "public, max-age=300, must-revalidate")
	h.Set("ETag", s.widget.etag)
	if r.Header.Get("If-None-Match") == s.widget.etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	_, _ = w.Write(s.widget.loader)
}

func (s *Server) serveAsset(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("file")
	if s.widget == nil || name == "" || strings.Contains(name, "..") || strings.ContainsAny(name, `/\`) {
		writeError(w, http.StatusNotFound, "not_found", "not found")
		return
	}
	data, err := fs.ReadFile(s.widget.files, path.Join("assets", name))
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "not found")
		return
	}
	contentType := mime.TypeByExtension(path.Ext(name))
	if path.Ext(name) == ".js" {
		contentType = "text/javascript; charset=utf-8"
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	h := w.Header()
	h.Set("Content-Type", contentType)
	h.Set("Cache-Control", "public, max-age=31536000, immutable")
	// The loader imports the app as a module: from another origin (the service on its own port or
	// domain) a module needs CORS. The files are public and the same for everyone.
	h.Set("Access-Control-Allow-Origin", "*")
	_, _ = w.Write(data) //nolint:gosec // files embedded at build time, not user input
}
