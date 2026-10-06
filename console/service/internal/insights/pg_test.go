package insights

import (
	"context"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"postgresql-cluster-console/pkg/sqlrun"
)

// JUMBOSQL_TEST_PG="host port superuser password" runs these against a real PostgreSQL.
func pgTarget(t *testing.T, db string) sqlrun.Target {
	env := os.Getenv("JUMBOSQL_TEST_PG")
	if env == "" {
		t.Skip("JUMBOSQL_TEST_PG not set")
	}
	f := strings.Fields(env)
	port, _ := strconv.Atoi(f[1])
	return sqlrun.Target{Host: f[0], Port: port, User: f[2], Password: f[3], Database: db, SSLMode: "disable"}
}

func TestPostgresQueries(t *testing.T) {
	ctx := context.Background()
	admin, err := sqlrun.Connect(ctx, pgTarget(t, "postgres"))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	_, _ = rows(ctx, admin, "drop database if exists jsql_insights_test")
	if _, err := rows(ctx, admin, "create database jsql_insights_test"); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = rows(context.Background(), admin, "drop database if exists jsql_insights_test with (force)")
	}()

	w, err := sqlrun.Connect(ctx, pgTarget(t, "jsql_insights_test"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := rows(ctx, w, `create table public.t (id int primary key, v text);
		create index t_v on public.t (v);
		insert into public.t select g, md5(g::text) from generate_series(1, 20000) g;
		delete from public.t where id % 2 = 0;`); err != nil {
		t.Fatal(err)
	}
	w.Close(ctx)                        // a backend reports its statistics when it ends
	time.Sleep(1500 * time.Millisecond) // and the statistics collector catches up
	conn, err := sqlrun.Connect(ctx, pgTarget(t, "jsql_insights_test"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)

	now := time.Now()
	samples, dbs, err := sampleCluster(ctx, admin, now)
	if err != nil {
		t.Fatal(err)
	}
	if !contains(dbs, "jsql_insights_test") {
		t.Fatalf("databases %v", dbs)
	}
	got := map[string]bool{}
	for _, s := range samples {
		got[s.Metric] = true
	}
	for _, m := range []string{MClusterSize, MDBSize, MXact, MConnections, MMaxConnections, MBlksHit} {
		if !got[m] {
			t.Fatalf("metric %s not sampled", m)
		}
	}
	ts, err := sampleTables(ctx, conn, "jsql_insights_test", now)
	if err != nil || len(ts) != 3 || ts[0].Key != "jsql_insights_test/public.t" {
		t.Fatalf("tables: %v %+v", err, ts)
	}

	ov, err := overview(ctx, admin)
	if err != nil || ov.VersionNum < 120000 || ov.MaxConnections == 0 || ov.DataDirectory == "" {
		t.Fatalf("overview: %v %+v", err, ov)
	}
	tables, err := liveTables(ctx, conn, "jsql_insights_test", 10)
	if err != nil || len(tables) != 1 {
		t.Fatalf("live tables: %v %+v", err, tables)
	}
	if tb := tables[0]; tb.DeadRows < 9000 || tb.DeadPct < 40 || tb.BloatBytes <= 0 {
		t.Fatalf("dead rows not seen: %+v", tb)
	}
	idx, err := unusedIndexes(ctx, conn, "jsql_insights_test")
	if err != nil || len(idx) != 1 || idx[0].Name != "public.t_v" {
		t.Fatalf("unused indexes: %v %+v", err, idx)
	}
	if ov.PgStatStatements {
		if _, err := topQueries(ctx, admin, ov.VersionNum); err != nil {
			t.Fatal(err)
		}
	}
}
