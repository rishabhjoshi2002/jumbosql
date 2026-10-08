package discover

import "testing"

func TestParseInventory(t *testing.T) {
	got, err := ParseInventory("# demo\n10.0.0.1\n10.0.0.2:5433\ndb3 6432\n[::1]:5432, \n10.0.0.1:5432 # again\n")
	if err != nil {
		t.Fatal(err)
	}
	want := []Target{{"10.0.0.1", 5432}, {"10.0.0.2", 5433}, {"db3", 6432}, {"::1", 5432}}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%d: got %v want %v", i, got[i], want[i])
		}
	}
	for _, bad := range []string{"", "# nothing", "h:99999", "h x", "a'b"} {
		if _, err := ParseInventory(bad); err == nil {
			t.Fatalf("%q should fail", bad)
		}
	}
}

func TestConninfo(t *testing.T) {
	ci := "user=replicator password='se cr\\'et' channel_binding=prefer host=10.0.0.5 port=5433 dbname=shop application_name='pg standby'"
	h, p, ok := conninfoHost(ci)
	if !ok || h != "10.0.0.5" || p != 5433 || conninfoDB(ci) != "shop" {
		t.Fatalf("got %s %d %v", h, p, ok)
	}
	if m := maskConninfo(ci); m != "application_name=pg standby dbname=shop host=10.0.0.5 password=******** port=5433 user=replicator" {
		t.Fatalf("masked: %s", m)
	}
	if h, p, ok := conninfoHost("postgresql://rep@db1.example:6000/app"); !ok || h != "db1.example" || p != 6000 {
		t.Fatalf("uri: %s %d", h, p)
	}
	if _, _, ok := conninfoHost("host=/var/run/postgresql"); ok {
		t.Fatal("a socket directory is not a host")
	}
	if h, p, _ := conninfoHost("host=a,b port=5432,5433"); h != "a" || p != 0 && p != 5432 {
		t.Fatalf("multi-host: %s %d", h, p)
	}
}

func TestCheckReadOnly(t *testing.T) {
	ok := []string{
		"select 1", "  SELECT * FROM t;", "with x as (select 1) select * from x", "show work_mem", "explain select 1",
		"(select 1) union (select 2)", "-- comment\nselect ';' as semi", "table pg_settings", "values (1)",
		"select pg_size_pretty(pg_database_size(current_database()))",
	}
	for _, s := range ok {
		if _, err := CheckReadOnly(s); err != nil {
			t.Errorf("%q refused: %v", s, err)
		}
	}
	bad := []string{
		"", "delete from t", "update t set a=1", "drop table t", "commit", "begin", "set work_mem='1GB'",
		"select 1; drop table t", "select pg_terminate_backend(123)", "select pg_reload_conf()",
		"SELECT PG_DROP_REPLICATION_SLOT('x')", "select * from dblink('x','y') as t(a int)",
		"select query_to_xml('delete from t', true, true, '')", "copy t to '/tmp/x'", "vacuum t",
		"/* x */ insert into t values (1)", "select lo_export(1, '/tmp/x')", "select nextval('s')",
	}
	for _, s := range bad {
		if _, err := CheckReadOnly(s); err == nil {
			t.Errorf("%q accepted", s)
		}
	}
}

func TestReadiness(t *testing.T) {
	inv := &Inventory{
		Tables: []DBTable{
			{Schema: "public", Name: "orders", Kind: "table", PrimaryKey: true, ReplIdent: "default"},
			{Schema: "public", Name: "log", Kind: "table", ReplIdent: "default"},
			{Schema: "public", Name: "cache", Kind: "table", Unlogged: true, PrimaryKey: true, ReplIdent: "default"},
		},
		Sequences: []DBSeq{{Schema: "public", Name: "ids", UsedPct: 90, LastValue: "1932735283", MaxValue: "2147483647", DataType: "integer"}},
		Indexes:   []DBIndex{{Schema: "public", Name: "bad_idx", Valid: false}},
		Counts:    DBCounts{LargeObjects: 2, Sequences: 1},
		XIDAge:    1_200_000_000, Collation: "en_US.UTF-8", LocaleProv: "libc",
	}
	got := map[string]string{}
	for _, c := range readiness(inv) {
		got[c.Title] = c.Status
	}
	want := map[string]string{
		"1 table has no primary key and no replica identity": "critical",
		"1 unlogged table":                "warning",
		"2 large objects":                 "warning",
		"Sequence public.ids is 90% used": "critical",
		"1 invalid index":                 "warning",
		"Transaction ID age 1200000000":   "critical",
		"Collation en_US.UTF-8 (libc)":    "info",
	}
	for title, st := range want {
		if got[title] != st {
			t.Errorf("%q: got %q, want %q (all: %v)", title, got[title], st, got)
		}
	}
	if first := readiness(inv)[0].Status; first != "critical" {
		t.Errorf("critical first, got %s", first)
	}
}
