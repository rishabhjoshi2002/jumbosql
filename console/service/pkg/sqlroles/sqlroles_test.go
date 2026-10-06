package sqlroles

import (
	"context"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"postgresql-cluster-console/internal/policy"
	"postgresql-cluster-console/pkg/sqlrun"
)

/* ----------------------------------------------------- unit: the grant plan ----------------------------------------------------- */

func TestPlan(t *testing.T) {
	rels := []relation{
		{schema: "sales", name: "orders", kind: "r", columns: []string{"id", "customer", "card_no"}},
		{schema: "sales", name: "secret", kind: "r", columns: []string{"x"}},
		{schema: "hr", name: "people", kind: "r", columns: []string{"id", "email"}},
		{schema: "sales", name: "v_orders", kind: "v", columns: []string{"id", "customer"}},
	}
	prof := policy.SQLProfile{Level: policy.LevelWrite, Schemas: []string{"sales"}, Tables: []string{"orders", "sales.v_*"},
		HiddenColumns: []string{"*.*.card_no", "email"}}
	stmts, err := Plan("jsql_x", prof, []string{"hr", "sales"}, rels)
	if err != nil {
		t.Fatal(err)
	}
	all := strings.Join(stmts, "\n")
	for _, want := range []string{
		`REVOKE ALL ON ALL TABLES IN SCHEMA "hr" FROM "jsql_x"`,
		`GRANT SELECT ("id", "customer"), INSERT ("id", "customer"), UPDATE ("id", "customer") ON "sales"."orders" TO "jsql_x"`,
		`GRANT DELETE ON "sales"."orders" TO "jsql_x"`,
		`GRANT SELECT, INSERT, UPDATE, DELETE ON "sales"."v_orders" TO "jsql_x"`,
		`GRANT USAGE ON SCHEMA "sales" TO "jsql_x"`,
		`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "sales" TO "jsql_x"`,
	} {
		if !strings.Contains(all, want) {
			t.Errorf("missing: %s\n%s", want, all)
		}
	}
	if strings.Contains(all, `"sales"."secret" TO`) || strings.Contains(all, `"hr"."people" TO`) || strings.Contains(all, `USAGE ON SCHEMA "hr" TO`) {
		t.Errorf("grants outside the scope:\n%s", all)
	}
	// PUBLIC can read a table with hidden columns -> refuse
	leak := []relation{{schema: "sales", name: "orders", kind: "r", columns: []string{"id", "card_no"}, publicSelect: true}}
	if _, err := Plan("jsql_x", prof, []string{"sales"}, leak); err == nil || !strings.Contains(err.Error(), "sales.orders") {
		t.Fatalf("public leak not refused: %v", err)
	}
}

func TestHidden(t *testing.T) {
	p := []string{"ssn", "orders.card_*", "hr.people.salary"}
	cases := map[[3]string]bool{
		{"a", "b", "ssn"}: true, {"x", "orders", "card_no"}: true, {"x", "items", "card_no"}: false,
		{"hr", "people", "salary"}: true, {"pay", "people", "salary"}: false,
	}
	for c, want := range cases {
		if Hidden(p, c[0], c[1], c[2]) != want {
			t.Errorf("%v: want %v", c, want)
		}
	}
}

/* ----------------------------------------------------- integration: real PostgreSQL ----------------------------------------------------- */

type memStore struct {
	mu sync.Mutex
	m  map[string]*Record
}

func (s *memStore) GetSQLRole(_ context.Context, id int64, role string) (*Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.m[strconv.FormatInt(id, 10)+role]
	if r == nil {
		return nil, nil
	}
	c := *r
	return &c, nil
}

func (s *memStore) SaveSQLRole(_ context.Context, r *Record) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := *r
	s.m[strconv.FormatInt(r.ClusterID, 10)+r.RoleName] = &c
	return nil
}

// JUMBOSQL_TEST_PG="host port superuser password"
func adminTarget(t *testing.T, db string) sqlrun.Target {
	env := os.Getenv("JUMBOSQL_TEST_PG")
	if env == "" {
		t.Skip("JUMBOSQL_TEST_PG not set")
	}
	f := strings.Fields(env)
	port, _ := strconv.Atoi(f[1])
	return sqlrun.Target{Host: f[0], Port: port, User: f[2], Password: f[3], Database: db, SSLMode: "disable"}
}

func mustRun(t *testing.T, tg sqlrun.Target, sql string) *sqlrun.Result {
	t.Helper()
	res, err := sqlrun.NewRunner().Run(context.Background(), tg, sqlrun.Request{SQL: sql})
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func ok(t *testing.T, tg sqlrun.Target, sql string) *sqlrun.Result {
	t.Helper()
	res := mustRun(t, tg, sql)
	if res.Error != nil {
		t.Fatalf("%s: unexpected error %s (%s)", sql, res.Error.Message, res.Error.SQLState)
	}
	return res
}

func denied(t *testing.T, tg sqlrun.Target, sql string) {
	t.Helper()
	res := mustRun(t, tg, sql)
	if res.Error == nil {
		t.Fatalf("%s: expected an error, got %+v", sql, res.Results)
	}
	if res.Error.SQLState != "42501" && res.Error.SQLState != "25006" {
		t.Fatalf("%s: expected permission denied / read-only, got %s %s", sql, res.Error.SQLState, res.Error.Message)
	}
}

func TestEnforcedByPostgreSQL(t *testing.T) {
	admin := adminTarget(t, "postgres")
	ok(t, admin, "drop database if exists jsql_test")
	ok(t, admin, "create database jsql_test")
	adminDB := admin
	adminDB.Database = "jsql_test"
	ok(t, adminDB, `
create schema sales; create schema hr;
create table sales.orders (id serial primary key, customer text, card_no text, amount numeric);
insert into sales.orders (customer, card_no, amount) values ('acme', '4111-1111', 10), ('globex', '5500-0000', 20);
create table hr.people (id int, name text, salary int); insert into hr.people values (1, 'ann', 100);
create view sales.v_orders as select id, customer, card_no from sales.orders;
create view sales.v_safe as select id, customer from sales.orders;
create view sales.v_cards as select id, card_no as c from sales.orders;
create view sales.v_over as select * from sales.v_cards;
create table sales.open_data (id int, card_no text); grant select on sales.open_data to public;`)

	m := NewManager(&memStore{m: map[string]*Record{}})
	ctx := context.Background()
	read := policy.SQLProfile{Level: policy.LevelRead, Schemas: []string{"sales"}, Tables: []string{"orders", "v_orders"},
		HiddenColumns: []string{"*.*.card_no"}}

	tg, role, err := m.Target(ctx, 1, admin, read, "jsql_test")
	if err != nil {
		t.Fatal(err)
	}
	if tg.User != role || !strings.HasPrefix(role, "jsql_") || tg.Password == admin.Password {
		t.Fatalf("target %+v", tg)
	}
	res := ok(t, tg, "select id, customer, amount from sales.orders order by id")
	if len(res.Results[0].Rows) != 2 {
		t.Fatalf("rows: %+v", res.Results[0])
	}
	for _, q := range []string{
		"select * from sales.orders",
		"select card_no from sales.orders",
		"select c from (select card_no as c from sales.orders) x",
		"select row_to_json(o) from sales.orders o",
		"select * from sales.v_orders",
		"select * from hr.people",
		"insert into sales.orders (customer) values ('x')",
	} {
		denied(t, tg, q)
	}
	// views: one that reads the hidden column is not granted at all (it would run with its owner's rights),
	// neither are views on top of it; a view on visible columns only is fine
	read2 := read
	read2.Tables = append(read2.Tables, "v_*")
	tv, _, err := m.Target(ctx, 1, admin, read2, "jsql_test")
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{"select * from sales.v_orders", "select id from sales.v_orders", "select * from sales.v_cards", "select * from sales.v_over"} {
		denied(t, tv, q)
	}
	ok(t, tv, "select * from sales.v_safe")

	// pg_stat_activity: other sessions' query text is hidden for a non-superuser without sql.stats
	res = ok(t, tg, "select count(*) filter (where query = '<insufficient privilege>') from pg_stat_activity where usename = 'postgres' or backend_type <> 'client backend'")
	if *res.Results[0].Rows[0][0] == "0" {
		t.Fatal("expected hidden query text for other sessions")
	}

	// write profile: visible columns writable, hidden ones not, RETURNING a hidden column refused
	write := read
	write.Level = policy.LevelWrite
	write.Stats = true
	tw, _, err := m.Target(ctx, 1, admin, write, "jsql_test")
	if err != nil {
		t.Fatal(err)
	}
	ok(t, tw, "insert into sales.orders (customer, amount) values ('initech', 5)")
	ok(t, tw, "update sales.orders set amount = amount + 1 where customer = 'initech'")
	denied(t, tw, "update sales.orders set card_no = 'x'")
	denied(t, tw, "insert into sales.orders (customer) values ('y') returning card_no")
	ok(t, tw, "delete from sales.orders where customer = 'initech'")
	res = ok(t, tw, "select count(*) filter (where query = '<insufficient privilege>') from pg_stat_activity")
	if *res.Results[0].Rows[0][0] != "0" {
		t.Fatal("with sql.stats every session's query text is visible")
	}

	// PUBLIC can read a table whose columns should be hidden -> refused with an explanation
	leaky := policy.SQLProfile{Level: policy.LevelRead, Schemas: []string{"sales"}, HiddenColumns: []string{"card_no"}}
	if _, _, err := m.Target(ctx, 1, admin, leaky, "jsql_test"); err == nil || !strings.Contains(err.Error(), "sales.open_data") {
		t.Fatalf("expected the PUBLIC leak to be refused, got %v", err)
	}

	// new tables are picked up on the next sync
	all := policy.SQLProfile{Level: policy.LevelRead, Schemas: []string{"sales"}}
	ta, _, err := m.Target(ctx, 1, admin, all, "jsql_test")
	if err != nil {
		t.Fatal(err)
	}
	ok(t, adminDB, "create table sales.later (id int); insert into sales.later values (1)")
	denied(t, ta, "select * from sales.later")
	m.now = func() time.Time { return time.Now().Add(2 * ResyncAfter) }
	ta, _, err = m.Target(ctx, 1, admin, all, "jsql_test")
	if err != nil {
		t.Fatal(err)
	}
	ok(t, ta, "select * from sales.later")
	denied(t, ta, "select * from hr.people")

	// the admin level runs as the superuser itself
	adm, user, err := m.Target(ctx, 1, admin, policy.SQLProfile{Level: policy.LevelAdmin}, "jsql_test")
	if err != nil || user != admin.User || adm.Password != admin.Password {
		t.Fatalf("admin target: %v %s", err, user)
	}

	ok(t, admin, "drop database jsql_test")
}
