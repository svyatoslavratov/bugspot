//go:build js && wasm

package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/svyatoslavratov/bugspot/internal/domain"
	"github.com/svyatoslavratov/bugspot/internal/secret"
)

type seedThread struct {
	route, selector, text, body string
	kind                        domain.Kind
	status                      domain.Status
	author                      domain.Author
	reply                       string
}

var (
	anna   = domain.Author{ID: "anna", Name: "Anna (admin)", Kind: domain.AuthorUser}
	boris  = domain.Author{ID: "boris", Name: "Boris (developer)", Kind: domain.AuthorUser}
	claude = domain.Author{ID: "agent:demo", Name: "Claude", Kind: domain.AuthorAgent}
)

// seed fills an empty demo with threads pinned to elements of the demo page.
func seed() {
	ctx := context.Background()
	if _, err := st.CredentialByHash(ctx, secret.Hash(demoAgentToken)); err != nil {
		_ = st.CreateCredential(ctx, domain.Credential{ID: "demo-agent", Kind: domain.CredentialAgent, Name: "Claude",
			Hash: secret.Hash(demoAgentToken), Scopes: []string{domain.ScopeRead, domain.ScopeReply, domain.ScopeStatus},
			CreatedAt: time.Now().UTC()})
	}
	if list, _, _ := st.ListThreads(ctx, domain.ThreadFilter{Project: "demo", Limit: 1}); len(list) > 0 {
		return
	}
	now := time.Now().UTC()
	threads := []seedThread{
		{route: "/campaigns", selector: `[data-bugspot="search"]`, text: "", kind: domain.KindIssue, status: domain.StatusOpen, author: anna,
			body: "The search field is not centered in its frame: the text sits 2 px too high."},
		{route: "/campaigns", selector: `[data-bugspot="export"]`, text: "Export", kind: domain.KindQuestion, status: domain.StatusFixed, author: boris,
			body: "Should the export include archived campaigns?", reply: "The export uses the current filters, archived campaigns only with the Archive filter on. Fixed the button hint in v0.4.2 — please check."},
		{route: "/campaigns", selector: `[data-bugspot="budget-2"]`, text: "1 250 000 ₽", kind: domain.KindIssue, status: domain.StatusInProgress, author: anna,
			body: "Budget is shown without the currency on narrow screens.", reply: "Taking it: the column hides the suffix below 390 px."},
		{route: "/authors", selector: `[data-bugspot="add-author"]`, text: "Add author", kind: domain.KindIdea, status: domain.StatusOpen, author: boris,
			body: "Let scouts add several communities at once — one per line."},
	}
	for i, s := range threads {
		at := now.Add(time.Duration(i-len(threads)) * time.Hour)
		anchor, _ := json.Marshal(map[string]any{"selector": s.selector, "text": s.text, "tag": "", "offset": map[string]float64{"x": 0.9, "y": 0.2},
			"page": map[string]int{"x": 400, "y": 200}, "viewport": map[string]int{"w": 1440, "h": 900}})
		context, _ := json.Marshal(map[string]any{"userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/141.0", "language": "en",
			"viewport": map[string]any{"w": 1440, "h": 900, "dpr": 2}, "appVersion": "0.4.1", "console": []any{},
			"network": []any{map[string]any{"method": "GET", "url": "/api/campaigns?search=…", "status": 500, "requestId": "req-7f3a", "durationMs": 312}}})
		t := &domain.Thread{ID: secret.ID(), Project: "demo", Route: s.route, URL: "https://example.com/#" + s.route, Title: "Acme CRM",
			Kind: s.kind, Status: s.status, Body: s.body, Anchor: anchor, Context: context, Author: s.author, CreatedAt: at, UpdatedAt: at}
		if s.status != domain.StatusOpen {
			statusAt := at.Add(20 * time.Minute)
			t.StatusBy, t.StatusAt = &claude, &statusAt
		}
		_ = st.CreateThread(ctx, t)
		if s.reply != "" {
			_ = st.AddReply(ctx, "demo", &domain.Reply{ID: secret.ID(), ThreadID: t.ID, Body: s.reply, Author: claude, CreatedAt: at.Add(25 * time.Minute)})
		}
	}
	persist()
}
