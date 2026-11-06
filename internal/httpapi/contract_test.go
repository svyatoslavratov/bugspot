package httpapi

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// TestRoutesMatchOpenAPI keeps api/openapi.yaml and the routes in step: every API path in the
// spec is served, and every served API path is in the spec.
func TestRoutesMatchOpenAPI(t *testing.T) {
	spec, err := os.ReadFile("../../api/openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	specPaths := map[string]bool{}
	for _, m := range regexp.MustCompile(`(?m)^  (/[^:]*):$`).FindAllStringSubmatch(string(spec), -1) {
		specPaths[m[1]] = true
	}
	source, err := os.ReadFile("server.go")
	if err != nil {
		t.Fatal(err)
	}
	served := map[string]bool{}
	for _, m := range regexp.MustCompile(`"(?:GET|POST|PATCH|PUT|DELETE) (/[^"{]*(?:\{[a-z]+\}[^"{]*)*)"`).FindAllStringSubmatch(string(source), -1) {
		path := m[1]
		if path == "/{$}" || strings.HasPrefix(path, "/assets/") {
			continue
		}
		served[path] = true
	}
	if len(specPaths) < 8 || len(served) < 8 {
		t.Fatalf("parsed %d spec paths and %d routes: the patterns no longer match the files", len(specPaths), len(served))
	}
	for path := range served {
		if !specPaths[path] {
			t.Errorf("%s is served but not in api/openapi.yaml", path)
		}
	}
	for path := range specPaths {
		if !served[path] {
			t.Errorf("%s is in api/openapi.yaml but not served", path)
		}
	}
}
