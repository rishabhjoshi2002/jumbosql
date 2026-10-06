package insights

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"postgresql-cluster-console/internal/storage"

	"github.com/jackc/pgx/v5/pgconn"
)

// rows runs one query (simple protocol, text results).
func rows(ctx context.Context, conn *pgconn.PgConn, sql string) ([][]string, error) {
	res, err := conn.Exec(ctx, sql).ReadAll()
	if err != nil {
		return nil, err
	}
	var out [][]string
	for _, r := range res {
		if r.Err != nil {
			return nil, r.Err
		}
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

func num(s string) float64 {
	v, _ := strconv.ParseFloat(strings.TrimSpace(s), 64)
	return v
}

/* --------------------------------------------------------------- sampled (collector) --------------------------------------------------------------- */

// Metric names stored in metric_samples.
const (
	MClusterSize       = "cluster.size_bytes"
	MConnections       = "cluster.connections"
	MConnectionsActive = "cluster.connections_active"
	MMaxConnections    = "cluster.max_connections"
	MXact              = "cluster.xact"        // commits + rollbacks (counter)
	MRollbacks         = "cluster.rollbacks"   // counter
	MTupWritten        = "cluster.tup_written" // inserted + updated + deleted (counter)
	MTupFetched        = "cluster.tup_fetched" // counter
	MBlksHit           = "cluster.blks_hit"    // counter
	MBlksRead          = "cluster.blks_read"   // counter
	MTempBytes         = "cluster.temp_bytes"  // counter
	MDeadlocks         = "cluster.deadlocks"   // counter
	MDBSize            = "db.size_bytes"
	MDBXact            = "db.xact" // counter
	MTableSize         = "table.size_bytes"
	MTableDead         = "table.dead_tup"
	MTableLive         = "table.live_tup"
)

// sampleCluster: cluster-wide and per-database numbers, from the "postgres" database. Returns the databases.
func sampleCluster(ctx context.Context, conn *pgconn.PgConn, at time.Time) ([]storage.MetricSample, []string, error) {
	rs, err := rows(ctx, conn, `select d.datname, pg_database_size(d.oid), s.xact_commit + s.xact_rollback, s.xact_rollback,
	       s.tup_inserted + s.tup_updated + s.tup_deleted, s.tup_fetched, s.blks_hit, s.blks_read, s.temp_bytes, s.deadlocks
	  from pg_database d join pg_stat_database s on s.datid = d.oid
	 where d.datallowconn and not d.datistemplate order by 2 desc`)
	if err != nil {
		return nil, nil, err
	}
	var out []storage.MetricSample
	add := func(metric, key string, v float64) {
		out = append(out, storage.MetricSample{At: at, Metric: metric, Key: key, Value: v})
	}
	var size, xact, rb, tw, tf, hit, rd, temp, dl float64
	var dbs []string
	for _, r := range rs {
		dbs = append(dbs, r[0])
		add(MDBSize, r[0], num(r[1]))
		add(MDBXact, r[0], num(r[2]))
		size += num(r[1])
		xact += num(r[2])
		rb += num(r[3])
		tw += num(r[4])
		tf += num(r[5])
		hit += num(r[6])
		rd += num(r[7])
		temp += num(r[8])
		dl += num(r[9])
	}
	add(MClusterSize, "", size)
	add(MXact, "", xact)
	add(MRollbacks, "", rb)
	add(MTupWritten, "", tw)
	add(MTupFetched, "", tf)
	add(MBlksHit, "", hit)
	add(MBlksRead, "", rd)
	add(MTempBytes, "", temp)
	add(MDeadlocks, "", dl)

	c, err := rows(ctx, conn, `select count(*), count(*) filter (where state = 'active'), current_setting('max_connections')
	  from pg_stat_activity where backend_type = 'client backend'`)
	if err == nil && len(c) == 1 {
		add(MConnections, "", num(c[0][0]))
		add(MConnectionsActive, "", num(c[0][1]))
		add(MMaxConnections, "", num(c[0][2]))
	}
	return out, dbs, nil
}

// TablesSampled per database (the biggest ones).
const TablesSampled = 30

// sampleTables: size and live / dead rows of the biggest tables of one database (key "db/schema.table").
func sampleTables(ctx context.Context, conn *pgconn.PgConn, db string, at time.Time) ([]storage.MetricSample, error) {
	rs, err := rows(ctx, conn, fmt.Sprintf(`select n.nspname || '.' || c.relname, pg_total_relation_size(c.oid),
	       coalesce(s.n_live_tup, 0), coalesce(s.n_dead_tup, 0)
	  from pg_class c join pg_namespace n on n.oid = c.relnamespace
	  left join pg_stat_user_tables s on s.relid = c.oid
	 where c.relkind in ('r', 'p', 'm') and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_toast'
	 order by 2 desc limit %d`, TablesSampled))
	if err != nil {
		return nil, err
	}
	var out []storage.MetricSample
	for _, r := range rs {
		key := db + "/" + r[0]
		out = append(out,
			storage.MetricSample{At: at, Metric: MTableSize, Key: key, Value: num(r[1])},
			storage.MetricSample{At: at, Metric: MTableLive, Key: key, Value: num(r[2])},
			storage.MetricSample{At: at, Metric: MTableDead, Key: key, Value: num(r[3])})
	}
	return out, nil
}

/* --------------------------------------------------------------- live (report) --------------------------------------------------------------- */

// Overview is the server's state right now.
type Overview struct {
	Version          string  `json:"version"`
	VersionNum       int     `json:"version_num"`
	StartedAt        string  `json:"started_at"`
	DataDirectory    string  `json:"data_directory"`
	MaxConnections   int     `json:"max_connections"`
	Connections      int     `json:"connections"`
	Active           int     `json:"active"`
	IdleInTx         int     `json:"idle_in_transaction"`
	LongRunning      int     `json:"long_running"` // active for more than 5 minutes
	LongestSeconds   float64 `json:"longest_seconds"`
	CacheHitPct      float64 `json:"cache_hit_pct"` // since the statistics were reset
	RollbackPct      float64 `json:"rollback_pct"`
	XidAgeMax        float64 `json:"xid_age_max"`
	XidAgeDatabase   string  `json:"xid_age_database"`
	FreezeMaxAge     float64 `json:"freeze_max_age"`
	ReplicationLagS  float64 `json:"replication_lag_seconds"` // max replay lag of the standbys
	Standbys         int     `json:"standbys"`
	SharedBuffers    string  `json:"shared_buffers"`
	WorkMem          string  `json:"work_mem"`
	PgStatStatements bool    `json:"pg_stat_statements"`
	TempBytes        float64 `json:"temp_bytes"`
	Deadlocks        float64 `json:"deadlocks"`
	StatsReset       string  `json:"stats_reset"`
}

func overview(ctx context.Context, conn *pgconn.PgConn) (Overview, error) {
	var o Overview
	r, err := rows(ctx, conn, `select current_setting('server_version'), current_setting('server_version_num'),
	       pg_postmaster_start_time()::text, current_setting('data_directory'), current_setting('max_connections'),
	       current_setting('shared_buffers'), current_setting('work_mem'), current_setting('autovacuum_freeze_max_age'),
	       exists (select 1 from pg_extension where extname = 'pg_stat_statements')`)
	if err != nil {
		return o, err
	}
	if len(r) == 1 {
		o.Version, o.VersionNum = r[0][0], int(num(r[0][1]))
		o.StartedAt, o.DataDirectory = r[0][2], r[0][3]
		o.MaxConnections = int(num(r[0][4]))
		o.SharedBuffers, o.WorkMem = r[0][5], r[0][6]
		o.FreezeMaxAge = num(r[0][7])
		o.PgStatStatements = r[0][8] == "t"
	}
	if r, err := rows(ctx, conn, `select count(*), count(*) filter (where state = 'active'),
	       count(*) filter (where state like 'idle in transaction%'),
	       count(*) filter (where state = 'active' and now() - query_start > interval '5 minutes'),
	       coalesce(extract(epoch from max(now() - query_start) filter (where state = 'active')), 0)
	  from pg_stat_activity where backend_type = 'client backend' and pid <> pg_backend_pid()`); err == nil && len(r) == 1 {
		o.Connections, o.Active, o.IdleInTx, o.LongRunning = int(num(r[0][0])), int(num(r[0][1])), int(num(r[0][2])), int(num(r[0][3]))
		o.LongestSeconds = num(r[0][4])
	}
	if r, err := rows(ctx, conn, `select coalesce(sum(blks_hit), 0), coalesce(sum(blks_read), 0), coalesce(sum(xact_commit), 0),
	       coalesce(sum(xact_rollback), 0), coalesce(sum(temp_bytes), 0), coalesce(sum(deadlocks), 0), coalesce(min(stats_reset)::text, '')
	  from pg_stat_database where datname is not null`); err == nil && len(r) == 1 {
		hit, rd, cm, rb := num(r[0][0]), num(r[0][1]), num(r[0][2]), num(r[0][3])
		if hit+rd > 0 {
			o.CacheHitPct = 100 * hit / (hit + rd)
		}
		if cm+rb > 0 {
			o.RollbackPct = 100 * rb / (cm + rb)
		}
		o.TempBytes, o.Deadlocks, o.StatsReset = num(r[0][4]), num(r[0][5]), r[0][6]
	}
	if r, err := rows(ctx, conn, `select datname, age(datfrozenxid) from pg_database order by 2 desc limit 1`); err == nil && len(r) == 1 {
		o.XidAgeDatabase, o.XidAgeMax = r[0][0], num(r[0][1])
	}
	if r, err := rows(ctx, conn, `select count(*), coalesce(extract(epoch from max(replay_lag)), 0) from pg_stat_replication`); err == nil && len(r) == 1 {
		o.Standbys, o.ReplicationLagS = int(num(r[0][0])), num(r[0][1])
	}
	return o, nil
}

// Table is one table's state right now (from pg_stat_user_tables).
type Table struct {
	Database         string  `json:"database"`
	Name             string  `json:"name"` // schema.table
	TotalBytes       float64 `json:"total_bytes"`
	TableBytes       float64 `json:"table_bytes"`
	IndexBytes       float64 `json:"index_bytes"`
	LiveRows         float64 `json:"live_rows"`
	DeadRows         float64 `json:"dead_rows"`
	DeadPct          float64 `json:"dead_pct"`
	BloatBytes       float64 `json:"bloat_bytes"` // estimate: table size x dead share
	SeqScans         float64 `json:"seq_scans"`
	SeqRowsRead      float64 `json:"seq_rows_read"`
	IdxScans         float64 `json:"idx_scans"`
	Writes           float64 `json:"writes"` // inserts + updates + deletes since stats reset
	LastVacuum       string  `json:"last_vacuum,omitempty"`
	LastAnalyze      string  `json:"last_analyze,omitempty"`
	ModsSinceAnalyze float64 `json:"mods_since_analyze"`
	GrowthPerDay     float64 `json:"growth_bytes_per_day"`
	In30Days         float64 `json:"in_30_days"`
	HasTrend         bool    `json:"has_trend"`
}

func liveTables(ctx context.Context, conn *pgconn.PgConn, db string, limit int) ([]Table, error) {
	rs, err := rows(ctx, conn, fmt.Sprintf(`select s.schemaname || '.' || s.relname, pg_total_relation_size(s.relid), pg_relation_size(s.relid),
	       pg_indexes_size(s.relid), s.n_live_tup, s.n_dead_tup, coalesce(s.seq_scan, 0), coalesce(s.seq_tup_read, 0),
	       coalesce(s.idx_scan, 0), s.n_tup_ins + s.n_tup_upd + s.n_tup_del,
	       coalesce(greatest(s.last_vacuum, s.last_autovacuum)::text, ''), coalesce(greatest(s.last_analyze, s.last_autoanalyze)::text, ''),
	       coalesce(s.n_mod_since_analyze, 0)
	  from pg_stat_user_tables s order by 2 desc limit %d`, limit))
	if err != nil {
		return nil, err
	}
	var out []Table
	for _, r := range rs {
		t := Table{Database: db, Name: r[0], TotalBytes: num(r[1]), TableBytes: num(r[2]), IndexBytes: num(r[3]),
			LiveRows: num(r[4]), DeadRows: num(r[5]), SeqScans: num(r[6]), SeqRowsRead: num(r[7]), IdxScans: num(r[8]),
			Writes: num(r[9]), LastVacuum: r[10], LastAnalyze: r[11], ModsSinceAnalyze: num(r[12])}
		if t.LiveRows+t.DeadRows > 0 {
			t.DeadPct = 100 * t.DeadRows / (t.LiveRows + t.DeadRows)
			t.BloatBytes = t.TableBytes * t.DeadRows / (t.LiveRows + t.DeadRows)
		}
		out = append(out, t)
	}
	return out, nil
}

// Index is an index that is never used.
type Index struct {
	Database string  `json:"database"`
	Table    string  `json:"table"`
	Name     string  `json:"name"`
	Bytes    float64 `json:"bytes"`
	Scans    float64 `json:"scans"`
}

func unusedIndexes(ctx context.Context, conn *pgconn.PgConn, db string) ([]Index, error) {
	rs, err := rows(ctx, conn, `select s.schemaname || '.' || s.relname, s.schemaname || '.' || s.indexrelname,
	       pg_relation_size(s.indexrelid), s.idx_scan
	  from pg_stat_user_indexes s join pg_index i on i.indexrelid = s.indexrelid
	 where s.idx_scan = 0 and not i.indisunique and not i.indisprimary
	 order by 3 desc limit 20`)
	if err != nil {
		return nil, err
	}
	var out []Index
	for _, r := range rs {
		out = append(out, Index{Database: db, Table: r[0], Name: r[1], Bytes: num(r[2]), Scans: num(r[3])})
	}
	return out, nil
}

// Query is one statement from pg_stat_statements.
type Query struct {
	Database string  `json:"database"`
	Query    string  `json:"query"`
	Calls    float64 `json:"calls"`
	TotalMs  float64 `json:"total_ms"`
	MeanMs   float64 `json:"mean_ms"`
	Rows     float64 `json:"rows"`
	HitPct   float64 `json:"hit_pct"`
	SharePct float64 `json:"share_pct"` // of the total execution time of all statements
}

func topQueries(ctx context.Context, conn *pgconn.PgConn, versionNum int) ([]Query, error) {
	total, mean := "total_exec_time", "mean_exec_time"
	if versionNum > 0 && versionNum < 130000 {
		total, mean = "total_time", "mean_time"
	}
	rs, err := rows(ctx, conn, fmt.Sprintf(`with s as (select * from pg_stat_statements where query not like '%%pg_stat_statements%%')
	select coalesce(d.datname, ''), left(regexp_replace(s.query, '\s+', ' ', 'g'), 600), s.calls, s.%[1]s, s.%[2]s, s.rows,
	       case when s.shared_blks_hit + s.shared_blks_read > 0 then 100.0 * s.shared_blks_hit / (s.shared_blks_hit + s.shared_blks_read) else 100 end,
	       100.0 * s.%[1]s / nullif((select sum(%[1]s) from s), 0)
	  from s left join pg_database d on d.oid = s.dbid
	 order by s.%[1]s desc limit 15`, total, mean))
	if err != nil {
		return nil, err
	}
	var out []Query
	for _, r := range rs {
		out = append(out, Query{Database: r[0], Query: r[1], Calls: num(r[2]), TotalMs: num(r[3]), MeanMs: num(r[4]),
			Rows: num(r[5]), HitPct: num(r[6]), SharePct: num(r[7])})
	}
	return out, nil
}
