package auth

import (
	"fmt"
	"strings"
)

// Mapping says where the id, the name and the roles are in a JSON document (dot paths such as
// employee.id) or in headers (header names).
type Mapping struct {
	ID, Name, Roles string
}

// ParseMapping reads "id=employee.id,name=employee.name,roles=employee.role".
func ParseMapping(s string, defaults Mapping) (Mapping, error) {
	m := defaults
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		key, value, ok := strings.Cut(part, "=")
		value = strings.TrimSpace(value)
		if !ok || value == "" {
			return m, fmt.Errorf("mapping %q: want key=value", part)
		}
		switch strings.TrimSpace(key) {
		case "id":
			m.ID = value
		case "name":
			m.Name = value
		case "roles":
			m.Roles = value
		default:
			return m, fmt.Errorf("mapping %q: key must be id, name or roles", part)
		}
	}
	if m.ID == "" {
		return m, fmt.Errorf("mapping needs id")
	}
	return m, nil
}

// lookup walks a decoded JSON value by a dot path.
func lookup(v any, path string) any {
	if path == "" {
		return nil
	}
	for _, key := range strings.Split(path, ".") {
		obj, ok := v.(map[string]any)
		if !ok {
			return nil
		}
		v = obj[key]
	}
	return v
}

// text renders an id or a name: strings as is, numbers without exponent.
func text(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		if t == float64(int64(t)) {
			return fmt.Sprintf("%d", int64(t))
		}
		return fmt.Sprintf("%g", t)
	case bool:
		return fmt.Sprint(t)
	}
	return ""
}

// list renders roles: an array, or one string split by commas or spaces.
func list(v any) []string {
	var out []string
	switch t := v.(type) {
	case []any:
		for _, item := range t {
			if s := text(item); s != "" {
				out = append(out, s)
			}
		}
	case string:
		out = strings.FieldsFunc(t, func(r rune) bool { return r == ',' || r == ' ' })
	}
	return out
}

// fromDocument builds an identity out of a decoded JSON document.
func (m Mapping) fromDocument(doc any) *Identity {
	id := text(lookup(doc, m.ID))
	if id == "" {
		return nil
	}
	name := text(lookup(doc, m.Name))
	if name == "" {
		name = id
	}
	return &Identity{ID: id, Name: name, Roles: list(lookup(doc, m.Roles))}
}
