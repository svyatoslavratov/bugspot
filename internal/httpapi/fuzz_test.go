package httpapi

import (
	"encoding/json"
	"testing"
)

// FuzzThreadInput: whatever a client sends, checking a thread either refuses it or leaves valid,
// compact JSON objects and a route that starts with a slash.
func FuzzThreadInput(f *testing.F) {
	f.Add("/a", "https://x/a", "body", `{"selector":"#x"}`, `{"console":[]}`)
	f.Add("a", "javascript:1", "", `[1]`, `null`)
	f.Add("/", "http://x", " text ", `{ "a" : 1 }`, `{}`)
	f.Fuzz(func(t *testing.T, route, url, body, anchor, context string) {
		in := threadInput{Route: route, URL: url, Body: body, Anchor: json.RawMessage(anchor), Context: json.RawMessage(context)}
		if err := in.check(); err != nil {
			return
		}
		if in.Route == "" || in.Route[0] != '/' || in.Body == "" {
			t.Fatalf("accepted %+v", in)
		}
		for _, raw := range []json.RawMessage{in.Anchor, in.Context} {
			var obj map[string]any
			if err := json.Unmarshal(raw, &obj); err != nil || obj == nil {
				t.Fatalf("not an object after check: %s", raw)
			}
		}
	})
}

// FuzzImageType: only PNG, JPEG and WebP signatures are recognized.
func FuzzImageType(f *testing.F) {
	f.Add([]byte("\x89PNG\r\n\x1a\nxx"))
	f.Add([]byte("<svg onload=alert(1)>"))
	f.Fuzz(func(t *testing.T, data []byte) {
		switch imageType(data) {
		case "", "image/png", "image/jpeg", "image/webp":
		default:
			t.Fatal("unexpected type")
		}
	})
}
