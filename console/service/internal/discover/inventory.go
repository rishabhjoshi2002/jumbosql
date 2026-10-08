package discover

// The inside of one database: what a migration has to move (tables, indexes, schemas, views, functions,
// sequences, keys, types, large objects, ...) and what could get in the way (readiness checks).
// Every section is read separately, so a missing privilege only blanks that section.

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
)

const (
	maxTables    = 1000
	maxIndexes   = 2000
	maxObjects   = 1000 // views, functions, sequences, foreign keys
	excludedNsps = `n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast|temp_)'`
)

type Inventory struct {
	Collation     string     `json:"collation,omitempty"`
	CType         string     `json:"ctype,omitempty"`
	LocaleProv    string     `json:"locale_provider,omitempty"`
	ConnLimit     int        `json:"connection_limit"`
	Tablespace    string     `json:"tablespace,omitempty"`
	XIDAge        int        `json:"xid_age"`
	Counts        DBCounts   `json:"counts"`
	Schemas       []DBSchema `json:"schemas"`
	Tables        []DBTable  `json:"tables"`
	Indexes       []DBIndex  `json:"indexes"`
	Views         []DBView   `json:"views"`
	Functions     []DBFunc   `json:"functions"`
	Sequences     []DBSeq    `json:"sequences"`
	ForeignKeys   []DBFK     `json:"foreign_keys"`
	Types         []DBType   `json:"types"`
	Triggers      []DBTrig   `json:"triggers"`
	ForeignSrv    []string   `json:"foreign_servers"`
	ColumnTypes   []TypeUse  `json:"column_types"`
	Checks        []Check    `json:"checks"`
	Partial       []string   `json:"partial,omitempty"`
	Truncated     []string   `json:"truncated,omitempty"` // lists cut at their limit
	LargestTable  string     `json:"largest_table,omitempty"`
	TotalRowsEst  float64    `json:"total_rows_estimate"`
	UserDataBytes float64    `json:"user_data_bytes"`
}

type DBCounts struct {
	Schemas           int `json:"schemas"`
	Tables            int `json:"tables"`
	PartitionedTables int `json:"partitioned_tables"`
	Partitions        int `json:"partitions"`
	Indexes           int `json:"indexes"`
	Views             int `json:"views"`
	MatViews          int `json:"materialized_views"`
	Functions         int `json:"functions"`
	Procedures        int `json:"procedures"`
	Sequences         int `json:"sequences"`
	Triggers          int `json:"triggers"`
	ForeignKeys       int `json:"foreign_keys"`
	ForeignTables     int `json:"foreign_tables"`
	Types             int `json:"types"`
	LargeObjects      int `json:"large_objects"`
	UnloggedTables    int `json:"unlogged_tables"`
	NoPrimaryKey      int `json:"tables_without_primary_key"`
	EventTriggers     int `json:"event_triggers"`
	Publications      int `json:"publications"`
}

type DBSchema struct {
	Name      string  `json:"name"`
	Owner     string  `json:"owner"`
	Tables    int     `json:"tables"`
	SizeBytes float64 `json:"size_bytes"`
}

type DBTable struct {
	Schema      string  `json:"schema"`
	Name        string  `json:"name"`
	Kind        string  `json:"kind"` // table | partitioned | partition
	Unlogged    bool    `json:"unlogged,omitempty"`
	Rows        float64 `json:"rows"` // estimate (reltuples / n_live_tup)
	TotalBytes  float64 `json:"total_bytes"`
	TableBytes  float64 `json:"table_bytes"`
	IndexBytes  float64 `json:"index_bytes"`
	ToastBytes  float64 `json:"toast_bytes"`
	Columns     int     `json:"columns"`
	PrimaryKey  bool    `json:"primary_key"`
	ReplIdent   string  `json:"replica_identity"` // default | index | full | nothing
	DeadRows    float64 `json:"dead_rows"`
	SeqScans    float64 `json:"seq_scans"`
	IdxScans    float64 `json:"idx_scans"`
	LastVacuum  string  `json:"last_vacuum,omitempty"`
	LastAnalyze string  `json:"last_analyze,omitempty"`
	Owner       string  `json:"owner"`
	Tablespace  string  `json:"tablespace,omitempty"`
}

type DBIndex struct {
	Schema     string  `json:"schema"`
	Table      string  `json:"table"`
	Name       string  `json:"name"`
	Method     string  `json:"method"`
	SizeBytes  float64 `json:"size_bytes"`
	Unique     bool    `json:"unique"`
	Primary    bool    `json:"primary"`
	Valid      bool    `json:"valid"`
	Scans      float64 `json:"scans"`
	Definition string  `json:"definition"`
}

type DBView struct {
	Schema       string  `json:"schema"`
	Name         string  `json:"name"`
	Materialized bool    `json:"materialized"`
	Populated    bool    `json:"populated"`
	SizeBytes    float64 `json:"size_bytes"`
	Owner        string  `json:"owner"`
}

type DBFunc struct {
	Schema   string `json:"schema"`
	Name     string `json:"name"`
	Args     string `json:"args"`
	Kind     string `json:"kind"` // function | procedure | aggregate | window
	Language string `json:"language"`
	Owner    string `json:"owner"`
	Security bool   `json:"security_definer"`
}

type DBSeq struct {
	Schema    string  `json:"schema"`
	Name      string  `json:"name"`
	DataType  string  `json:"data_type"`
	LastValue string  `json:"last_value"`
	MaxValue  string  `json:"max_value"`
	UsedPct   float64 `json:"used_pct"`
	Cycle     bool    `json:"cycle"`
}

type DBFK struct {
	Table      string `json:"table"`
	Name       string `json:"name"`
	References string `json:"references"`
	Definition string `json:"definition"`
	Indexed    bool   `json:"indexed"`
}

type DBType struct {
	Schema string `json:"schema"`
	Name   string `json:"name"`
	Kind   string `json:"kind"` // enum | domain | composite | range
	Detail string `json:"detail,omitempty"`
}

type DBTrig struct {
	Table    string `json:"table"`
	Name     string `json:"name"`
	Function string `json:"function"`
	Enabled  string `json:"enabled"`
}

type TypeUse struct {
	Type    string `json:"type"`
	Columns int    `json:"columns"`
}

// Check is one line of the migration readiness list.
type Check struct {
	Status string `json:"status"` // ok | warning | info | critical
	Title  string `json:"title"`
	Detail string `json:"detail"`
}

func collectInventory(ctx context.Context, c *pgconn.PgConn, versionNum int) *Inventory {
	inv := &Inventory{Schemas: []DBSchema{}, Tables: []DBTable{}, Indexes: []DBIndex{}, Views: []DBView{},
		Functions: []DBFunc{}, Sequences: []DBSeq{}, ForeignKeys: []DBFK{}, Types: []DBType{}, Triggers: []DBTrig{},
		ForeignSrv: []string{}, ColumnTypes: []TypeUse{}, Checks: []Check{}}
	part := func(what string, err error) {
		if err != nil {
			inv.Partial = append(inv.Partial, what+": "+friendlyErr(err))
		}
	}
	rows := func(what, sql string) [][]string {
		r, err := q(ctx, c, sql)
		part(what, err)
		return r
	}

	// database settings (version-safe: newer columns through to_jsonb)
	for _, v := range rows("database", `select coalesce(to_jsonb(d)->>'datcollate', ''), coalesce(to_jsonb(d)->>'datctype', ''),
		coalesce(to_jsonb(d)->>'datlocprovider', 'c'), d.datconnlimit, t.spcname, age(d.datfrozenxid)
		from pg_database d join pg_tablespace t on t.oid = d.dattablespace where d.datname = current_database()`) {
		inv.Collation, inv.CType, inv.ConnLimit, inv.Tablespace, inv.XIDAge = v[0], v[1], atoi(v[3]), v[4], atoi(v[5])
		inv.LocaleProv = map[string]string{"c": "libc", "i": "ICU", "b": "builtin"}[v[2]]
	}

	// tables (biggest first)
	for _, v := range rows("tables", `select n.nspname, c.relname, c.relkind, c.relispartition, c.relpersistence = 'u',
		greatest(c.reltuples, coalesce(s.n_live_tup, 0)), pg_total_relation_size(c.oid), pg_relation_size(c.oid),
		pg_indexes_size(c.oid), coalesce(pg_total_relation_size(nullif(c.reltoastrelid, 0)), 0),
		(select count(*) from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped),
		exists (select 1 from pg_constraint k where k.conrelid = c.oid and k.contype = 'p'), c.relreplident,
		coalesce(s.n_dead_tup, 0), coalesce(s.seq_scan, 0), coalesce(s.idx_scan, 0),
		coalesce(greatest(s.last_vacuum, s.last_autovacuum)::text, ''), coalesce(greatest(s.last_analyze, s.last_autoanalyze)::text, ''),
		pg_get_userbyid(c.relowner), coalesce(t.spcname, '')
		from pg_class c join pg_namespace n on n.oid = c.relnamespace
		left join pg_stat_user_tables s on s.relid = c.oid left join pg_tablespace t on t.oid = c.reltablespace
		where c.relkind in ('r', 'p') and `+excludedNsps+`
		order by pg_total_relation_size(c.oid) desc, 1, 2 limit `+fmt.Sprint(maxTables+1)) {
		kind := "table"
		if v[2] == "p" {
			kind = "partitioned"
		} else if tb(v[3]) {
			kind = "partition"
		}
		inv.Tables = append(inv.Tables, DBTable{Schema: v[0], Name: v[1], Kind: kind, Unlogged: tb(v[4]), Rows: max(0, atof(v[5])),
			TotalBytes: atof(v[6]), TableBytes: atof(v[7]), IndexBytes: atof(v[8]), ToastBytes: atof(v[9]), Columns: atoi(v[10]),
			PrimaryKey: tb(v[11]), ReplIdent: map[string]string{"d": "default", "i": "index", "f": "full", "n": "nothing"}[v[12]],
			DeadRows: atof(v[13]), SeqScans: atof(v[14]), IdxScans: atof(v[15]), LastVacuum: v[16], LastAnalyze: v[17],
			Owner: v[18], Tablespace: v[19]})
	}
	if len(inv.Tables) > maxTables {
		inv.Tables = inv.Tables[:maxTables]
		inv.Truncated = append(inv.Truncated, fmt.Sprintf("tables: the %d biggest are listed", maxTables))
	}

	// indexes
	for _, v := range rows("indexes", `select n.nspname, t.relname, i.relname, am.amname, pg_relation_size(i.oid),
		x.indisunique, x.indisprimary, x.indisvalid, coalesce(s.idx_scan, 0), pg_get_indexdef(i.oid)
		from pg_index x join pg_class i on i.oid = x.indexrelid join pg_class t on t.oid = x.indrelid
		join pg_namespace n on n.oid = t.relnamespace join pg_am am on am.oid = i.relam
		left join pg_stat_user_indexes s on s.indexrelid = i.oid
		where `+excludedNsps+` order by pg_relation_size(i.oid) desc, 1, 2, 3 limit `+fmt.Sprint(maxIndexes+1)) {
		inv.Indexes = append(inv.Indexes, DBIndex{Schema: v[0], Table: v[1], Name: v[2], Method: v[3], SizeBytes: atof(v[4]),
			Unique: tb(v[5]), Primary: tb(v[6]), Valid: tb(v[7]), Scans: atof(v[8]), Definition: v[9]})
	}
	if len(inv.Indexes) > maxIndexes {
		inv.Indexes = inv.Indexes[:maxIndexes]
		inv.Truncated = append(inv.Truncated, fmt.Sprintf("indexes: the %d biggest are listed", maxIndexes))
	}

	// schemas
	for _, v := range rows("schemas", `select n.nspname, pg_get_userbyid(n.nspowner),
		count(c.oid) filter (where c.relkind in ('r', 'p')),
		coalesce(sum(pg_total_relation_size(c.oid)) filter (where c.relkind in ('r', 'm')), 0)
		from pg_namespace n left join pg_class c on c.relnamespace = n.oid
		where `+excludedNsps+` group by 1, 2 order by 1`) {
		inv.Schemas = append(inv.Schemas, DBSchema{Name: v[0], Owner: v[1], Tables: atoi(v[2]), SizeBytes: atof(v[3])})
	}

	// views and materialized views
	for _, v := range rows("views", `select n.nspname, c.relname, c.relkind = 'm', c.relispopulated,
		pg_total_relation_size(c.oid), pg_get_userbyid(c.relowner)
		from pg_class c join pg_namespace n on n.oid = c.relnamespace
		where c.relkind in ('v', 'm') and `+excludedNsps+`
		and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
		order by 1, 2 limit `+fmt.Sprint(maxObjects)) {
		inv.Views = append(inv.Views, DBView{Schema: v[0], Name: v[1], Materialized: tb(v[2]), Populated: tb(v[3]),
			SizeBytes: atof(v[4]), Owner: v[5]})
	}

	// functions and procedures (not the ones that belong to extensions)
	for _, v := range rows("functions", `select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid),
		coalesce(to_jsonb(p)->>'prokind', 'f'), l.lanname, pg_get_userbyid(p.proowner), p.prosecdef
		from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
		where `+excludedNsps+` and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
		order by 1, 2 limit `+fmt.Sprint(maxObjects)) {
		kind := map[string]string{"f": "function", "p": "procedure", "a": "aggregate", "w": "window"}[v[3]]
		inv.Functions = append(inv.Functions, DBFunc{Schema: v[0], Name: v[1], Args: v[2], Kind: kind, Language: v[4], Owner: v[5], Security: tb(v[6])})
	}

	// sequences (last_value is empty when never used or not readable)
	if versionNum >= 100000 {
		for _, v := range rows("sequences", `select schemaname, sequencename, data_type::text, coalesce(last_value::text, ''),
			max_value::text, coalesce(round(100.0 * last_value / nullif(max_value, 0), 2), 0), cycle
			from pg_sequences where schemaname not in ('pg_catalog', 'information_schema') order by 6 desc, 1, 2 limit `+fmt.Sprint(maxObjects)) {
			inv.Sequences = append(inv.Sequences, DBSeq{Schema: v[0], Name: v[1], DataType: v[2], LastValue: v[3], MaxValue: v[4],
				UsedPct: atof(v[5]), Cycle: tb(v[6])})
		}
	}

	// foreign keys, and whether an index starts with their columns (else deletes on the parent scan the child)
	for _, v := range rows("foreign keys", `select c.conrelid::regclass::text, c.conname, c.confrelid::regclass::text,
		pg_get_constraintdef(c.oid),
		exists (select 1 from pg_index i where i.indrelid = c.conrelid
		        and (string_to_array(i.indkey::text, ' ')::int2[])[1:array_length(c.conkey, 1)] @> c.conkey
		        and c.conkey @> (string_to_array(i.indkey::text, ' ')::int2[])[1:array_length(c.conkey, 1)])
		from pg_constraint c join pg_namespace n on n.oid = c.connamespace
		where c.contype = 'f' and `+excludedNsps+` order by 1, 2 limit `+fmt.Sprint(maxObjects)) {
		inv.ForeignKeys = append(inv.ForeignKeys, DBFK{Table: v[0], Name: v[1], References: v[2], Definition: v[3], Indexed: tb(v[4])})
	}

	// own types: enums, domains, composites, ranges
	for _, v := range rows("types", `select n.nspname, t.typname, t.typtype,
		case t.typtype when 'e' then (select string_agg(e.enumlabel, ', ' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid)
		               when 'd' then format_type(t.typbasetype, t.typtypmod) else '' end
		from pg_type t join pg_namespace n on n.oid = t.typnamespace
		where t.typtype in ('e', 'd', 'c', 'r') and `+excludedNsps+`
		and (t.typtype <> 'c' or (select relkind from pg_class where oid = t.typrelid) = 'c')
		and not exists (select 1 from pg_depend d where d.objid = t.oid and d.deptype = 'e')
		order by 1, 2 limit `+fmt.Sprint(maxObjects)) {
		inv.Types = append(inv.Types, DBType{Schema: v[0], Name: v[1],
			Kind: map[string]string{"e": "enum", "d": "domain", "c": "composite", "r": "range"}[v[2]], Detail: v[3]})
	}

	// triggers written by users (not the internal ones behind foreign keys)
	for _, v := range rows("triggers", `select tg.tgrelid::regclass::text, tg.tgname, p.proname,
		case tg.tgenabled when 'O' then 'enabled' when 'D' then 'disabled' when 'R' then 'replica' when 'A' then 'always' end
		from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid join pg_class c on c.oid = tg.tgrelid
		join pg_namespace n on n.oid = c.relnamespace
		where not tg.tgisinternal and `+excludedNsps+` order by 1, 2 limit `+fmt.Sprint(maxObjects)) {
		inv.Triggers = append(inv.Triggers, DBTrig{Table: v[0], Name: v[1], Function: v[2], Enabled: v[3]})
	}

	// foreign data wrappers
	for _, v := range rows("foreign servers", `select s.srvname || ' (' || w.fdwname || ')' from pg_foreign_server s
		join pg_foreign_data_wrapper w on w.oid = s.srvfdw order by 1`) {
		inv.ForeignSrv = append(inv.ForeignSrv, v[0])
	}

	// which column types are used (what the target must support)
	for _, v := range rows("column types", `select format_type(a.atttypid, null), count(*)
		from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
		where c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped and `+excludedNsps+`
		group by 1 order by 2 desc limit 60`) {
		inv.ColumnTypes = append(inv.ColumnTypes, TypeUse{Type: v[0], Columns: atoi(v[1])})
	}

	// counts (full, not limited by the lists above)
	if r := rows("counts", `select
		(select count(*) from pg_namespace n where `+excludedNsps+`),
		(select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'r' and not c.relispartition and `+excludedNsps+`),
		(select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'p' and `+excludedNsps+`),
		(select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relispartition and c.relkind in ('r', 'p') and `+excludedNsps+`),
		(select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('i', 'I') and `+excludedNsps+`),
		(select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'v' and `+excludedNsps+`
		   and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')),
		(select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'm' and `+excludedNsps+`
		   and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')),
		(select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where `+excludedNsps+` and coalesce(to_jsonb(p)->>'prokind', 'f') <> 'p'
		   and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')),
		(select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where `+excludedNsps+` and coalesce(to_jsonb(p)->>'prokind', 'f') = 'p'),
		(select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'S' and `+excludedNsps+`),
		(select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and `+excludedNsps+`),
		(select count(*) from pg_constraint c join pg_namespace n on n.oid = c.connamespace where c.contype = 'f' and `+excludedNsps+`),
		(select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'f' and `+excludedNsps+`),
		(select count(*) from pg_type t join pg_namespace n on n.oid = t.typnamespace where t.typtype in ('e', 'd', 'r') and `+excludedNsps+`
		   and not exists (select 1 from pg_depend d where d.objid = t.oid and d.deptype = 'e')),
		(select count(*) from pg_largeobject_metadata),
		(select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r', 'p') and c.relpersistence = 'u' and `+excludedNsps+`),
		(select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'r' and `+excludedNsps+`
		   and not exists (select 1 from pg_constraint k where k.conrelid = c.oid and k.contype = 'p')),
		(select count(*) from pg_event_trigger),
		(select count(*) from pg_publication)`); len(r) == 1 {
		v := r[0]
		inv.Counts = DBCounts{Schemas: atoi(v[0]), Tables: atoi(v[1]), PartitionedTables: atoi(v[2]), Partitions: atoi(v[3]),
			Indexes: atoi(v[4]), Views: atoi(v[5]), MatViews: atoi(v[6]), Functions: atoi(v[7]), Procedures: atoi(v[8]),
			Sequences: atoi(v[9]), Triggers: atoi(v[10]), ForeignKeys: atoi(v[11]), ForeignTables: atoi(v[12]), Types: atoi(v[13]),
			LargeObjects: atoi(v[14]), UnloggedTables: atoi(v[15]), NoPrimaryKey: atoi(v[16]), EventTriggers: atoi(v[17]),
			Publications: atoi(v[18])}
	}

	for _, t := range inv.Tables {
		if t.Kind != "partitioned" {
			inv.TotalRowsEst += t.Rows
			inv.UserDataBytes += t.TotalBytes
		}
	}
	if len(inv.Tables) > 0 {
		t := inv.Tables[0]
		inv.LargestTable = t.Schema + "." + t.Name
	}
	inv.Checks = readiness(inv)
	return inv
}

func names(list []string, max int) string {
	sort.Strings(list)
	if len(list) > max {
		return strings.Join(list[:max], ", ") + fmt.Sprintf(" and %d more", len(list)-max)
	}
	return strings.Join(list, ", ")
}

// readiness: what to know before moving this database (dump/restore, logical replication or an upgrade).
func readiness(inv *Inventory) []Check {
	var out []Check
	add := func(status, title, detail string) {
		out = append(out, Check{Status: status, Title: title, Detail: detail})
	}

	var noKey, unlogged, noIdent []string
	for _, t := range inv.Tables {
		name := t.Schema + "." + t.Name
		if t.Kind != "partitioned" && !t.PrimaryKey {
			noKey = append(noKey, name)
			if t.ReplIdent == "default" || t.ReplIdent == "nothing" {
				noIdent = append(noIdent, name)
			}
		}
		if t.Unlogged {
			unlogged = append(unlogged, name)
		}
	}
	if len(noIdent) > 0 {
		add("critical", plural(len(noIdent), "table has", "tables have")+" no primary key and no replica identity",
			"With logical replication their UPDATEs and DELETEs fail on the source. Add a primary key, or REPLICA IDENTITY FULL / USING INDEX: "+names(noIdent, 8))
	} else if len(noKey) > 0 {
		add("warning", plural(len(noKey), "table has", "tables have")+" no primary key", "They use another replica identity; check it is unique: "+names(noKey, 8))
	} else if len(inv.Tables) > 0 {
		add("ok", "Every table has a primary key", "Ready for logical replication.")
	}
	if len(unlogged) > 0 {
		add("warning", plural(len(unlogged), "unlogged table", "unlogged tables"), "Not replicated (neither streaming nor logical) and emptied after a crash: "+names(unlogged, 8))
	}
	if n := inv.Counts.LargeObjects; n > 0 {
		add("warning", plural(n, "large object", "large objects"), "Logical replication does not copy large objects; use pg_dump (with blobs) for them.")
	}
	if n := inv.Counts.Sequences; n > 0 {
		add("info", plural(n, "sequence", "sequences"), "Logical replication does not copy sequence values: set them on the target (setval) at cut-over.")
	}
	for _, s := range inv.Sequences {
		if s.UsedPct >= 75 && !s.Cycle {
			add("critical", fmt.Sprintf("Sequence %s.%s is %.0f%% used", s.Schema, s.Name, s.UsedPct),
				fmt.Sprintf("Last value %s of %s (%s). Move it to bigint before it runs out.", s.LastValue, s.MaxValue, s.DataType))
		}
	}
	if n := inv.Counts.MatViews; n > 0 {
		add("info", plural(n, "materialized view", "materialized views"), "Their contents are not replicated logically: REFRESH them on the target.")
	}
	if n := inv.Counts.ForeignTables; n > 0 || len(inv.ForeignSrv) > 0 {
		add("warning", plural(n, "foreign table", "foreign tables"), "They point at other systems ("+names(inv.ForeignSrv, 5)+"); the target needs the same FDW and network access.")
	}
	if n := inv.Counts.EventTriggers; n > 0 {
		add("info", plural(n, "event trigger", "event triggers"), "Recreate them on the target; check they don't block DDL during the restore.")
	}
	if n := inv.Counts.Triggers; n > 0 {
		add("info", plural(n, "trigger", "triggers"), "Triggers don't fire for rows applied by logical replication unless set ENABLE REPLICA/ALWAYS.")
	}
	var untrusted, secdef []string
	for _, f := range inv.Functions {
		switch f.Language {
		case "sql", "plpgsql", "internal", "c":
		default:
			untrusted = appendOnce(untrusted, f.Language)
		}
		if f.Security {
			secdef = append(secdef, f.Schema+"."+f.Name)
		}
	}
	if len(untrusted) > 0 {
		add("warning", "Procedural languages: "+strings.Join(untrusted, ", "), "The target needs these languages (and their libraries) installed.")
	}
	if len(secdef) > 0 {
		add("info", plural(len(secdef), "SECURITY DEFINER function", "SECURITY DEFINER functions"), "They run as their owner: create the owner roles first. "+names(secdef, 5))
	}
	var spaces []string
	for _, t := range inv.Tables {
		if t.Tablespace != "" {
			spaces = appendOnce(spaces, t.Tablespace)
		}
	}
	if inv.Tablespace != "" && inv.Tablespace != "pg_default" {
		spaces = appendOnce(spaces, inv.Tablespace)
	}
	if len(spaces) > 0 {
		add("warning", "Tablespaces: "+strings.Join(spaces, ", "), "The target needs the same tablespaces (or restore with --no-tablespaces).")
	}
	stable := map[string]bool{"": true, "C": true, "POSIX": true, "C.UTF-8": true, "C.utf8": true, "ucs_basic": true}
	if inv.LocaleProv == "ICU" || !stable[inv.Collation] {
		add("info", "Collation "+inv.Collation+" ("+inv.LocaleProv+")",
			"Text indexes depend on the OS / ICU collation version: after moving to a different OS, REINDEX text indexes.")
	}
	var unindexed []string
	for _, f := range inv.ForeignKeys {
		if !f.Indexed {
			unindexed = append(unindexed, f.Table+"."+f.Name)
		}
	}
	if len(unindexed) > 0 {
		add("info", plural(len(unindexed), "foreign key", "foreign keys")+" without an index", "Deletes on the parent table scan the child; worth an index: "+names(unindexed, 5))
	}
	var invalid []string
	for _, i := range inv.Indexes {
		if !i.Valid {
			invalid = append(invalid, i.Schema+"."+i.Name)
		}
	}
	if len(invalid) > 0 {
		add("warning", plural(len(invalid), "invalid index", "invalid indexes"), "Left behind by a failed CREATE INDEX CONCURRENTLY; drop or rebuild: "+names(invalid, 5))
	}
	if inv.XIDAge > 1_000_000_000 {
		add("critical", fmt.Sprintf("Transaction ID age %d", inv.XIDAge), "Close to wraparound: VACUUM FREEZE before anything else.")
	} else if inv.XIDAge > 200_000_000 {
		add("warning", fmt.Sprintf("Transaction ID age %d", inv.XIDAge), "Autovacuum is behind on freezing; check long transactions and autovacuum settings.")
	}
	if inv.Counts.Publications > 0 {
		add("info", plural(inv.Counts.Publications, "publication", "publications"), "This database already sends data by logical replication.")
	}
	order := map[string]int{"critical": 0, "warning": 1, "info": 2, "ok": 3}
	sort.SliceStable(out, func(i, j int) bool { return order[out[i].Status] < order[out[j].Status] })
	return out
}
