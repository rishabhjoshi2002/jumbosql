// Package sqlroles enforces the SQL editor's data scope inside PostgreSQL.
//
// For every distinct SQL profile (level, schemas, tables, hidden columns, stats) the console keeps one LOGIN role
// on the cluster, "jsql_<hash>". Before a run, the role's privileges in the target database are made to match the
// profile exactly: everything is revoked, then
//
//   - USAGE on the schemas that hold allowed tables
//   - on each allowed table/view: SELECT (and INSERT/UPDATE/DELETE for write), table-wide when no column of it is
//     hidden, otherwise column-level on the visible columns only
//   - views that read a hidden column (directly or through other views) get nothing: a view runs with its
//     owner's rights and would otherwise show the column
//   - for write: USAGE/SELECT on the sequences of those schemas
//   - membership in pg_read_all_stats only with the sql.stats permission
//   - default_transaction_read_only = on for read-only profiles
//
// The user's SQL then runs as that role, so PostgreSQL itself refuses hidden columns in every form of query
// (SELECT *, aliases, row_to_json(t), RETURNING, ...). As a non-superuser without pg_read_all_stats the role only
// sees its own sessions' query text and addresses in pg_stat_activity. Grants are re-synced at most every
// ResyncAfter per database so new tables are picked up.
package sqlroles

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path"
	"sort"
	"strings"
	"sync"
	"time"

	"postgresql-cluster-console/internal/policy"
	"postgresql-cluster-console/pkg/sqlrun"

	"github.com/jackc/pgx/v5/pgconn"
)

const ResyncAfter = 60 * time.Second

// Record is what the console stores per managed role.
type Record struct {
	ClusterID int64
	RoleName  string
	Password  string
	Profile   policy.SQLProfile
	Synced    map[string]time.Time // database -> last grant sync
}

type Store interface {
	GetSQLRole(ctx context.Context, clusterID int64, role string) (*Record, error) // nil, nil when unknown
	SaveSQLRole(ctx context.Context, rec *Record) error
}

type Manager struct {
	store Store
	mu    sync.Mutex
	locks map[string]*sync.Mutex
	now   func() time.Time
}

func NewManager(store Store) *Manager {
	return &Manager{store: store, locks: map[string]*sync.Mutex{}, now: time.Now}
}

func RoleName(p policy.SQLProfile) string {
	sum := sha256.Sum256([]byte(p.Key()))
	return "jsql_" + hex.EncodeToString(sum[:])[:12]
}

func (m *Manager) lock(key string) func() {
	m.mu.Lock()
	l, ok := m.locks[key]
	if !ok {
		l = &sync.Mutex{}
		m.locks[key] = l
	}
	m.mu.Unlock()
	l.Lock()
	return l.Unlock
}

func newPassword() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// Target returns where the user's SQL must run for this profile: the superuser target itself for the admin
// level, otherwise the managed role (created and synced as needed) on the same address.
func (m *Manager) Target(ctx context.Context, clusterID int64, admin sqlrun.Target, prof policy.SQLProfile, db string) (sqlrun.Target, string, error) {
	admin.Database = db
	if prof.Level == policy.LevelAdmin {
		return admin, admin.User, nil
	}
	if prof.Level == policy.LevelNone {
		return sqlrun.Target{}, "", fmt.Errorf("no SQL access")
	}
	role := RoleName(prof)
	unlock := m.lock(fmt.Sprintf("%d/%s/%s", clusterID, role, db))
	defer unlock()

	rec, err := m.store.GetSQLRole(ctx, clusterID, role)
	if err != nil {
		return sqlrun.Target{}, "", err
	}
	fresh := rec == nil
	if fresh {
		pw, err := newPassword()
		if err != nil {
			return sqlrun.Target{}, "", err
		}
		rec = &Record{ClusterID: clusterID, RoleName: role, Password: pw, Profile: prof, Synced: map[string]time.Time{}}
	}
	if rec.Synced == nil {
		rec.Synced = map[string]time.Time{}
	}
	if fresh || m.now().Sub(rec.Synced[db]) > ResyncAfter {
		if err := Sync(ctx, admin, role, rec.Password, prof, fresh); err != nil {
			return sqlrun.Target{}, "", err
		}
		rec.Synced[db] = m.now()
		rec.Profile = prof
		if err := m.store.SaveSQLRole(ctx, rec); err != nil {
			return sqlrun.Target{}, "", err
		}
	}
	t := admin
	t.User, t.Password = role, rec.Password
	return t, role, nil
}

func quoteIdent(s string) string   { return `"` + strings.ReplaceAll(s, `"`, `""`) + `"` }
func quoteLiteral(s string) string { return `'` + strings.ReplaceAll(s, `'`, `''`) + `'` }

type relation struct {
	schema, name, kind string
	columns            []string
	publicSelect       bool        // PUBLIC may read the whole table
	publicColumns      []string    // columns PUBLIC may read
	uses               [][3]string // views: the (schema, relation, column)s they read (pg_depend of their rewrite rule)
}

func match(pattern, value string) bool { ok, _ := path.Match(pattern, value); return ok }

func tableAllowed(prof policy.SQLProfile, schema, table string) bool {
	if len(prof.Schemas) > 0 {
		ok := false
		for _, s := range prof.Schemas {
			if match(s, schema) {
				ok = true
				break
			}
		}
		if !ok {
			return false
		}
	}
	if len(prof.Tables) == 0 {
		return true
	}
	for _, t := range prof.Tables {
		if i := strings.IndexByte(t, '.'); i >= 0 {
			if match(t[:i], schema) && match(t[i+1:], table) {
				return true
			}
		} else if match(t, table) {
			return true
		}
	}
	return false
}

// Hidden reports whether a column matches one of the hidden-column patterns
// ("column", "table.column" or "schema.table.column").
func Hidden(patterns []string, schema, table, column string) bool {
	for _, p := range patterns {
		parts := strings.Split(p, ".")
		switch len(parts) {
		case 1:
			if match(parts[0], column) {
				return true
			}
		case 2:
			if match(parts[0], table) && match(parts[1], column) {
				return true
			}
		case 3:
			if match(parts[0], schema) && match(parts[1], table) && match(parts[2], column) {
				return true
			}
		}
	}
	return false
}

func exec(ctx context.Context, conn *pgconn.PgConn, sql string) error {
	_, err := conn.Exec(ctx, sql).ReadAll()
	return err
}

func query(ctx context.Context, conn *pgconn.PgConn, sql string) ([][]string, error) {
	res, err := conn.Exec(ctx, sql).ReadAll()
	if err != nil {
		return nil, err
	}
	var out [][]string
	for _, r := range res {
		for _, row := range r.Rows {
			vals := make([]string, len(row))
			for i, v := range row {
				vals[i] = string(v)
			}
			out = append(out, vals)
		}
	}
	return out, nil
}

// Plan returns the statements that give role exactly the profile's privileges in a database with these relations.
// Exported for tests.
func Plan(role string, prof policy.SQLProfile, schemas []string, rels []relation) ([]string, error) {
	r := quoteIdent(role)
	write := prof.Level == policy.LevelWrite
	var stmts []string
	for _, s := range schemas {
		q := quoteIdent(s)
		stmts = append(stmts,
			"REVOKE ALL ON ALL TABLES IN SCHEMA "+q+" FROM "+r,
			"REVOKE ALL ON ALL SEQUENCES IN SCHEMA "+q+" FROM "+r,
			"REVOKE ALL ON SCHEMA "+q+" FROM "+r)
	}
	// A view runs with its owner's rights, so a view that reads a hidden column - directly or through other
	// views - would show it. Such views are not granted at all.
	tainted := map[string]bool{}
	for changed := true; changed; {
		changed = false
		for _, rel := range rels {
			key := rel.schema + "." + rel.name
			if tainted[key] || len(rel.uses) == 0 {
				continue
			}
			for _, u := range rel.uses {
				if tainted[u[0]+"."+u[1]] || Hidden(prof.HiddenColumns, u[0], u[1], u[2]) {
					tainted[key], changed = true, true
					break
				}
			}
		}
	}
	usedSchemas := map[string]bool{}
	var leaks []string
	for _, rel := range rels {
		if !tableAllowed(prof, rel.schema, rel.name) || tainted[rel.schema+"."+rel.name] {
			continue
		}
		var visible, hidden []string
		for _, c := range rel.columns {
			if Hidden(prof.HiddenColumns, rel.schema, rel.name, c) {
				hidden = append(hidden, c)
			} else {
				visible = append(visible, c)
			}
		}
		target := quoteIdent(rel.schema) + "." + quoteIdent(rel.name)
		if len(hidden) > 0 {
			if rel.publicSelect {
				leaks = append(leaks, rel.schema+"."+rel.name)
				continue
			}
			for _, h := range hidden {
				for _, pc := range rel.publicColumns {
					if pc == h {
						leaks = append(leaks, rel.schema+"."+rel.name+"."+h)
					}
				}
			}
		}
		if len(visible) == 0 {
			continue
		}
		usedSchemas[rel.schema] = true
		canWrite := write && (rel.kind == "r" || rel.kind == "p" || rel.kind == "f" || rel.kind == "v")
		if len(hidden) == 0 {
			privs := "SELECT"
			if canWrite {
				privs = "SELECT, INSERT, UPDATE, DELETE"
			}
			stmts = append(stmts, "GRANT "+privs+" ON "+target+" TO "+r)
			continue
		}
		cols := make([]string, len(visible))
		for i, c := range visible {
			cols[i] = quoteIdent(c)
		}
		list := strings.Join(cols, ", ")
		privs := "SELECT (" + list + ")"
		if canWrite {
			privs += ", INSERT (" + list + "), UPDATE (" + list + ")"
		}
		stmts = append(stmts, "GRANT "+privs+" ON "+target+" TO "+r)
		if canWrite {
			stmts = append(stmts, "GRANT DELETE ON "+target+" TO "+r)
		}
	}
	if len(leaks) > 0 {
		sort.Strings(leaks)
		return nil, fmt.Errorf("can't hide columns that every role (PUBLIC) may read: %s; run REVOKE SELECT ON <table> FROM PUBLIC on the cluster first",
			strings.Join(leaks, ", "))
	}
	var used []string
	for s := range usedSchemas {
		used = append(used, s)
	}
	sort.Strings(used)
	for _, s := range used {
		stmts = append(stmts, "GRANT USAGE ON SCHEMA "+quoteIdent(s)+" TO "+r)
		if write {
			stmts = append(stmts, "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "+quoteIdent(s)+" TO "+r)
		}
	}
	return stmts, nil
}

const sqlRelations = `
select n.nspname, c.relname, c.relkind,
       string_agg(a.attname, E'\x1f' order by a.attnum),
       coalesce(bool_or(acl.privilege_type = 'SELECT' and acl.grantee = 0), false)
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
  left join lateral aclexplode(c.relacl) acl on true
 where c.relkind in ('r', 'p', 'v', 'm', 'f')
   and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast|temp_|toast_temp_)'
 group by 1, 2, 3, c.oid
 order by 1, 2`

// columns PUBLIC can read through a column-level grant
const sqlPublicColumns = `
select n.nspname, c.relname, a.attname
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(a.attacl) acl
 where a.attacl is not null and acl.grantee = 0 and acl.privilege_type = 'SELECT'
   and n.nspname not in ('pg_catalog', 'information_schema')`

// columns each view / materialized view reads (through its rewrite rule)
const sqlViewUses = `
select distinct vn.nspname, v.relname, tn.nspname, t.relname, a.attname
  from pg_rewrite rw
  join pg_class v on v.oid = rw.ev_class and v.relkind in ('v', 'm')
  join pg_namespace vn on vn.oid = v.relnamespace
  join pg_depend d on d.classid = 'pg_rewrite'::regclass and d.objid = rw.oid
                  and d.refclassid = 'pg_class'::regclass and d.refobjsubid > 0
  join pg_class t on t.oid = d.refobjid and t.oid <> v.oid
  join pg_namespace tn on tn.oid = t.relnamespace
  join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
 where vn.nspname not in ('pg_catalog', 'information_schema')`

const sqlSchemas = `select nspname from pg_namespace
 where nspname not in ('pg_catalog', 'information_schema') and nspname !~ '^pg_(toast|temp_|toast_temp_)' order by 1`

// Sync makes the role exist with the password and gives it exactly the profile's privileges in admin.Database.
func Sync(ctx context.Context, admin sqlrun.Target, role, password string, prof policy.SQLProfile, setPassword bool) error {
	conn, err := sqlrun.Connect(ctx, admin)
	if err != nil {
		return fmt.Errorf("connect as %s to prepare the SQL role: %w", admin.User, err)
	}
	defer conn.Close(context.Background())

	r := quoteIdent(role)
	exists, err := query(ctx, conn, "select 1 from pg_roles where rolname = "+quoteLiteral(role))
	if err != nil {
		return err
	}
	var pre []string
	if len(exists) == 0 {
		pre = append(pre, "CREATE ROLE "+r+" LOGIN PASSWORD "+quoteLiteral(password)+
			" NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT CONNECTION LIMIT 50")
	} else if setPassword {
		pre = append(pre, "ALTER ROLE "+r+" PASSWORD "+quoteLiteral(password))
	}
	ro := "off"
	if prof.Level == policy.LevelRead {
		ro = "on"
	}
	pre = append(pre, "ALTER ROLE "+r+" SET default_transaction_read_only = "+ro,
		"COMMENT ON ROLE "+r+" IS "+quoteLiteral("pg_genie SQL editor role ("+prof.Level+"), managed by the console - do not edit"))
	if prof.Stats {
		pre = append(pre, "GRANT pg_read_all_stats TO "+r)
	} else {
		pre = append(pre, "REVOKE pg_read_all_stats FROM "+r)
	}
	if err := exec(ctx, conn, strings.Join(pre, ";\n")); err != nil {
		return fmt.Errorf("prepare role %s: %w", role, err)
	}

	schemaRows, err := query(ctx, conn, sqlSchemas)
	if err != nil {
		return err
	}
	var schemas []string
	for _, s := range schemaRows {
		schemas = append(schemas, s[0])
	}
	relRows, err := query(ctx, conn, sqlRelations)
	if err != nil {
		return err
	}
	pubCols, err := query(ctx, conn, sqlPublicColumns)
	if err != nil {
		return err
	}
	pub := map[string][]string{}
	for _, pc := range pubCols {
		pub[pc[0]+"."+pc[1]] = append(pub[pc[0]+"."+pc[1]], pc[2])
	}
	useRows, err := query(ctx, conn, sqlViewUses)
	if err != nil {
		return err
	}
	uses := map[string][][3]string{}
	for _, u := range useRows {
		uses[u[0]+"."+u[1]] = append(uses[u[0]+"."+u[1]], [3]string{u[2], u[3], u[4]})
	}
	var rels []relation
	for _, row := range relRows {
		key := row[0] + "." + row[1]
		rels = append(rels, relation{schema: row[0], name: row[1], kind: row[2], columns: strings.Split(row[3], "\x1f"),
			publicSelect: row[4] == "t", publicColumns: pub[key], uses: uses[key]})
	}
	stmts, err := Plan(role, prof, schemas, rels)
	if err != nil {
		return err
	}
	script := "BEGIN;\n" + strings.Join(stmts, ";\n") + ";\nCOMMIT;"
	if err := exec(ctx, conn, script); err != nil {
		return fmt.Errorf("set the privileges of %s in %s: %w", role, admin.Database, err)
	}
	return nil
}
