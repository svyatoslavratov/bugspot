package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/svyatoslavratov/bugspot/internal/auth"
	"github.com/svyatoslavratov/bugspot/internal/domain"
	"github.com/svyatoslavratov/bugspot/internal/secret"
	"github.com/svyatoslavratov/bugspot/internal/store"
)

// allowed is what the caller may do with one thread; the widget shows only these actions.
type allowed struct {
	Edit   bool `json:"edit"`
	Delete bool `json:"delete"`
	Reply  bool `json:"reply"`
	// Verify: tick or untick "checked by a person"; people who may comment, never agents.
	Verify   bool            `json:"verify"`
	Statuses []domain.Status `json:"statuses"`
}

// canVerify: a person who may comment confirms the result; an agent cannot vouch for its own fix.
func canVerify(c caller) bool {
	return c.perms.Comment && c.id != nil && c.id.ID != "" && c.id.Provider != auth.ProviderAgent
}

type threadView struct {
	domain.Thread
	Allowed allowed `json:"allowed"`
}

type threadDetail struct {
	threadView
	Replies []domain.Reply `json:"replies"`
}

type pageMeta struct {
	Page  int `json:"page"`
	Limit int `json:"limit"`
	Total int `json:"total"`
}

func isAuthor(c caller, t domain.Thread) bool {
	return c.id != nil && c.id.ID != "" && t.Author.Kind == domain.AuthorUser && t.Author.ID == c.id.ID
}

// statusesFor lists the statuses the caller may move the thread to:
//   - moderators: any;
//   - agents with the status scope: open, in_progress, fixed, wontfix — closing is for people;
//   - the author: resolve or reopen their own thread.
func statusesFor(c caller, t domain.Thread) []domain.Status {
	var candidates []domain.Status
	switch {
	case c.perms.Moderate:
		candidates = domain.Statuses
	case c.id.HasScope(domain.ScopeStatus) && c.perms.View:
		candidates = []domain.Status{domain.StatusOpen, domain.StatusInProgress, domain.StatusFixed, domain.StatusWontfix}
	case c.perms.Comment && isAuthor(c, t):
		candidates = []domain.Status{domain.StatusOpen, domain.StatusResolved}
	}
	out := []domain.Status{}
	for _, st := range candidates {
		if st != t.Status {
			out = append(out, st)
		}
	}
	return out
}

func (s *Server) view(c caller, t domain.Thread) threadView {
	own := c.perms.Comment && isAuthor(c, t)
	return threadView{Thread: t, Allowed: allowed{
		Edit:     own,
		Delete:   own || c.perms.Moderate,
		Reply:    c.perms.Reply,
		Verify:   canVerify(c),
		Statuses: statusesFor(c, t),
	}}
}

// threadID turns the {id} path value into a thread id: a number (12 or #12 escaped as %2312) is
// looked up, anything else is taken as the id.
func (s *Server) threadID(r *http.Request) (string, error) {
	raw := strings.TrimPrefix(r.PathValue("id"), "#")
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return raw, nil
	}
	list, _, err := s.o.Store.ListThreads(r.Context(), domain.ThreadFilter{Project: s.o.Project, Number: n, Limit: 1})
	if err != nil {
		return "", err
	}
	if len(list) == 0 {
		return "", domain.ErrNotFound
	}
	return list[0].ID, nil
}

func (s *Server) listThreads(w http.ResponseWriter, r *http.Request, c caller) error {
	if !c.perms.View {
		return errForbidden
	}
	q := r.URL.Query()
	f := domain.ThreadFilter{Project: s.o.Project, Route: q.Get("route"), Screen: q.Get("screen"),
		Kind: domain.Kind(q.Get("kind")), Query: strings.TrimSpace(q.Get("q"))}
	for _, st := range strings.Split(q.Get("status"), ",") {
		if st == "" {
			continue
		}
		if !domain.Status(st).Valid() {
			return badRequest("unknown status %q", st)
		}
		f.Statuses = append(f.Statuses, domain.Status(st))
	}
	if f.Kind != "" && !f.Kind.Valid() {
		return badRequest("unknown kind %q", f.Kind)
	}
	f.Page, _ = strconv.Atoi(q.Get("page"))
	f.Limit, _ = strconv.Atoi(q.Get("limit"))
	threads, total, err := s.o.Store.ListThreads(r.Context(), f)
	if err != nil {
		return err
	}
	views := make([]threadView, len(threads))
	for i, t := range threads {
		views[i] = s.view(c, t)
	}
	page, limit := store.Page(f)
	writeJSON(w, http.StatusOK, map[string]any{"data": views, "meta": pageMeta{Page: page, Limit: limit, Total: total}})
	return nil
}

func (s *Server) summary(w http.ResponseWriter, r *http.Request, c caller) error {
	if !c.perms.View {
		return errForbidden
	}
	q := r.URL.Query()
	sum, err := s.o.Store.Summary(r.Context(), s.o.Project, q.Get("route"), q.Get("screen"))
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, sum)
	return nil
}

type threadInput struct {
	Route string `json:"route"`
	// Screen is the screen of the map the thread belongs to; by default the route with ids folded.
	Screen     string          `json:"screen"`
	URL        string          `json:"url"`
	Title      string          `json:"title"`
	Kind       domain.Kind     `json:"kind"`
	Body       string          `json:"body"`
	Anchor     json.RawMessage `json:"anchor"`
	Context    json.RawMessage `json:"context"`
	AuthorName string          `json:"authorName"`
}

func checkText(field, v string, limit int, required bool) (string, error) {
	v = strings.TrimSpace(v)
	switch {
	case required && v == "":
		return "", badRequest("%s is required", field)
	case !utf8.ValidString(v):
		return "", badRequest("%s is not valid UTF-8", field)
	case utf8.RuneCountInString(v) > limit:
		return "", badRequest("%s is longer than %d characters", field, limit)
	}
	return v, nil
}

func checkObject(field string, v json.RawMessage, limit int) (json.RawMessage, error) {
	if len(v) == 0 {
		return json.RawMessage("{}"), nil
	}
	if len(v) > limit {
		return nil, badRequest("%s is larger than %d bytes", field, limit)
	}
	var obj map[string]any
	if err := json.Unmarshal(v, &obj); err != nil || obj == nil {
		return nil, badRequest("%s must be a JSON object", field)
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, v); err != nil {
		return nil, badRequest("%s: %v", field, err)
	}
	return compact.Bytes(), nil
}

func (in *threadInput) check() error {
	var err error
	if in.Body, err = checkText("body", in.Body, maxBody, true); err != nil {
		return err
	}
	if in.Route, err = checkText("route", in.Route, maxRoute, true); err != nil {
		return err
	}
	if !strings.HasPrefix(in.Route, "/") {
		return badRequest("route must start with /")
	}
	if in.Screen, err = checkText("screen", in.Screen, maxScreenKey, false); err != nil {
		return err
	}
	if in.Screen == "" {
		in.Screen = domain.ScreenKey(in.Route)
	}
	if in.URL, err = checkText("url", in.URL, maxRoute, true); err != nil {
		return err
	}
	if u, perr := url.Parse(in.URL); perr != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return badRequest("url must be an http(s) address")
	}
	if in.Title, err = checkText("title", in.Title, 300, false); err != nil {
		return err
	}
	if in.AuthorName, err = checkText("authorName", in.AuthorName, maxAuthorName, false); err != nil {
		return err
	}
	if in.Kind == "" {
		in.Kind = domain.KindIssue
	}
	if !in.Kind.Valid() {
		return badRequest("unknown kind %q", in.Kind)
	}
	if in.Anchor, err = checkObject("anchor", in.Anchor, maxAnchor); err != nil {
		return err
	}
	in.Context, err = checkObject("context", in.Context, maxContext)
	return err
}

func (s *Server) createThread(w http.ResponseWriter, r *http.Request, c caller) error {
	if !c.perms.Comment || c.id == nil || c.id.ID == "" {
		return errForbidden
	}
	var in threadInput
	if err := decode(r, &in); err != nil {
		return err
	}
	if err := in.check(); err != nil {
		return err
	}
	author := c.author()
	if c.id.Provider == auth.ProviderAnonymous {
		author.Name = "Guest"
		if in.AuthorName != "" {
			author.Name = in.AuthorName
		}
	}
	now := s.o.Now().UTC()
	t := domain.Thread{
		ID: secret.ID(), Project: s.o.Project, Route: in.Route, Screen: in.Screen, URL: in.URL, Title: in.Title,
		Kind: in.Kind, Status: domain.StatusOpen, Body: in.Body, Anchor: in.Anchor, Context: in.Context,
		Author: author, CreatedAt: now, UpdatedAt: now,
	}
	if err := s.o.Store.CreateThread(r.Context(), &t); err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, s.view(c, t))
	return nil
}

func (s *Server) getThread(w http.ResponseWriter, r *http.Request, c caller) error {
	if !c.perms.View {
		return errForbidden
	}
	id, err := s.threadID(r)
	if err != nil {
		return err
	}
	t, err := s.o.Store.GetThread(r.Context(), s.o.Project, id)
	if err != nil {
		return err
	}
	replies, err := s.o.Store.Replies(r.Context(), s.o.Project, t.ID)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, threadDetail{threadView: s.view(c, t), Replies: replies})
	return nil
}

type threadPatch struct {
	Status   *domain.Status `json:"status"`
	Body     *string        `json:"body"`
	Kind     *domain.Kind   `json:"kind"`
	Verified *bool          `json:"verified"`
}

func (s *Server) updateThread(w http.ResponseWriter, r *http.Request, c caller) error {
	if !c.perms.View {
		return errForbidden
	}
	id, err := s.threadID(r)
	if err != nil {
		return err
	}
	var p threadPatch
	if err := decode(r, &p); err != nil {
		return err
	}
	if p.Status == nil && p.Body == nil && p.Kind == nil && p.Verified == nil {
		return badRequest("nothing to change")
	}
	now := s.o.Now().UTC()
	t, err := s.o.Store.UpdateThread(r.Context(), s.o.Project, id, func(t *domain.Thread) error {
		if p.Body != nil || p.Kind != nil {
			if !c.perms.Comment || !isAuthor(c, *t) {
				return errForbidden
			}
			if p.Body != nil {
				body, err := checkText("body", *p.Body, maxBody, true)
				if err != nil {
					return err
				}
				t.Body = body
			}
			if p.Kind != nil {
				if !p.Kind.Valid() {
					return badRequest("unknown kind %q", *p.Kind)
				}
				t.Kind = *p.Kind
			}
		}
		if p.Status != nil && *p.Status != t.Status {
			if !p.Status.Valid() {
				return badRequest("unknown status %q", *p.Status)
			}
			if !slices.Contains(statusesFor(c, *t), *p.Status) {
				return errForbidden
			}
			by := c.author()
			t.Status, t.StatusBy, t.StatusAt = *p.Status, &by, &now
			// A reopened thread needs a new check.
			if *p.Status == domain.StatusOpen {
				t.Verified, t.VerifiedBy, t.VerifiedAt = false, nil, nil
			}
		}
		if p.Verified != nil && *p.Verified != t.Verified {
			if !canVerify(c) {
				return errForbidden
			}
			t.Verified, t.VerifiedBy, t.VerifiedAt = false, nil, nil
			if *p.Verified {
				by := c.author()
				t.Verified, t.VerifiedBy, t.VerifiedAt = true, &by, &now
			}
		}
		t.UpdatedAt = now
		return nil
	})
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, s.view(c, t))
	return nil
}

func (s *Server) deleteThread(w http.ResponseWriter, r *http.Request, c caller) error {
	if !c.perms.View {
		return errForbidden
	}
	id, err := s.threadID(r)
	if err != nil {
		return err
	}
	t, err := s.o.Store.GetThread(r.Context(), s.o.Project, id)
	if err != nil {
		return err
	}
	if !s.view(c, t).Allowed.Delete {
		return errForbidden
	}
	if err := s.o.Store.DeleteThread(r.Context(), s.o.Project, t.ID, s.o.Now().UTC()); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) reply(w http.ResponseWriter, r *http.Request, c caller) error {
	if !c.perms.Reply || c.id == nil || c.id.ID == "" {
		return errForbidden
	}
	id, err := s.threadID(r)
	if err != nil {
		return err
	}
	var in struct {
		Body string `json:"body"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	body, err := checkText("body", in.Body, maxBody, true)
	if err != nil {
		return err
	}
	reply := domain.Reply{ID: secret.ID(), ThreadID: id, Body: body, Author: c.author(), CreatedAt: s.o.Now().UTC()}
	if err := s.o.Store.AddReply(r.Context(), s.o.Project, &reply); err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, reply)
	return nil
}

// imageType sniffs PNG, JPEG and WebP; anything else is refused whatever the client claims.
func imageType(data []byte) string {
	switch {
	case bytes.HasPrefix(data, []byte("\x89PNG\r\n\x1a\n")):
		return "image/png"
	case bytes.HasPrefix(data, []byte{0xff, 0xd8, 0xff}):
		return "image/jpeg"
	case len(data) > 12 && bytes.Equal(data[0:4], []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WEBP")):
		return "image/webp"
	}
	return ""
}

func (s *Server) putScreenshot(w http.ResponseWriter, r *http.Request, c caller) error {
	if !c.perms.Comment {
		return errForbidden
	}
	id, err := s.threadID(r)
	if err != nil {
		return err
	}
	t, err := s.o.Store.GetThread(r.Context(), s.o.Project, id)
	if err != nil {
		return err
	}
	if !isAuthor(c, t) && !c.perms.Moderate {
		return errForbidden
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, s.o.ScreenshotMaxBytes))
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return errTooLarge
	}
	if err != nil {
		return err
	}
	contentType := imageType(data)
	if contentType == "" {
		return badRequest("the screenshot must be a PNG, JPEG or WebP image")
	}
	if err := s.o.Store.PutScreenshot(r.Context(), s.o.Project, t.ID, contentType, data); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) getScreenshot(w http.ResponseWriter, r *http.Request, c caller) error {
	if !c.perms.View {
		return errForbidden
	}
	id, err := s.threadID(r)
	if err != nil {
		return err
	}
	contentType, data, err := s.o.Store.Screenshot(r.Context(), s.o.Project, id)
	if err != nil {
		return err
	}
	h := w.Header()
	h.Set("Content-Type", contentType)
	h.Set("Content-Length", strconv.Itoa(len(data)))
	h.Set("Content-Disposition", "inline")
	h.Set("Cache-Control", "private, max-age=300")
	_, _ = w.Write(data) //nolint:gosec // a sniffed PNG/JPEG/WebP served with its own type and nosniff, not HTML
	return nil
}
