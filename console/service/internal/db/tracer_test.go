package db

import (
	"testing"
	"time"
)

// a NULL timestamp (nil *time.Time) in the query arguments must not crash the request
func TestLogQueryArgsNilPointer(t *testing.T) {
	var ts *time.Time
	now := time.Unix(0, 0).UTC()
	got := logQueryArgs([]any{"a", ts, 3, &now})
	want := `("a",NULL,3,1970-01-01 00:00:00 +0000 UTC)`
	if got != want {
		t.Fatalf("got %s, want %s", got, want)
	}
}
