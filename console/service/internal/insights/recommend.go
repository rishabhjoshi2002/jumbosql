package insights

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
)

// Recommendation is one finding with what to do about it.
type Recommendation struct {
	Severity string `json:"severity"` // critical | warning | info
	Category string `json:"category"` // storage | cpu | memory | connections | bloat | indexes | queries | maintenance | config | replication
	Title    string `json:"title"`
	Detail   string `json:"detail"`
	Action   string `json:"action,omitempty"`
	SQL      string `json:"sql,omitempty"`
}

// Thresholds of the rules (kept together so they are easy to tune).
const (
	cpuTarget         = 65.0 // size CPUs so the busy-hour (p95) load stays around this
	cpuWarn           = 75.0
	cpuCrit           = 90.0
	memWarn           = 90.0
	diskWarnDays      = 90.0
	diskCritDays      = 30.0
	connWarnPct       = 80.0
	bloatDeadPct      = 20.0
	bloatMinDeadRows  = 10000.0
	bloatFullPct      = 50.0
	bloatFullMinBytes = 1 << 30
	unusedIdxMinBytes = 10 << 20
	seqHeavyMinRows   = 100000.0
	cacheHitWarn      = 95.0
	xidWarn           = 1_000_000_000.0
	xidCrit           = 1_500_000_000.0
	rollbackWarnPct   = 5.0
	replLagWarnS      = 60.0
	analyzeStaleRatio = 0.2
)

func HumanBytes(b float64) string {
	units := []string{"B", "KB", "MB", "GB", "TB", "PB"}
	i := 0
	for math.Abs(b) >= 1024 && i < len(units)-1 {
		b /= 1024
		i++
	}
	if i == 0 {
		return fmt.Sprintf("%.0f %s", b, units[i])
	}
	return fmt.Sprintf("%.1f %s", b, units[i])
}

func quoteIdent(name string) string {
	parts := strings.SplitN(name, ".", 2)
	for i, p := range parts {
		parts[i] = `"` + strings.ReplaceAll(p, `"`, `""`) + `"`
	}
	return strings.Join(parts, ".")
}

// Recommend applies the rules to a report.
func Recommend(r *Report, now time.Time) []Recommendation {
	var out []Recommendation
	add := func(sev, cat, title, detail, action, sql string) {
		out = append(out, Recommendation{Severity: sev, Category: cat, Title: title, Detail: detail, Action: action, SQL: sql})
	}

	/* ---- storage ---- */
	for _, h := range r.Hosts {
		if h.Node == "" || h.DiskSize == 0 {
			continue
		}
		used := Last(h.DiskUsed)
		need := math.Max(h.DiskForecast.In30Days, used)
		// size so the forecast in 30 days still leaves 25 % free
		suggested := math.Ceil(need/0.75/(10<<30)) * (10 << 30)
		switch {
		case h.DaysToFull >= 0 && h.DaysToFull <= diskCritDays:
			add("critical", "storage", fmt.Sprintf("Disk on %s full in about %.0f days", h.Node, h.DaysToFull),
				fmt.Sprintf("%s of %s used on %s, growing %s per day.", HumanBytes(used), HumanBytes(h.DiskSize), h.Mount, HumanBytes(h.DiskForecast.PerDay)),
				fmt.Sprintf("Grow the volume to at least %s (keeps 25 %% free a month from now), or remove old data / WAL / logs.", HumanBytes(suggested)), "")
		case h.DaysTo80 >= 0 && h.DaysTo80 <= diskWarnDays:
			add("warning", "storage", fmt.Sprintf("Disk on %s reaches 80 %% in about %.0f days", h.Node, h.DaysTo80),
				fmt.Sprintf("%s of %s used on %s, growing %s per day.", HumanBytes(used), HumanBytes(h.DiskSize), h.Mount, HumanBytes(h.DiskForecast.PerDay)),
				fmt.Sprintf("Plan to grow the volume to about %s.", HumanBytes(suggested)), "")
		}
	}
	if f := r.Storage.Forecast; f.HasForecast && f.PerDay > 0 {
		add("info", "storage", fmt.Sprintf("Databases grow %s per day", HumanBytes(f.PerDay)),
			fmt.Sprintf("All databases together: %s now, about %s in 30 days (confidence %s, based on %.1f days of samples).",
				HumanBytes(f.Current), HumanBytes(f.In30Days), f.Confidence, f.SpanDays),
			"Storage needed next month: the 30-day forecast plus room for WAL, temporary files and VACUUM (keep 25-30 % free).", "")
	}

	/* ---- CPU / memory ---- */
	for _, h := range r.Hosts {
		if h.Node == "" || len(h.CPU) == 0 {
			continue
		}
		next := math.Max(h.CPUP95, h.CPUForecast.In30Days)
		if next >= cpuWarn {
			sev := "warning"
			if next >= cpuCrit {
				sev = "critical"
			}
			want := h.Cores
			if h.Cores > 0 {
				want = math.Ceil(h.Cores * next / cpuTarget)
			}
			detail := fmt.Sprintf("Busy-hour CPU (p95) is %.0f %% now", h.CPUP95)
			if h.CPUForecast.HasForecast && h.CPUForecast.In30Days > 100 {
				detail += fmt.Sprintf("; at the current trend (%+.1f %% per day) the load would need %.0f %% of today's CPUs in 30 days - more than the node has", h.CPUForecast.PerDay, h.CPUForecast.In30Days)
			} else if h.CPUForecast.HasForecast {
				detail += fmt.Sprintf(" and heads for %.0f %% in 30 days (trend %+.1f %% per day)", h.CPUForecast.In30Days, h.CPUForecast.PerDay)
			}
			action := "Find the heaviest statements below (Top queries) first; then add CPUs."
			if h.Cores > 0 && want > h.Cores {
				action = fmt.Sprintf("Find the heaviest statements below (Top queries) first; to keep busy hours near %.0f %%, go from %.0f to %.0f vCPUs.", cpuTarget, h.Cores, want)
			}
			add(sev, "cpu", fmt.Sprintf("CPU on %s (%s) is running hot", h.Node, h.Role), detail+".", action, "")
		}
		if h.MemP95 >= memWarn {
			add("warning", "memory", fmt.Sprintf("Memory on %s is nearly full", h.Node),
				fmt.Sprintf("Memory use (p95) %.0f %% of %s.", h.MemP95, HumanBytes(h.MemTotal)),
				"Check shared_buffers and work_mem against the RAM, and the number of connections (each uses memory); add RAM if it stays high.", "")
		}
	}

	ov := r.Overview
	/* ---- connections ---- */
	if r.Load.MaxConnections > 0 {
		peak := math.Max(r.Load.ConnPeak, r.Load.ConnForecast.In30Days)
		if ov != nil {
			peak = math.Max(peak, float64(ov.Connections))
		}
		if pct := 100 * peak / r.Load.MaxConnections; pct >= connWarnPct {
			add("warning", "connections", fmt.Sprintf("Connections near the limit (%.0f of %.0f)", peak, r.Load.MaxConnections),
				fmt.Sprintf("Busy-hour connections reach %.0f %% of max_connections.", pct),
				"Send applications through PgBouncer (port 6432) in transaction mode, or raise max_connections (needs a restart and more memory).", "")
		}
	}

	if ov != nil {
		/* ---- maintenance ---- */
		if ov.FreezeMaxAge > 0 && ov.XidAgeMax >= xidWarn {
			sev := "warning"
			if ov.XidAgeMax >= xidCrit {
				sev = "critical"
			}
			add(sev, "maintenance", fmt.Sprintf("Transaction ID age high in %s", ov.XidAgeDatabase),
				fmt.Sprintf("Oldest unfrozen transaction is %.0f million transactions old (wraparound protection starts near 2 000 million).", ov.XidAgeMax/1e6),
				"Run VACUUM FREEZE in that database at a quiet time and check that autovacuum keeps up.", "VACUUM (FREEZE, VERBOSE);")
		}
		if ov.CacheHitPct > 0 && ov.CacheHitPct < cacheHitWarn {
			add("warning", "config", fmt.Sprintf("Cache hit ratio %.1f %%", ov.CacheHitPct),
				"Many reads go to disk instead of shared_buffers / the OS cache.",
				fmt.Sprintf("shared_buffers is %s; about 25 %% of RAM is usual. More RAM helps if the hot data does not fit.", ov.SharedBuffers), "")
		}
		if ov.RollbackPct >= rollbackWarnPct {
			add("info", "queries", fmt.Sprintf("%.1f %% of transactions roll back", ov.RollbackPct),
				"A high rollback share usually means application errors or retries.", "Check the PostgreSQL logs for the errors behind them.", "")
		}
		if ov.LongRunning > 0 {
			add("warning", "queries", fmt.Sprintf("%d statement(s) running longer than 5 minutes", ov.LongRunning),
				fmt.Sprintf("The longest has been running %s.", (time.Duration(ov.LongestSeconds)*time.Second).String()),
				"Look at them in pg_stat_activity; long queries hold back VACUUM and can block others.",
				"SELECT pid, usename, now() - query_start AS running, left(query, 200) FROM pg_stat_activity\n WHERE state = 'active' AND now() - query_start > interval '5 minutes' ORDER BY running DESC;")
		}
		if ov.IdleInTx > 0 {
			add("info", "queries", fmt.Sprintf("%d session(s) idle in transaction", ov.IdleInTx),
				"Open transactions that do nothing keep locks and stop VACUUM from cleaning up.",
				"Fix the application, or set idle_in_transaction_session_timeout.", "")
		}
		if ov.Standbys > 0 && ov.ReplicationLagS >= replLagWarnS {
			add("warning", "replication", fmt.Sprintf("Replica lag %.0f seconds", ov.ReplicationLagS),
				"A standby is behind the leader; a failover now could lose those changes (asynchronous replication).",
				"Check the replica's disk and network, and long queries on the replica.", "")
		}
		if !ov.PgStatStatements {
			add("info", "queries", "Query statistics are not enabled",
				"Without pg_stat_statements the console can't show which statements use the most time.",
				"Add pg_stat_statements to shared_preload_libraries (Patroni edit-config, needs a restart), then create the extension.",
				"CREATE EXTENSION IF NOT EXISTS pg_stat_statements;")
		}
	}
	if r.Load.TempPerDay > 1<<30 && ov != nil {
		add("info", "config", fmt.Sprintf("Queries write %s of temporary files per day", HumanBytes(r.Load.TempPerDay)),
			"Sorts and hashes that don't fit in work_mem spill to disk.",
			fmt.Sprintf("work_mem is %s; raise it a little or for the heavy queries only (SET work_mem in the session).", ov.WorkMem), "")
	}
	if r.Load.DeadlocksInWindow > 0 {
		add("info", "queries", fmt.Sprintf("%.0f deadlock(s) in the last %d days", r.Load.DeadlocksInWindow, r.Days),
			"Transactions locked each other and one was cancelled.", "The PostgreSQL logs show the statements involved.", "")
	}

	/* ---- tables ---- */
	for _, t := range r.Tables.Items {
		qn := quoteIdent(t.Name)
		if t.DeadPct >= bloatDeadPct && t.DeadRows >= bloatMinDeadRows {
			sev, action, sql := "warning", "Run VACUUM (ANALYZE); if this keeps coming back, make autovacuum more aggressive for this table.",
				fmt.Sprintf("VACUUM (ANALYZE, VERBOSE) %s;", qn)
			if t.DeadPct >= bloatFullPct && t.TableBytes >= bloatFullMinBytes {
				sev = "critical"
				action = "Run VACUUM now. To give the space back to the disk, rebuild the table with pg_repack (online) or VACUUM FULL (locks the table)."
			}
			add(sev, "bloat", fmt.Sprintf("%s: %.0f %% dead rows", t.Name, t.DeadPct),
				fmt.Sprintf("%.0f dead rows, about %s of %s is wasted space (database %s). Last vacuum: %s.",
					t.DeadRows, HumanBytes(t.BloatBytes), HumanBytes(t.TableBytes), t.Database, orNever(t.LastVacuum)),
				action, sql+fmt.Sprintf("\nALTER TABLE %s SET (autovacuum_vacuum_scale_factor = 0.05);", qn))
		}
		if t.LiveRows >= seqHeavyMinRows && t.SeqScans > 0 && t.SeqScans > 10*t.IdxScans && t.SeqRowsRead/t.SeqScans > 0.5*t.LiveRows {
			add("info", "indexes", fmt.Sprintf("%s is mostly read by full scans", t.Name),
				fmt.Sprintf("%.0f sequential scans vs %.0f index scans on %.0f rows.", t.SeqScans, t.IdxScans, t.LiveRows),
				"An index on the columns used in WHERE / JOIN probably helps; check the queries with EXPLAIN.", "")
		}
		if t.LiveRows > 1000 && t.ModsSinceAnalyze > analyzeStaleRatio*t.LiveRows && t.ModsSinceAnalyze > 50000 {
			add("info", "maintenance", fmt.Sprintf("%s: statistics out of date", t.Name),
				fmt.Sprintf("%.0f rows changed since the last ANALYZE (%s).", t.ModsSinceAnalyze, orNever(t.LastAnalyze)),
				"Run ANALYZE so the planner sees the new data.", fmt.Sprintf("ANALYZE %s;", qn))
		}
	}
	// fastest growing tables
	grow := append([]Table(nil), r.Tables.Items...)
	sort.Slice(grow, func(i, j int) bool { return grow[i].GrowthPerDay > grow[j].GrowthPerDay })
	for i, t := range grow {
		if i >= 3 || !t.HasTrend || t.GrowthPerDay < 100<<20 {
			break
		}
		add("info", "storage", fmt.Sprintf("%s grows %s per day", t.Name, HumanBytes(t.GrowthPerDay)),
			fmt.Sprintf("%s now, about %s in 30 days.", HumanBytes(t.TotalBytes), HumanBytes(t.In30Days)),
			"If old rows are not needed, archive them or partition the table by date.", "")
	}
	for _, ix := range r.UnusedIndexes {
		if ix.Bytes < unusedIdxMinBytes {
			continue
		}
		add("info", "indexes", fmt.Sprintf("Unused index %s (%s)", ix.Name, HumanBytes(ix.Bytes)),
			fmt.Sprintf("Never used since the statistics were reset, on %s. It still slows down every write.", ix.Table),
			"Check it isn't needed on a replica or for a rare report, then drop it.",
			fmt.Sprintf("DROP INDEX CONCURRENTLY %s;", quoteIdent(ix.Name)))
	}

	/* ---- top queries ---- */
	for i, q := range r.Queries {
		if i >= 2 || q.SharePct < 30 {
			break
		}
		add("info", "queries", fmt.Sprintf("One statement uses %.0f %% of all query time", q.SharePct),
			fmt.Sprintf("%.0f calls, %.1f ms on average: %s", q.Calls, q.MeanMs, truncate(q.Query, 160)),
			"Tune this statement first (EXPLAIN ANALYZE, an index, fewer calls) - it gives the most back.", "")
	}

	rank := map[string]int{"critical": 0, "warning": 1, "info": 2}
	sort.SliceStable(out, func(i, j int) bool { return rank[out[i].Severity] < rank[out[j].Severity] })
	return out
}

func orNever(s string) string {
	if s == "" {
		return "never"
	}
	if t, err := time.Parse("2006-01-02 15:04:05.999999-07", s); err == nil {
		return t.Format("2006-01-02 15:04")
	}
	return s
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
