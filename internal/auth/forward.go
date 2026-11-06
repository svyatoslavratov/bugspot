package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Forward asks the host application who the user is: it calls the app's "who am I" endpoint
// with the user's own cookies (only the listed ones) and maps the JSON answer to an identity.
// It suits apps with a cookie session on the same domain: nothing changes in the app.
type Forward struct {
	URL     string
	Cookies []string
	// Headers are request headers passed through as well, such as Authorization.
	Headers []string
	Map     Mapping
	TTL     time.Duration
	Client  *http.Client

	mu    sync.Mutex
	cache map[string]forwardEntry
}

type forwardEntry struct {
	id      *Identity
	expires time.Time
}

// Name implements Provider.
func (f *Forward) Name() string { return ProviderForward }

func (f *Forward) credentials(r *http.Request) (cookies []*http.Cookie, headers http.Header) {
	for _, name := range f.Cookies {
		if c, err := r.Cookie(name); err == nil && c.Value != "" {
			cookies = append(cookies, &http.Cookie{Name: c.Name, Value: c.Value}) //nolint:gosec // sent upstream, not set in a browser
		}
	}
	headers = http.Header{}
	for _, name := range f.Headers {
		if v := r.Header.Get(name); v != "" {
			headers.Set(name, v)
		}
	}
	return cookies, headers
}

func cacheKey(cookies []*http.Cookie, headers http.Header) string {
	h := sha256.New()
	for _, c := range cookies {
		fmt.Fprintf(h, "c:%s=%s\n", c.Name, c.Value)
	}
	for name, values := range headers {
		fmt.Fprintf(h, "h:%s=%s\n", name, strings.Join(values, ","))
	}
	return hex.EncodeToString(h.Sum(nil))
}

// Identify implements Provider.
func (f *Forward) Identify(ctx context.Context, r *http.Request) (*Identity, error) {
	cookies, headers := f.credentials(r)
	if len(cookies) == 0 && len(headers) == 0 {
		return nil, nil
	}
	key := cacheKey(cookies, headers)
	now := time.Now()
	f.mu.Lock()
	if e, ok := f.cache[key]; ok && now.Before(e.expires) {
		f.mu.Unlock()
		return e.id.copy(), nil
	}
	f.mu.Unlock()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, f.URL, nil)
	if err != nil {
		return nil, err
	}
	req.Header = headers
	req.Header.Set("Accept", "application/json")
	for _, c := range cookies {
		req.AddCookie(c)
	}
	res, err := f.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("forward auth: %w", err)
	}
	defer func() { _ = res.Body.Close() }()
	var id *Identity
	switch {
	case res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden:
		// Not signed in: remembered like a success, so a stream of anonymous requests costs one call.
	case res.StatusCode >= 200 && res.StatusCode < 300:
		var doc any
		if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&doc); err != nil {
			return nil, fmt.Errorf("forward auth: decode: %w", err)
		}
		id = f.Map.fromDocument(doc)
	default:
		return nil, fmt.Errorf("forward auth: %s answered %d", f.URL, res.StatusCode)
	}
	f.mu.Lock()
	if f.cache == nil || len(f.cache) > 10_000 {
		f.cache = map[string]forwardEntry{}
	}
	f.cache[key] = forwardEntry{id: id, expires: now.Add(f.TTL)}
	f.mu.Unlock()
	return id.copy(), nil
}

func (i *Identity) copy() *Identity {
	if i == nil {
		return nil
	}
	c := *i
	c.Roles = append([]string(nil), i.Roles...)
	return &c
}
