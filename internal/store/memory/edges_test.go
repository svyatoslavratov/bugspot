package memory

import (
	"testing"

	"github.com/svyatoslavratov/bugspot/internal/domain"
)

func TestEdges(t *testing.T) {
	s := New()
	if err := s.Import([]byte("{")); err == nil {
		t.Fatal("broken export imported")
	}
	if err := s.Import([]byte(`{"threads":[]}`)); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if !domain.StatusResolved.Closed() || !domain.StatusWontfix.Closed() || domain.StatusFixed.Closed() {
		t.Fatal("Closed")
	}
}
