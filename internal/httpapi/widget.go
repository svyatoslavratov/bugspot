package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
)

// widget serves the loader (short cache, revalidated by ETag) and hashed assets (cached forever).
type widget struct {
	files  fs.FS
	loader []byte
	etag   string
}

func newWidget(files fs.FS) *widget {
	w := &widget{files: files}
	if data, err := fs.ReadFile(files, "widget.js"); err == nil {
		sum := sha256.Sum256(data)
		w.loader, w.etag = data, `"`+hex.EncodeToString(sum[:8])+`"`
	}
	return w
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
	_, _ = w.Write(data) //nolint:gosec // files embedded at build time, not user input
}
