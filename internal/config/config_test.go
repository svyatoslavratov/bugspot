package config

import (
	"strings"
	"testing"
	"time"
)

func env(vars map[string]string) func(string) string {
	return func(k string) string { return vars[k] }
}

func TestDefaults(t *testing.T) {
	c, err := Load(env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if c.Addr != ":8090" || !c.Enabled || len(c.Providers) != 0 || c.Policy.View.String() != "authenticated" ||
		len(c.Policy.Moderate) != 0 || c.ScreenshotMaxBytes != 3<<20 || c.KeyTTL != 30*24*time.Hour {
		t.Fatalf("defaults = %+v", c)
	}
}

func TestForwardSetup(t *testing.T) {
	c, err := Load(env(map[string]string{
		"BUGSPOT_AUTH":            "forward,key",
		"BUGSPOT_FORWARD_URL":     "http://app:8080/api/me",
		"BUGSPOT_FORWARD_COOKIES": "session",
		"BUGSPOT_FORWARD_MAP":     "id=employee.id,name=employee.name,roles=employee.role",
		"BUGSPOT_MODERATE":        "role:superadmin",
		"BUGSPOT_TRUSTED_PROXIES": "10.0.0.0/8, 127.0.0.1",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.ForwardMap.Roles != "employee.role" || len(c.TrustedProxies) != 2 || c.TrustedProxies[1].Bits() != 32 {
		t.Fatalf("config = %+v", c)
	}
	if chain := c.Chain(nil, time.Now); len(chain) != 2 || chain[0].Name() != "forward" || chain[1].Name() != "key" {
		t.Fatalf("chain = %v", chain)
	}
}

func TestErrors(t *testing.T) {
	_, err := Load(env(map[string]string{
		"BUGSPOT_AUTH":            "forward,jwt,header,ldap",
		"BUGSPOT_JWT_SECRET":      "short",
		"BUGSPOT_VIEW":            "admins",
		"BUGSPOT_FORWARD_CACHE":   "soon",
		"BUGSPOT_ALLOWED_ORIGINS": "app.example.com",
		"BUGSPOT_COOKIE_SECURE":   "maybe",
	}))
	if err == nil {
		t.Fatal("no error")
	}
	for _, want := range []string{"unknown provider \"ldap\"", "BUGSPOT_FORWARD_URL", "32 bytes", "TRUSTED_PROXIES",
		"BUGSPOT_VIEW", "FORWARD_CACHE", "ALLOWED_ORIGINS", "COOKIE_SECURE"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error does not mention %q:\n%v", want, err)
		}
	}
}

func TestSecretFile(t *testing.T) {
	path := t.TempDir() + "/secret"
	if err := writeFile(path, "0123456789abcdef0123456789abcdef\n"); err != nil {
		t.Fatal(err)
	}
	c, err := Load(env(map[string]string{"BUGSPOT_AUTH": "jwt", "BUGSPOT_JWT_SECRET_FILE": path}))
	if err != nil || string(c.JWTSecret) != "0123456789abcdef0123456789abcdef" {
		t.Fatalf("secret from file = %q, %v", c.JWTSecret, err)
	}
}
