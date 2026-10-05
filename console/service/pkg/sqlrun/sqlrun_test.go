package sqlrun

import (
	"context"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Needs a PostgreSQL server: JUMBOSQL_TEST_PG="host port user password" (e.g. "127.0.0.1 5499 postgres postgres").
func target(t *testing.T) Target {
	env := os.Getenv("JUMBOSQL_TEST_PG")
	if env == "" {
		t.Skip("JUMBOSQL_TEST_PG not set")
	}
	f := strings.Fields(env)
	port, _ := strconv.Atoi(f[1])
	return Target{Host: f[0], Port: port, User: f[2], Password: f[3], Database: "postgres", SSLMode: "disable"}
}

func run(t *testing.T, r *Runner, sql string, maxRows int) *Result {
	t.Helper()
	res, err := r.Run(context.Background(), target(t), Request{SQL: sql, MaxRows: maxRows})
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func TestShowAndMultiStatement(t *testing.T) {
	r := NewRunner()
	res := run(t, r, "show hba_file; show archive_command; select 1 as a, null::text as b, 'x'::varchar as c; create temp table t(i int); insert into t select generate_series(1,5) returning i", 0)
	if res.Error != nil {
		t.Fatalf("unexpected error: %+v", res.Error)
	}
	if len(res.Results) != 5 {
		t.Fatalf("want 5 result sets, got %d", len(res.Results))
	}
	hba := res.Results[0]
	if hba.Columns[0].Name != "hba_file" || len(hba.Rows) != 1 || hba.Rows[0][0] == nil || !strings.Contains(*hba.Rows[0][0], "pg_hba") {
		t.Fatalf("show hba_file: %+v", hba)
	}
	if res.Results[1].Columns[0].Name != "archive_command" || len(res.Results[1].Rows) != 1 {
		t.Fatalf("show archive_command: %+v", res.Results[1])
	}
	sel := res.Results[2]
	if sel.Rows[0][1] != nil || *sel.Rows[0][0] != "1" || sel.Columns[2].Type != "character varying" || sel.Columns[0].Type != "integer" {
		t.Fatalf("select: %+v cols %+v", sel.Rows, sel.Columns)
	}
	if res.Results[3].CommandTag != "CREATE TABLE" || res.Results[3].Columns != nil {
		t.Fatalf("create: %+v", res.Results[3])
	}
	ins := res.Results[4]
	if ins.RowCount != 5 || len(ins.Rows) != 5 || ins.CommandTag != "INSERT 0 5" {
		t.Fatalf("insert returning: %+v", ins)
	}
	if res.Server == "" {
		t.Fatal("server address missing")
	}
}

func TestExplainNoticesAndLimit(t *testing.T) {
	r := NewRunner()
	res := run(t, r, "explain analyze select * from generate_series(1,10); do $$ begin raise notice 'hello %', 42; end $$; select generate_series(1,50) as n", 20)
	if res.Error != nil {
		t.Fatalf("unexpected error: %+v", res.Error)
	}
	if res.Results[0].Columns[0].Name != "QUERY PLAN" || len(res.Results[0].Rows) < 2 {
		t.Fatalf("explain: %+v", res.Results[0])
	}
	if len(res.Notices) != 1 || res.Notices[0] != "NOTICE: hello 42" {
		t.Fatalf("notices: %v", res.Notices)
	}
	last := res.Results[2]
	if !last.Truncated || len(last.Rows) != 20 || last.RowCount != 50 {
		t.Fatalf("limit: truncated=%v rows=%d count=%d", last.Truncated, len(last.Rows), last.RowCount)
	}
}

func TestErrorKeepsEarlierResults(t *testing.T) {
	r := NewRunner()
	res := run(t, r, "select 1;\nselect * from no_such_table;\nselect 3", 0)
	if len(res.Results) != 1 || res.Error == nil {
		t.Fatalf("want 1 result + error, got %d results, err %+v", len(res.Results), res.Error)
	}
	e := res.Error
	if e.SQLState != "42P01" || e.Statement != 2 || e.Position != 25 {
		t.Fatalf("error: %+v", e)
	}
	syntax := run(t, r, "selec 1", 0)
	if syntax.Error == nil || syntax.Error.SQLState != "42601" || syntax.Error.Position != 1 {
		t.Fatalf("syntax error: %+v", syntax.Error)
	}
}

func TestTimeoutAndCancel(t *testing.T) {
	r := NewRunner()
	res, err := r.Run(context.Background(), target(t), Request{SQL: "select pg_sleep(10)", Timeout: 500 * time.Millisecond})
	if err != nil || res.Error == nil || !res.Cancelled || !strings.Contains(res.Error.Message, "time limit") {
		t.Fatalf("timeout: err=%v res=%+v", err, res.Error)
	}
	done := make(chan *Result)
	go func() {
		res, _ := r.Run(context.Background(), target(t), Request{SQL: "select pg_sleep(10)", RunID: "abc"})
		done <- res
	}()
	time.Sleep(700 * time.Millisecond)
	if !r.Cancel("abc") {
		t.Fatal("run not found")
	}
	select {
	case res := <-done:
		if res.Error == nil || !res.Cancelled {
			t.Fatalf("cancel: %+v", res.Error)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancel did not stop the query")
	}
	if r.Cancel("abc") {
		t.Fatal("finished run still registered")
	}
}

func TestConnectionError(t *testing.T) {
	tg := target(t)
	tg.Password = "wrong"
	tg.User = "no_such_user"
	res, err := NewRunner().Run(context.Background(), tg, Request{SQL: "select 1"})
	if err != nil || res.Error == nil {
		t.Fatalf("want connection error in result, got err=%v res=%+v", err, res)
	}
}
