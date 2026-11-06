package auth

import (
	"strings"
	"testing"
)

// FuzzParseRules: any input either fails to parse or round-trips through String.
func FuzzParseRules(f *testing.F) {
	for _, seed := range []string{"*", "authenticated anonymous", "role:admin,user:7", "provider:key", "role:", "admins", ",, ,"} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, s string) {
		rules, err := ParseRules(s)
		if err != nil {
			return
		}
		again, err := ParseRules(rules.String())
		if err != nil || again.String() != rules.String() {
			t.Fatalf("%q → %q → %q (%v)", s, rules.String(), again.String(), err)
		}
		_ = rules.Allows(nil)
		_ = rules.Allows(&Identity{ID: "x", Roles: []string{"admin"}, Provider: ProviderJWT})
	})
}

// FuzzMapping: parsing never panics, and a parsed mapping always has an id path.
func FuzzMapping(f *testing.F) {
	for _, seed := range []string{"id=employee.id,name=employee.name,roles=employee.role", "id=", "login=x", "id=a,,name=b", "="} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, s string) {
		m, err := ParseMapping(s, Mapping{})
		if err != nil {
			return
		}
		if m.ID == "" {
			t.Fatalf("%q parsed without an id", s)
		}
		doc := map[string]any{"a": map[string]any{"b": []any{"x", 1.0}}}
		_ = m.fromDocument(doc)
		_ = list(strings.Repeat("r,", 3))
	})
}
