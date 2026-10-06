package pglogs

import (
	"context"
	"os"
	"strconv"
	"strings"
	"testing"

	"postgresql-cluster-console/pkg/sqlrun"
)

// JUMBOSQL_TEST_PG="host port superuser password" with logging_collector = on
func node(t *testing.T) sqlrun.Target {
	env := os.Getenv("JUMBOSQL_TEST_PG")
	if env == "" {
		t.Skip("JUMBOSQL_TEST_PG not set")
	}
	f := strings.Fields(env)
	port, _ := strconv.Atoi(f[1])
	return sqlrun.Target{Host: f[0], Port: port, User: f[2], Password: f[3], Database: "postgres", SSLMode: "disable"}
}

func TestListAndRead(t *testing.T) {
	ctx := context.Background()
	n := node(t)
	l, err := List(ctx, n)
	if err != nil {
		t.Fatal(err)
	}
	if len(l.Files) == 0 || l.Current == "" || l.Files[0].Name == "" {
		t.Fatalf("listing: %+v", l)
	}
	// write a recognizable line into the server log
	marker := "jumbosql-log-test-" + strconv.FormatInt(int64(len(l.Files))+l.Files[0].Size, 10)
	if _, err := sqlrun.NewRunner().Run(ctx, n, sqlrun.Request{SQL: "do $$ begin raise log '" + marker + "'; end $$"}); err != nil {
		t.Fatal(err)
	}
	c, err := Read(ctx, n, l.Current, 64, -1)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(c.Text, marker) || c.Next != c.Size || c.Next <= 0 {
		t.Fatalf("tail does not contain the marker: next=%d size=%d\n%s", c.Next, c.Size, c.Text)
	}
	// live tail: nothing new from the end, then the new line only
	again, err := Read(ctx, n, l.Current, 0, c.Next)
	if err != nil || again.Text != "" {
		t.Fatalf("expected no new text: %v %q", err, again.Text)
	}
	if _, err := sqlrun.NewRunner().Run(ctx, n, sqlrun.Request{SQL: "do $$ begin raise log 'second-" + marker + "'; end $$"}); err != nil {
		t.Fatal(err)
	}
	more, err := Read(ctx, n, l.Current, 0, c.Next)
	if err != nil || !strings.Contains(more.Text, "second-"+marker) || strings.Contains(strings.ReplaceAll(more.Text, "second-"+marker, ""), marker) {
		t.Fatalf("live tail: %v %q", err, more.Text)
	}
	// only files of the log directory
	for _, bad := range []string{"../postgresql.conf", "/etc/passwd", "../../../../etc/passwd"} {
		if _, err := Read(ctx, n, bad, 1, -1); err == nil {
			t.Fatalf("read %q", bad)
		}
	}
	// a small tail starts at a whole line
	small, err := Read(ctx, n, l.Current, 1, -1)
	if err != nil {
		t.Fatal(err)
	}
	if small.Size > 1024 && (!small.Truncated || small.Offset <= small.Size-1024) {
		t.Fatalf("small tail: %+v", small)
	}
}

func TestDecodeBytea(t *testing.T) {
	if string(decodeBytea([]byte(`\x68690a`))) != "hi\n" || string(decodeBytea([]byte("plain"))) != "plain" {
		t.Fatal("bytea decoding")
	}
}
