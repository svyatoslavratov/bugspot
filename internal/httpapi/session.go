package httpapi

import (
	"net/http"

	"github.com/svyatoslavratov/bugspot/internal/auth"
	"github.com/svyatoslavratov/bugspot/internal/secret"
)

type sessionUser struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Provider string `json:"provider"`
}

type sessionLimits struct {
	ScreenshotMaxBytes int64 `json:"screenshotMaxBytes"`
	BodyMaxLength      int   `json:"bodyMaxLength"`
}

// sessionBody tells the loader whether to show the widget; hidden answers carry nothing else.
type sessionBody struct {
	Visible bool              `json:"visible"`
	Project string            `json:"project,omitempty"`
	User    *sessionUser      `json:"user,omitempty"`
	Can     *auth.Permissions `json:"can,omitempty"`
	Limits  *sessionLimits    `json:"limits,omitempty"`
}

func (s *Server) sessionOf(c caller) sessionBody {
	if !c.perms.View {
		return sessionBody{Visible: false}
	}
	perms := c.perms
	return sessionBody{
		Visible: true,
		Project: s.o.Project,
		User:    &sessionUser{ID: c.id.ID, Name: c.id.Name, Provider: c.id.Provider},
		Can:     &perms,
		Limits:  &sessionLimits{ScreenshotMaxBytes: s.o.ScreenshotMaxBytes, BodyMaxLength: maxBody},
	}
}

func (s *Server) session(w http.ResponseWriter, r *http.Request, c caller) error {
	// An anonymous visitor gets a random id on the first visit, so they can edit what they write.
	if c.id != nil && c.id.Provider == auth.ProviderAnonymous && c.id.ID == "" && c.perms.View {
		value := secret.ID()
		//nolint:gosec // Secure follows the request (BUGSPOT_COOKIE_SECURE); HttpOnly and SameSite are set
		http.SetCookie(w, &http.Cookie{Name: auth.AnonymousCookie, Value: value, Path: "/", MaxAge: 365 * 24 * 3600,
			HttpOnly: true, Secure: s.secure(r), SameSite: http.SameSiteLaxMode})
		c.id.ID = "anon:" + value
	}
	writeJSON(w, http.StatusOK, s.sessionOf(c))
	return nil
}

// openKey exchanges an access key from a link for an httpOnly cookie.
func (s *Server) openKey(w http.ResponseWriter, r *http.Request, _ caller) error {
	if s.o.Keys == nil {
		return errForbidden
	}
	var body struct {
		Key string `json:"key"`
	}
	if err := decode(r, &body); err != nil {
		return err
	}
	cred, ok, err := s.o.Keys.Lookup(r.Context(), body.Key)
	if err != nil {
		return err
	}
	if !ok {
		writeError(w, http.StatusUnauthorized, "invalid_key", "the access key is unknown, expired or revoked")
		return nil
	}
	maxAge := int(s.o.KeyTTL.Seconds())
	if cred.ExpiresAt != nil {
		maxAge = min(maxAge, int(cred.ExpiresAt.Sub(s.o.Now()).Seconds()))
	}
	//nolint:gosec // Secure follows the request (BUGSPOT_COOKIE_SECURE); HttpOnly and SameSite are set
	http.SetCookie(w, &http.Cookie{Name: auth.KeyCookie, Value: body.Key, Path: "/", MaxAge: maxAge,
		HttpOnly: true, Secure: s.secure(r), SameSite: http.SameSiteLaxMode})
	id := &auth.Identity{ID: "key:" + cred.ID, Name: cred.Name, Roles: cred.Roles, Provider: auth.ProviderKey}
	c := caller{id: id}
	if s.o.Enabled {
		c.perms = s.o.Policy.For(id)
	}
	writeJSON(w, http.StatusOK, s.sessionOf(c))
	return nil
}

func (s *Server) closeKey(w http.ResponseWriter, r *http.Request, _ caller) error {
	//nolint:gosec // an expiring cookie; Secure follows the request
	http.SetCookie(w, &http.Cookie{Name: auth.KeyCookie, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: s.secure(r), SameSite: http.SameSiteLaxMode})
	w.WriteHeader(http.StatusNoContent)
	return nil
}
