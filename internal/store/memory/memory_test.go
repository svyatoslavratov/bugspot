package memory_test

import (
	"context"
	"testing"

	"github.com/svyatoslavratov/bugspot/internal/domain"
	"github.com/svyatoslavratov/bugspot/internal/store"
	"github.com/svyatoslavratov/bugspot/internal/store/memory"
	"github.com/svyatoslavratov/bugspot/internal/store/storetest"
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
