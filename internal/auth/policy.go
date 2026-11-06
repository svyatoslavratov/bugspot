package auth

import (
	"fmt"
	"strings"

	"github.com/svyatoslavratov/bugspot/internal/domain"
)

// Rule matches identities:
//
//   - everyone, including requests nobody recognized
//     authenticated    any identity except anonymous
//     anonymous        anonymous visitors
//     role:<name>      identities with the role
//     user:<id>        one identity
//     provider:<name>  identities from that provider (forward, jwt, header, key, anonymous)
type Rule struct {
	kind, value string
}

// Rules match when any rule matches; empty rules match nobody.
type Rules []Rule

// ParseRules reads a comma or space separated rule list.
func ParseRules(s string) (Rules, error) {
	var rules Rules
	for _, field := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ' ' }) {
		switch {
		case field == "*" || field == "authenticated" || field == "anonymous":
			rules = append(rules, Rule{kind: field})
		case strings.HasPrefix(field, "role:"), strings.HasPrefix(field, "user:"), strings.HasPrefix(field, "provider:"):
			kind, value, _ := strings.Cut(field, ":")
			if value == "" {
				return nil, fmt.Errorf("rule %q: empty %s", field, kind)
			}
			rules = append(rules, Rule{kind: kind, value: value})
		default:
			return nil, fmt.Errorf("unknown rule %q (want *, authenticated, anonymous, role:, user: or provider:)", field)
		}
	}
	return rules, nil
}

// String renders the rules back.
func (rs Rules) String() string {
	parts := make([]string, len(rs))
	for i, r := range rs {
		parts[i] = r.kind
		if r.value != "" {
			parts[i] += ":" + r.value
		}
	}
	return strings.Join(parts, ",")
}

// Allows reports whether id (nil for nobody) matches.
func (rs Rules) Allows(id *Identity) bool {
	for _, r := range rs {
		if r.matches(id) {
			return true
		}
	}
	return false
}

func (r Rule) matches(id *Identity) bool {
	switch r.kind {
	case "*":
		return true
	case "authenticated":
		return id.Authenticated()
	case "anonymous":
		return id != nil && id.Provider == ProviderAnonymous
	case "role":
		return id.HasRole(r.value)
	case "user":
		return id != nil && id.ID == r.value
	case "provider":
		return id != nil && id.Provider == r.value
	}
	return false
}

// Policy is who may see the widget and threads, who may write and who may moderate.
type Policy struct {
	View, Comment, Moderate Rules
}

// Permissions are what one identity may do.
type Permissions struct {
	// View: see the widget, read threads and screenshots.
	View bool `json:"view"`
	// Comment: create threads, reply, edit and delete one's own threads, resolve them.
	Comment bool `json:"comment"`
	// Moderate: change the status of any thread, delete any thread.
	Moderate bool `json:"moderate"`
	// Reply: answer in threads; people get it with Comment, agents with the reply scope.
	Reply bool `json:"reply"`
}

// For returns the permissions of id. Writing needs viewing; agents get theirs from scopes.
func (p Policy) For(id *Identity) Permissions {
	if id != nil && id.Provider == ProviderAgent {
		view := id.HasScope(domain.ScopeRead)
		return Permissions{View: view, Reply: view && id.HasScope(domain.ScopeReply)}
	}
	view := p.View.Allows(id) || p.Moderate.Allows(id)
	comment := view && (p.Comment.Allows(id) || p.Moderate.Allows(id))
	return Permissions{View: view, Comment: comment, Reply: comment, Moderate: view && p.Moderate.Allows(id)}
}
