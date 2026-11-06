// Package config reads the service settings from BUGSPOT_* environment variables.
package config

import (
	"crypto"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/netip"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/svyatoslavratov/bugspot/internal/auth"
)

// Config is the whole service configuration.
type Config struct {
	Addr    string
	DataDir string
	// Project names the threads of this instance.
	Project string
	// Enabled false keeps the service up but answers every visitor that the widget is hidden.
	Enabled bool
	// Providers are identity provider names in the order they are tried.
	Providers []string
	Policy    auth.Policy
	// AllowedOrigins may call the API from another origin with credentials. Same-origin setups
	// (the service proxied under the app's domain) need none.
	AllowedOrigins []string

	ForwardURL     string
	ForwardCookies []string
	ForwardHeaders []string
	ForwardMap     auth.Mapping
	ForwardTTL     time.Duration
	ForwardTimeout time.Duration

	JWTSecret    []byte
	JWTPublicKey crypto.PublicKey
	JWTIssuer    string
	JWTAudience  string
	JWTMap       auth.Mapping

	HeaderMap      auth.Mapping
	TrustedProxies []netip.Prefix

	// KeyTTL is how long the access key cookie lives in the browser.
	KeyTTL time.Duration
	// CookieSecure is auto (secure behind HTTPS), true or false.
	CookieSecure string

	ScreenshotMaxBytes int64
	// RateRead and RateWrite are requests per minute per identity or address.
	RateRead, RateWrite int
	LogLevel            slog.Level

	// BackupDir turns on snapshots of the database: one at start, then every BackupEvery; those
	// older than BackupKeepDays (0: never) are removed. Put it outside the data volume.
	BackupDir      string
	BackupEvery    time.Duration
	BackupKeepDays int
}

var knownProviders = []string{auth.ProviderForward, auth.ProviderJWT, auth.ProviderHeader, auth.ProviderKey, auth.ProviderAnonymous}

type reader struct {
	getenv func(string) string
	errs   []error
}

func (r *reader) str(name, def string) string {
	if v := strings.TrimSpace(r.getenv("BUGSPOT_" + name)); v != "" {
		return v
	}
	return def
}

// secret reads NAME or the file named by NAME_FILE (Docker and Kubernetes secrets).
func (r *reader) secret(name string) string {
	if v := r.getenv("BUGSPOT_" + name); v != "" {
		return v
	}
	path := r.getenv("BUGSPOT_" + name + "_FILE")
	if path == "" {
		return ""
	}
	data, err := os.ReadFile(path) //nolint:gosec // the operator names the file
	if err != nil {
		r.errs = append(r.errs, fmt.Errorf("BUGSPOT_%s_FILE: %w", name, err))
		return ""
	}
	return strings.TrimSpace(string(data))
}

func (r *reader) list(name string) []string {
	return strings.FieldsFunc(r.str(name, ""), func(c rune) bool { return c == ',' || c == ' ' })
}

func (r *reader) boolean(name string, def bool) bool {
	v := r.str(name, strconv.FormatBool(def))
	b, err := strconv.ParseBool(v)
	if err != nil {
		r.errs = append(r.errs, fmt.Errorf("BUGSPOT_%s=%q: want true or false", name, v))
	}
	return b
}

func (r *reader) duration(name string, def time.Duration) time.Duration {
	v := r.str(name, def.String())
	d, err := time.ParseDuration(v)
	if err != nil || d < 0 {
		r.errs = append(r.errs, fmt.Errorf("BUGSPOT_%s=%q: want a duration such as 30s or 720h", name, v))
	}
	return d
}

func (r *reader) integer(name string, def int64) int64 {
	v := r.str(name, strconv.FormatInt(def, 10))
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n < 0 {
		r.errs = append(r.errs, fmt.Errorf("BUGSPOT_%s=%q: want a non-negative integer", name, v))
	}
	return n
}

func (r *reader) rules(name, def string) auth.Rules {
	rules, err := auth.ParseRules(r.str(name, def))
	if err != nil {
		r.errs = append(r.errs, fmt.Errorf("BUGSPOT_%s: %w", name, err))
	}
	return rules
}

func (r *reader) mapping(name string, def auth.Mapping) auth.Mapping {
	m, err := auth.ParseMapping(r.str(name, ""), def)
	if err != nil {
		r.errs = append(r.errs, fmt.Errorf("BUGSPOT_%s: %w", name, err))
	}
	return m
}

func parsePublicKey(v string) (crypto.PublicKey, error) {
	data := []byte(v)
	if !strings.Contains(v, "-----BEGIN") {
		var err error
		if data, err = os.ReadFile(v); err != nil { //nolint:gosec // the operator names the file
			return nil, err
		}
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, errors.New("no PEM block")
	}
	return x509.ParsePKIXPublicKey(block.Bytes)
}

// Load reads the configuration; getenv is os.Getenv outside tests.
func Load(getenv func(string) string) (Config, error) {
	r := &reader{getenv: getenv}
	c := Config{
		Addr:    r.str("ADDR", ":8090"),
		DataDir: r.str("DATA_DIR", "data"),
		Project: r.str("PROJECT", "default"),
		Enabled: r.boolean("ENABLED", true),
		Policy: auth.Policy{
			View:     r.rules("VIEW", "authenticated"),
			Comment:  r.rules("COMMENT", "authenticated"),
			Moderate: r.rules("MODERATE", ""),
		},
		Providers:      r.list("AUTH"),
		AllowedOrigins: r.list("ALLOWED_ORIGINS"),

		ForwardURL:     r.str("FORWARD_URL", ""),
		ForwardCookies: r.list("FORWARD_COOKIES"),
		ForwardHeaders: r.list("FORWARD_HEADERS"),
		ForwardMap:     r.mapping("FORWARD_MAP", auth.Mapping{ID: "id", Name: "name", Roles: "roles"}),
		ForwardTTL:     r.duration("FORWARD_CACHE", 30*time.Second),
		ForwardTimeout: r.duration("FORWARD_TIMEOUT", 3*time.Second),

		JWTSecret:   []byte(r.secret("JWT_SECRET")),
		JWTIssuer:   r.str("JWT_ISSUER", ""),
		JWTAudience: r.str("JWT_AUDIENCE", ""),
		JWTMap:      r.mapping("JWT_MAP", auth.Mapping{ID: "sub", Name: "name", Roles: "roles"}),

		HeaderMap: r.mapping("HEADER_MAP", auth.Mapping{ID: "X-Forwarded-User", Name: "X-Forwarded-Preferred-Username", Roles: "X-Forwarded-Groups"}),

		KeyTTL:             r.duration("KEY_TTL", 30*24*time.Hour),
		CookieSecure:       r.str("COOKIE_SECURE", "auto"),
		ScreenshotMaxBytes: r.integer("SCREENSHOT_MAX_BYTES", 3<<20),
		RateRead:           int(r.integer("RATE_READ", 600)),
		RateWrite:          int(r.integer("RATE_WRITE", 60)),

		BackupDir:   r.str("BACKUP_DIR", ""),
		BackupEvery: r.duration("BACKUP_EVERY", 24*time.Hour),
	}
	// Days fit an int only after a bound check (and a century is retention enough).
	if keep := r.integer("BACKUP_KEEP_DAYS", 14); keep >= 0 && keep <= 36500 {
		c.BackupKeepDays = int(keep)
	} else {
		r.errs = append(r.errs, fmt.Errorf("BUGSPOT_BACKUP_KEEP_DAYS=%d: from 0 to 36500", keep))
	}
	if pk := r.str("JWT_PUBLIC_KEY", ""); pk != "" {
		key, err := parsePublicKey(pk)
		if err != nil {
			r.errs = append(r.errs, fmt.Errorf("BUGSPOT_JWT_PUBLIC_KEY: %w", err))
		}
		c.JWTPublicKey = key
	}
	for _, p := range r.list("TRUSTED_PROXIES") {
		prefix, err := netip.ParsePrefix(p)
		if err != nil {
			addr, aerr := netip.ParseAddr(p)
			if aerr != nil {
				r.errs = append(r.errs, fmt.Errorf("BUGSPOT_TRUSTED_PROXIES: %q is neither an address nor a CIDR", p))
				continue
			}
			prefix = netip.PrefixFrom(addr, addr.BitLen())
		}
		c.TrustedProxies = append(c.TrustedProxies, prefix)
	}
	if err := c.LogLevel.UnmarshalText([]byte(r.str("LOG_LEVEL", "info"))); err != nil {
		r.errs = append(r.errs, fmt.Errorf("BUGSPOT_LOG_LEVEL: %w", err))
	}
	r.errs = append(r.errs, c.validate()...)
	return c, errors.Join(r.errs...)
}

func (c *Config) validate() []error {
	var errs []error
	seen := map[string]bool{}
	for _, p := range c.Providers {
		if !slices.Contains(knownProviders, p) {
			errs = append(errs, fmt.Errorf("BUGSPOT_AUTH: unknown provider %q (want %s)", p, strings.Join(knownProviders, ", ")))
		}
		if seen[p] {
			errs = append(errs, fmt.Errorf("BUGSPOT_AUTH: %q twice", p))
		}
		seen[p] = true
	}
	if seen[auth.ProviderForward] && c.ForwardURL == "" {
		errs = append(errs, errors.New("forward auth needs BUGSPOT_FORWARD_URL"))
	}
	if seen[auth.ProviderForward] && len(c.ForwardCookies)+len(c.ForwardHeaders) == 0 {
		errs = append(errs, errors.New("forward auth needs BUGSPOT_FORWARD_COOKIES or BUGSPOT_FORWARD_HEADERS"))
	}
	if seen[auth.ProviderJWT] {
		switch {
		case len(c.JWTSecret) == 0 && c.JWTPublicKey == nil:
			errs = append(errs, errors.New("jwt auth needs BUGSPOT_JWT_SECRET or BUGSPOT_JWT_PUBLIC_KEY"))
		case len(c.JWTSecret) > 0 && len(c.JWTSecret) < 32:
			errs = append(errs, errors.New("BUGSPOT_JWT_SECRET must be at least 32 bytes"))
		}
	}
	if seen[auth.ProviderHeader] && len(c.TrustedProxies) == 0 {
		errs = append(errs, errors.New("header auth needs BUGSPOT_TRUSTED_PROXIES: otherwise anyone can send the headers"))
	}
	if !slices.Contains([]string{"auto", "true", "false"}, c.CookieSecure) {
		errs = append(errs, fmt.Errorf("BUGSPOT_COOKIE_SECURE=%q: want auto, true or false", c.CookieSecure))
	}
	if c.BackupDir != "" && c.BackupEvery < time.Minute {
		errs = append(errs, fmt.Errorf("BUGSPOT_BACKUP_EVERY=%s: at least 1m", c.BackupEvery))
	}
	for _, o := range c.AllowedOrigins {
		if !strings.HasPrefix(o, "https://") && !strings.HasPrefix(o, "http://") || strings.HasSuffix(o, "/") {
			errs = append(errs, fmt.Errorf("BUGSPOT_ALLOWED_ORIGINS: %q must look like https://app.example.com", o))
		}
	}
	return errs
}

// Chain builds the identity providers; keys need the credential store.
func (c *Config) Chain(keys auth.Credentials, now func() time.Time) auth.Chain {
	var chain auth.Chain
	for _, name := range c.Providers {
		switch name {
		case auth.ProviderForward:
			chain = append(chain, &auth.Forward{URL: c.ForwardURL, Cookies: c.ForwardCookies, Headers: c.ForwardHeaders,
				Map: c.ForwardMap, TTL: c.ForwardTTL, Client: &http.Client{Timeout: c.ForwardTimeout}})
		case auth.ProviderJWT:
			chain = append(chain, &auth.JWT{Secret: c.JWTSecret, PublicKey: c.JWTPublicKey, Issuer: c.JWTIssuer,
				Audience: c.JWTAudience, Map: c.JWTMap, Leeway: 30 * time.Second})
		case auth.ProviderHeader:
			chain = append(chain, &auth.Header{Map: c.HeaderMap, Trusted: c.TrustedProxies})
		case auth.ProviderKey:
			chain = append(chain, &auth.Key{Store: keys, Now: now})
		case auth.ProviderAnonymous:
			chain = append(chain, auth.Anonymous{})
		}
	}
	return chain
}
