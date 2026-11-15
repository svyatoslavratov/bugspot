package memory_test

import (
	"context"
	"testing"
	"time"

	"github.com/svyatoslavratov/pinpath/internal/domain"
	"github.com/svyatoslavratov/pinpath/internal/store"
	"github.com/svyatoslavratov/pinpath/internal/store/memory"
	"github.com/svyatoslavratov/pinpath/internal/store/storetest"
)

func TestStore(t *testing.T) {
	storetest.Run(t, func(*testing.T) store.Store { return memory.New() })
}

func TestExportImport(t *testing.T) {
	ctx := context.Background()
	a := memory.New()
	if err := a.CreateThread(ctx, &domain.Thread{ID: "t1", Project: "p", Status: domain.StatusOpen}); err != nil {
		t.Fatal(err)
	}
	if err := a.PutScreenshot(ctx, "p", "t1", "image/png", []byte{1}); err != nil {
		t.Fatal(err)
	}
	if err := a.CreateCredential(ctx, domain.Credential{ID: "c1", Hash: "h"}); err != nil {
		t.Fatal(err)
	}
	data, err := a.Export()
	if err != nil {
		t.Fatal(err)
	}
	b := memory.New()
	if err := b.Import(data); err != nil {
		t.Fatal(err)
	}
	if _, _, err := b.Screenshot(ctx, "p", "t1"); err != nil {
		t.Fatalf("screenshot lost: %v", err)
	}
	if c, err := b.CredentialByHash(ctx, "h"); err != nil || c.ID != "c1" {
		t.Fatalf("credential hash lost: %v %v", c, err)
	}
}

// Export leaves the looks of the screen map out (localStorage is small); ExportAll keeps them.
func TestExportLooks(t *testing.T) {
	ctx := context.Background()
	a := memory.New()
	ref := domain.StateRef{Screen: "/campaigns", State: ""}
	at := time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)
	if err := a.PutShot(ctx, "p", ref, "image/webp", []byte{1, 2}, at); err != nil {
		t.Fatal(err)
	}
	if err := a.PutAsset(ctx, "p", "h1", "text/css", []byte("a{}")); err != nil {
		t.Fatal(err)
	}
	if err := a.PutSnapshot(ctx, "p", domain.Snapshot{Screen: ref.Screen, State: ref.State, HTML: []byte("<p>x</p>"), CSS: []string{"h1"}, At: at}); err != nil {
		t.Fatal(err)
	}
	small, _ := a.Export()
	full, err := a.ExportAll()
	if err != nil || len(full) <= len(small) {
		t.Fatalf("full export %d bytes, small %d: %v", len(full), len(small), err)
	}
	b := memory.New()
	if err := b.Import(small); err != nil {
		t.Fatal(err)
	}
	if m, _ := b.ScreenMap(ctx, "p"); m.Screens[0].States[0].HasShot {
		t.Fatal("a small export claims a look it does not carry")
	}
	c := memory.New()
	if err := c.Import(full); err != nil {
		t.Fatal(err)
	}
	if _, data, err := c.Shot(ctx, "p", ref); err != nil || len(data) != 2 {
		t.Fatalf("shot = %v, %v", data, err)
	}
	if s, err := c.Snapshot(ctx, "p", ref); err != nil || string(s.HTML) != "<p>x</p>" {
		t.Fatalf("snapshot = %q, %v", s.HTML, err)
	}
	if _, data, err := c.Asset(ctx, "p", "h1"); err != nil || string(data) != "a{}" {
		t.Fatalf("asset = %q, %v", data, err)
	}
	if m, _ := c.ScreenMap(ctx, "p"); !m.Screens[0].States[0].HasShot || !m.Screens[0].States[0].HasSnapshot {
		t.Fatalf("marks = %+v", m.Screens[0].States)
	}
	// The looks stay out of the next small export.
	if again, _ := c.Export(); len(again) != len(small) {
		t.Fatalf("small export after a full one: %d bytes, want %d", len(again), len(small))
	}
}
