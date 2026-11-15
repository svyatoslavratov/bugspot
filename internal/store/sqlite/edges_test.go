package sqlite_test

import (
	"context"
	"testing"

	"github.com/svyatoslavratov/pinpath/internal/secret"
	"github.com/svyatoslavratov/pinpath/internal/store/sqlite"
)

func TestOpenFails(t *testing.T) {
	if _, err := sqlite.Open(context.Background(), t.TempDir()+"/missing/dir/pinpath.db"); err == nil {
		t.Fatal("opened a database in a missing directory")
	}
	if !secret.Equal("a", "a") || secret.Equal("a", "b") {
		t.Fatal("secret.Equal")
	}
}
