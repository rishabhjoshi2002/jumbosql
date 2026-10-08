/**
 * pg_genin Discover: ready-made read-only queries for a migration review. Each runs in a READ ONLY
 * transaction on the server and database picked in the query panel.
 */
export type SuggestedQuery = { group: string; title: string; sql: string; help?: string };

export const SUGGESTED_QUERIES: SuggestedQuery[] = [
  // ---------------------------------------------------------------- size and objects
  {
    group: 'Size and objects',
    title: 'Database sizes on this server',
    sql: `SELECT datname AS database, pg_size_pretty(pg_database_size(datname)) AS size, pg_database_size(datname) AS bytes,
       pg_encoding_to_char(encoding) AS encoding, datcollate AS collation
FROM pg_database WHERE datallowconn ORDER BY bytes DESC`,
  },
  {
    group: 'Size and objects',
    title: 'Size per schema',
    sql: `SELECT n.nspname AS schema, count(*) FILTER (WHERE c.relkind IN ('r','p')) AS tables,
       pg_size_pretty(sum(pg_total_relation_size(c.oid)) FILTER (WHERE c.relkind IN ('r','m'))) AS size
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast'
GROUP BY 1 ORDER BY sum(pg_total_relation_size(c.oid)) FILTER (WHERE c.relkind IN ('r','m')) DESC NULLS LAST`,
  },
  {
    group: 'Size and objects',
    title: 'Largest 50 tables (data, indexes, TOAST)',
    sql: `SELECT n.nspname || '.' || c.relname AS table_name, c.reltuples::bigint AS rows_estimate,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total, pg_size_pretty(pg_relation_size(c.oid)) AS data,
       pg_size_pretty(pg_indexes_size(c.oid)) AS indexes,
       pg_size_pretty(coalesce(pg_total_relation_size(nullif(c.reltoastrelid, 0)), 0)) AS toast
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','p','m') AND n.nspname NOT IN ('pg_catalog','information_schema')
ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 50`,
  },
  {
    group: 'Size and objects',
    title: 'Object count by type',
    sql: `SELECT CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned table' WHEN 'i' THEN 'index'
       WHEN 'I' THEN 'partitioned index' WHEN 'S' THEN 'sequence' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view'
       WHEN 'f' THEN 'foreign table' WHEN 'c' THEN 'composite type' WHEN 't' THEN 'TOAST table' END AS kind,
       count(*) AS objects
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname NOT IN ('pg_catalog','information_schema') GROUP BY 1 ORDER BY 2 DESC`,
  },
  // ---------------------------------------------------------------- migration readiness
  {
    group: 'Migration readiness',
    title: 'Tables without a primary key',
    sql: `SELECT n.nspname || '.' || c.relname AS table_name, c.reltuples::bigint AS rows_estimate,
       CASE c.relreplident WHEN 'd' THEN 'default' WHEN 'i' THEN 'index' WHEN 'f' THEN 'full' ELSE 'nothing' END AS replica_identity,
       EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisunique) AS has_unique_index
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast'
  AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'p')
ORDER BY 2 DESC`,
  },
  {
    group: 'Migration readiness',
    title: 'Installed extensions and versions',
    sql: `SELECT e.extname AS extension, e.extversion AS installed, a.default_version AS available, n.nspname AS schema
FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
LEFT JOIN pg_available_extensions a ON a.name = e.extname ORDER BY 1`,
  },
  {
    group: 'Migration readiness',
    title: 'Column data types in use',
    sql: `SELECT format_type(a.atttypid, a.atttypmod) AS data_type, count(*) AS columns,
       string_agg(DISTINCT c.relname, ', ') FILTER (WHERE a.atttypid NOT IN ('int4'::regtype,'int8'::regtype,'text'::regtype,'bool'::regtype)) AS tables_sample
FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped AND n.nspname NOT IN ('pg_catalog','information_schema')
GROUP BY 1 ORDER BY 2 DESC`,
  },
  {
    group: 'Migration readiness',
    title: 'Sequences and how full they are',
    sql: `SELECT schemaname || '.' || sequencename AS sequence, data_type, last_value, max_value,
       round(100.0 * last_value / nullif(max_value, 0), 4) AS used_pct, cycle
FROM pg_sequences ORDER BY used_pct DESC NULLS LAST`,
  },
  {
    group: 'Migration readiness',
    title: 'Large objects',
    sql: `SELECT count(*) AS large_objects, pg_size_pretty(pg_total_relation_size('pg_largeobject')) AS size FROM pg_largeobject_metadata`,
  },
  {
    group: 'Migration readiness',
    title: 'Unlogged and temporary-style tables',
    sql: `SELECT n.nspname || '.' || c.relname AS table_name, pg_size_pretty(pg_total_relation_size(c.oid)) AS size
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','p') AND c.relpersistence = 'u' ORDER BY pg_total_relation_size(c.oid) DESC`,
  },
  {
    group: 'Migration readiness',
    title: 'Objects owned by each role (roles needed on the target)',
    sql: `SELECT pg_get_userbyid(c.relowner) AS owner, count(*) FILTER (WHERE c.relkind IN ('r','p')) AS tables,
       count(*) FILTER (WHERE c.relkind IN ('v','m')) AS views, count(*) FILTER (WHERE c.relkind = 'S') AS sequences
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' GROUP BY 1 ORDER BY 2 DESC`,
  },
  {
    group: 'Migration readiness',
    title: 'Table privileges granted to roles',
    sql: `SELECT grantee, table_schema || '.' || table_name AS table_name, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
FROM information_schema.role_table_grants
WHERE table_schema NOT IN ('pg_catalog','information_schema') GROUP BY 1, 2 ORDER BY 1, 2`,
  },
  {
    group: 'Migration readiness',
    title: 'Functions and procedures by language',
    sql: `SELECT l.lanname AS language, count(*) AS routines, l.lanpltrusted AS trusted
FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog','information_schema') GROUP BY 1, 3 ORDER BY 2 DESC`,
  },
  {
    group: 'Migration readiness',
    title: 'Partitioned tables and their partitions',
    sql: `SELECT p.relname AS parent, c.relname AS partition, pg_get_expr(c.relpartbound, c.oid) AS bounds,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS size
FROM pg_inherits i JOIN pg_class p ON p.oid = i.inhparent JOIN pg_class c ON c.oid = i.inhrelid
WHERE p.relkind = 'p' ORDER BY 1, 2`,
  },
  // ---------------------------------------------------------------- indexes
  {
    group: 'Indexes',
    title: 'Unused indexes (never scanned since stats reset)',
    sql: `SELECT s.schemaname || '.' || s.relname AS table_name, s.indexrelname AS index, pg_size_pretty(pg_relation_size(s.indexrelid)) AS size,
       s.idx_scan AS scans, i.indisunique AS is_unique
FROM pg_stat_user_indexes s JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.idx_scan = 0 AND NOT i.indisprimary ORDER BY pg_relation_size(s.indexrelid) DESC`,
  },
  {
    group: 'Indexes',
    title: 'Duplicate indexes (same table, same columns)',
    sql: `SELECT indrelid::regclass AS table_name, array_agg(indexrelid::regclass) AS indexes,
       pg_size_pretty(sum(pg_relation_size(indexrelid))) AS total_size
FROM pg_index GROUP BY indrelid, indkey::text, coalesce(indexprs::text, ''), coalesce(indpred::text, '')
HAVING count(*) > 1 ORDER BY sum(pg_relation_size(indexrelid)) DESC`,
  },
  {
    group: 'Indexes',
    title: 'Foreign keys without an index',
    sql: `SELECT c.conrelid::regclass AS table_name, c.conname AS foreign_key, pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c WHERE c.contype = 'f' AND NOT EXISTS (
  SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid
   AND (string_to_array(i.indkey::text, ' ')::int2[])[1:array_length(c.conkey, 1)] @> c.conkey)
ORDER BY 1`,
  },
  {
    group: 'Indexes',
    title: 'Invalid indexes',
    sql: `SELECT indexrelid::regclass AS index, indrelid::regclass AS table_name FROM pg_index WHERE NOT indisvalid`,
  },
  // ---------------------------------------------------------------- health
  {
    group: 'Health',
    title: 'Table bloat (dead rows) and vacuum status',
    sql: `SELECT schemaname || '.' || relname AS table_name, n_live_tup AS live_rows, n_dead_tup AS dead_rows,
       round(100.0 * n_dead_tup / nullif(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
       greatest(last_vacuum, last_autovacuum) AS last_vacuum, greatest(last_analyze, last_autoanalyze) AS last_analyze
FROM pg_stat_user_tables ORDER BY n_dead_tup DESC LIMIT 50`,
  },
  {
    group: 'Health',
    title: 'Transaction ID age per database (wraparound)',
    sql: `SELECT datname AS database, age(datfrozenxid) AS xid_age,
       round(100.0 * age(datfrozenxid) / 2000000000, 1) AS pct_to_wraparound
FROM pg_database ORDER BY 2 DESC`,
  },
  {
    group: 'Health',
    title: 'Cache hit ratio per database',
    sql: `SELECT datname AS database, round(100.0 * blks_hit / nullif(blks_hit + blks_read, 0), 2) AS cache_hit_pct,
       xact_commit, xact_rollback, deadlocks, temp_files, pg_size_pretty(temp_bytes) AS temp_size
FROM pg_stat_database WHERE datname IS NOT NULL ORDER BY 1`,
  },
  {
    group: 'Health',
    title: 'Settings changed from the default',
    sql: `SELECT name, setting, unit, source, sourcefile FROM pg_settings
WHERE source NOT IN ('default', 'override', 'client') ORDER BY name`,
  },
  // ---------------------------------------------------------------- activity
  {
    group: 'Activity',
    title: 'Connections by user, database and application',
    sql: `SELECT usename AS user_name, datname AS database, application_name, client_addr, state, count(*) AS connections
FROM pg_stat_activity WHERE backend_type = 'client backend' GROUP BY 1, 2, 3, 4, 5 ORDER BY 6 DESC`,
  },
  {
    group: 'Activity',
    title: 'Running queries (longest first)',
    sql: `SELECT pid, usename AS user_name, datname AS database, state, now() - query_start AS running_for,
       wait_event_type, wait_event, left(query, 200) AS query
FROM pg_stat_activity WHERE state <> 'idle' AND pid <> pg_backend_pid() ORDER BY query_start NULLS LAST`,
  },
  {
    group: 'Activity',
    title: 'Locks that are waiting',
    sql: `SELECT a.pid, a.usename AS user_name, l.mode, l.locktype, l.relation::regclass AS relation,
       pg_blocking_pids(a.pid) AS blocked_by, left(a.query, 160) AS query
FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE NOT l.granted`,
  },
  {
    group: 'Activity',
    title: 'Top 25 statements by total time (pg_stat_statements)',
    help: 'Needs the pg_stat_statements extension in this database.',
    sql: `SELECT round(total_exec_time::numeric, 1) AS total_ms, calls, round(mean_exec_time::numeric, 2) AS mean_ms, rows,
       left(query, 200) AS query
FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 25`,
  },
  // ---------------------------------------------------------------- replication
  {
    group: 'Replication',
    title: 'Replication connections (on a primary)',
    sql: `SELECT application_name, client_addr, state, sync_state,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)) AS replay_lag, replay_lag AS replay_lag_time
FROM pg_stat_replication`,
  },
  {
    group: 'Replication',
    title: 'Replication slots and the WAL they keep',
    sql: `SELECT slot_name, slot_type, database, active, wal_status,
       pg_size_pretty(pg_wal_lsn_diff(CASE WHEN pg_is_in_recovery() THEN pg_last_wal_replay_lsn() ELSE pg_current_wal_lsn() END,
                                      coalesce(confirmed_flush_lsn, restart_lsn))) AS wal_kept
FROM pg_replication_slots`,
  },
  {
    group: 'Replication',
    title: 'Publications and their tables',
    sql: `SELECT p.pubname AS publication, p.puballtables AS all_tables, t.schemaname || '.' || t.tablename AS table_name
FROM pg_publication p LEFT JOIN pg_publication_tables t ON t.pubname = p.pubname ORDER BY 1, 3`,
  },
  {
    group: 'Replication',
    title: 'Subscriptions and their state (on a subscriber)',
    sql: `SELECT s.subname AS subscription, s.subenabled AS enabled, w.received_lsn, w.latest_end_time, w.last_msg_receipt_time
FROM pg_subscription s LEFT JOIN pg_stat_subscription w ON w.subid = s.oid`,
  },
  {
    group: 'Replication',
    title: 'Standby: receive and replay status',
    sql: `SELECT pg_is_in_recovery() AS is_standby, pg_last_wal_receive_lsn() AS received, pg_last_wal_replay_lsn() AS replayed,
       now() - pg_last_xact_replay_timestamp() AS replay_delay`,
  },
  // ---------------------------------------------------------------- users
  {
    group: 'Users and security',
    title: 'Roles and their attributes',
    sql: `SELECT rolname AS role, rolsuper AS superuser, rolcreaterole AS createrole, rolcreatedb AS createdb, rolcanlogin AS login,
       rolreplication AS replication, rolbypassrls AS bypass_rls, rolconnlimit AS conn_limit, rolvaliduntil AS valid_until,
       ARRAY(SELECT b.rolname FROM pg_auth_members m JOIN pg_roles b ON b.oid = m.roleid WHERE m.member = r.oid) AS member_of
FROM pg_roles r WHERE rolname !~ '^pg_' ORDER BY 1`,
  },
  {
    group: 'Users and security',
    title: 'Row-level security policies',
    sql: `SELECT schemaname || '.' || tablename AS table_name, policyname, permissive, roles, cmd, qual, with_check FROM pg_policies ORDER BY 1, 2`,
  },
  {
    group: 'Users and security',
    title: 'SSL connections',
    sql: `SELECT a.usename AS user_name, a.client_addr, s.ssl, s.version, s.cipher
FROM pg_stat_ssl s JOIN pg_stat_activity a ON a.pid = s.pid WHERE a.backend_type = 'client backend'`,
  },
];
