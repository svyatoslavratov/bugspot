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
		len(c.Policy.Moderate) != 0 || c.ScreenshotMaxBytes != 3<<20 || c.KeyTTL != 30*24*time.Hour ||
		c.BackupDir != "" || c.BackupEvery != 24*time.Hour || c.BackupKeepDays != 14 {
		t.Fatalf("defaults = %+v", c)
	}
}

func TestForwardSetup(t *testing.T) {
	c, err := Load(env(map[string]string{
		"PINPATH_AUTH":            "forward,key",
		"PINPATH_FORWARD_URL":     "http://app:8080/api/me",
		"PINPATH_FORWARD_COOKIES": "session",
		"PINPATH_FORWARD_MAP":     "id=employee.id,name=employee.name,roles=employee.role",
		"PINPATH_MODERATE":        "role:superadmin",
		"PINPATH_TRUSTED_PROXIES": "10.0.0.0/8, 127.0.0.1",
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
		"PINPATH_AUTH":             "forward,jwt,header,ldap",
		"PINPATH_JWT_SECRET":       "short",
		"PINPATH_VIEW":             "admins",
		"PINPATH_FORWARD_CACHE":    "soon",
		"PINPATH_ALLOWED_ORIGINS":  "app.example.com",
		"PINPATH_COOKIE_SECURE":    "maybe",
		"PINPATH_BACKUP_DIR":       "/backups",
		"PINPATH_BACKUP_EVERY":     "5s",
		"PINPATH_BACKUP_KEEP_DAYS": "-1",
	}))
	if err == nil {
		t.Fatal("no error")
	}
	for _, want := range []string{"unknown provider \"ldap\"", "PINPATH_FORWARD_URL", "32 bytes", "TRUSTED_PROXIES",
		"PINPATH_VIEW", "FORWARD_CACHE", "ALLOWED_ORIGINS", "COOKIE_SECURE", "BACKUP_EVERY", "BACKUP_KEEP_DAYS"} {
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
	c, err := Load(env(map[string]string{"PINPATH_AUTH": "jwt", "PINPATH_JWT_SECRET_FILE": path}))
	if err != nil || string(c.JWTSecret) != "0123456789abcdef0123456789abcdef" {
		t.Fatalf("secret from file = %q, %v", c.JWTSecret, err)
	}
}

// Variables named before the project was renamed from bugspot still work; the new names win and
// the old ones in use are listed for a warning.
func TestLegacyNames(t *testing.T) {
	c, err := Load(env(map[string]string{
		"BUGSPOT_MODERATE":    "role:admin",
		"BUGSPOT_PROJECT":     "old",
		"PINPATH_PROJECT":     "new",
		"BUGSPOT_BACKUP_DIR":  "/backups",
		"PINPATH_FORWARD_URL": "",
		"BUGSPOT_MAP_COLLECT": "role:scout",
		"BUGSPOT_JWT_SECRET":  "0123456789abcdef0123456789abcdef",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.Project != "new" || c.Policy.Moderate.String() != "role:admin" || c.Policy.Map.String() != "role:admin" ||
		c.Policy.Collect.String() != "role:scout" || c.BackupDir != "/backups" || string(c.JWTSecret) != "0123456789abcdef0123456789abcdef" {
		t.Fatalf("config = %+v", c)
	}
	want := "BUGSPOT_BACKUP_DIR BUGSPOT_JWT_SECRET BUGSPOT_MAP_COLLECT BUGSPOT_MODERATE"
	if got := strings.Join(c.Legacy, " "); got != want {
		t.Fatalf("legacy = %s", got)
	}
	if fresh, _ := Load(env(map[string]string{"PINPATH_MODERATE": "role:admin"})); len(fresh.Legacy) != 0 {
		t.Fatalf("legacy without old names = %v", fresh.Legacy)
	}
}
