package insights

// Capacity planning: for every resource that can run out (storage, each node's disk, CPU and memory, connections),
// where it is now, where it will be in 30 / 90 / 180 / 365 days, when it reaches its warning level and its limit,
// and what to have by then. Plus a health score and plain-language outlook lines for the overview.

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
)

// CapacityItem is one resource in the capacity plan.
type CapacityItem struct {
	Key           string     `json:"key"`
	Kind          string     `json:"kind"` // storage | disk | cpu | memory | connections | load | database
	Title         string     `json:"title"`
	Node          string     `json:"node,omitempty"`
	Unit          string     `json:"unit"` // bytes | pct | count | per_sec
	Now           float64    `json:"now"`
	Limit         float64    `json:"limit,omitempty"`   // 0 = no hard limit
	WarnAt        float64    `json:"warn_at,omitempty"` // 0 = no warning level
	Forecast      Forecast   `json:"forecast"`
	History       []Point    `json:"history"`
	WarnInDays    float64    `json:"warn_in_days"`  // -1 = not within 3 years
	LimitInDays   float64    `json:"limit_in_days"` // -1 = not within 3 years
	WarnDate      *time.Time `json:"warn_date,omitempty"`
	LimitDate     *time.Time `json:"limit_date,omitempty"`
	NeedNow       float64    `json:"need_now,omitempty"`        // e.g. vCPUs or disk size that fit today's load
	NeedAtHorizon float64    `json:"need_at_horizon,omitempty"` // ... and at the end of the horizon
	NeedUnit      string     `json:"need_unit,omitempty"`       // vcpu | bytes
	Status        string     `json:"status"`                    // ok | watch | act
	Advice        string     `json:"advice"`
}

// OutlookLine is one plain-language sentence of the outlook.
type OutlookLine struct {
	Severity string `json:"severity"` // critical | warning | info | ok
	Text     string `json:"text"`
}

const plannerReach = 3 * 365 // dates further than this are "not in sight"

func dateIn(now time.Time, days float64) *time.Time {
	if days < 0 || days > plannerReach {
		return nil
	}
	t := now.Add(time.Duration(days * 24 * float64(time.Hour)))
	return &t
}

func fmtDate(t *time.Time) string {
	if t == nil {
		return ""
	}
	return t.Format("2 Jan 2006")
}

// busyNow: the busy-hour (p95) value of the last 24 hours of a raw series (today's partial day would understate it).
func busyNow(raw []Point) float64 {
	if len(raw) == 0 {
		return 0
	}
	cut := raw[len(raw)-1].T.Add(-24 * time.Hour)
	var last []Point
	for _, p := range raw {
		if !p.T.Before(cut) {
			last = append(last, p)
		}
	}
	return Percentile(last, 95)
}

func roundUpBytes(b, step float64) float64 { return math.Ceil(b/step) * step }

func newItem(key, kind, title, node, unit string, hist []Point, limit, warn float64, horizon int, now time.Time) CapacityItem {
	f := MakeForecast(hist, horizon, now)
	it := CapacityItem{Key: key, Kind: kind, Title: title, Node: node, Unit: unit, Now: Last(hist), Limit: limit, WarnAt: warn,
		Forecast: f, History: Downsample(hist, 160), WarnInDays: -1, LimitInDays: -1, Status: "ok"}
	if warn > 0 {
		it.WarnInDays = f.DaysTo(warn, now)
		if it.Now >= warn {
			it.WarnInDays = 0
		}
	}
	if limit > 0 {
		it.LimitInDays = f.DaysTo(limit, now)
		if it.Now >= limit {
			it.LimitInDays = 0
		}
	}
	if it.WarnInDays > plannerReach {
		it.WarnInDays = -1
	}
	if it.LimitInDays > plannerReach {
		it.LimitInDays = -1
	}
	it.WarnDate, it.LimitDate = dateIn(now, it.WarnInDays), dateIn(now, it.LimitInDays)
	h := float64(horizon)
	switch {
	case it.LimitInDays >= 0 && it.LimitInDays <= h:
		it.Status = "act"
	case it.WarnInDays >= 0 && it.WarnInDays <= h:
		it.Status = "watch"
	}
	return it
}

func (it *CapacityItem) projected() (v, high float64) {
	n := len(it.Forecast.Band)
	if n == 0 {
		return it.Now, it.Now
	}
	return it.Forecast.Band[n-1].V, it.Forecast.Band[n-1].High
}

// BuildCapacity fills the capacity plan, the outlook and the health score of a report.
func BuildCapacity(r *Report, size, conns, tps []Point, dbSeries map[string][]Point, horizon int, now time.Time) {
	r.Horizon = horizon
	h := horizon
	var items []CapacityItem

	// storage (all databases)
	st := newItem("storage", "storage", "All databases", "", "bytes", size, 0, 0, h, now)
	if v, _ := st.projected(); st.Forecast.HasForecast {
		st.Advice = fmt.Sprintf("%s now, about %s in %d days.", HumanBytes(st.Now), HumanBytes(v), h)
	}
	items = append(items, st)

	// per node: disk, CPU, memory (database nodes; Prometheus needed)
	for _, host := range r.Hosts {
		if host.Node == "" {
			continue
		}
		node := host.Node
		if host.DiskSize > 0 && len(host.DiskUsed) > 1 {
			it := newItem("disk:"+node, "disk", "Disk on "+node, node, "bytes", host.DiskUsed, host.DiskSize, 0.8*host.DiskSize, h, now)
			_, hi := it.projected()
			it.NeedNow = host.DiskSize
			it.NeedAtHorizon = math.Max(host.DiskSize, roundUpBytes(hi/0.75, 10<<30)) // keep 25 % free at the high estimate
			it.NeedUnit = "bytes"
			switch it.Status {
			case "act":
				it.Advice = fmt.Sprintf("Full around %s. Grow the volume to %s.", fmtDate(it.LimitDate), HumanBytes(it.NeedAtHorizon))
			case "watch":
				it.Advice = fmt.Sprintf("80 %% around %s. Plan %s.", fmtDate(it.WarnDate), HumanBytes(it.NeedAtHorizon))
			default:
				it.Advice = fmt.Sprintf("%s of %s used; enough for the next %d days.", HumanBytes(it.Now), HumanBytes(host.DiskSize), h)
			}
			items = append(items, it)
		}
		if len(host.CPU) > 1 {
			it := newItem("cpu:"+node, "cpu", "CPU on "+node, node, "pct", dailyPercentile(host.CPU, 95), 100, cpuWarn, h, now)
			it.Now = busyNow(host.CPU)
			if host.Cores > 0 {
				v, _ := it.projected()
				it.NeedNow = math.Max(host.Cores, math.Ceil(host.Cores*it.Now/cpuTarget))
				it.NeedAtHorizon = math.Max(it.NeedNow, math.Ceil(host.Cores*math.Max(v, it.Now)/cpuTarget))
				it.NeedUnit = "vcpu"
				if it.NeedAtHorizon > host.Cores {
					if v > 100 {
						it.Advice = fmt.Sprintf("Busy-hour demand grows to about %.1f x today's CPUs: have %.0f vCPUs (now %.0f) within %d days.", v/100, it.NeedAtHorizon, host.Cores, h)
					} else {
						it.Advice = fmt.Sprintf("Busy hour heads for %.0f %%: have %.0f vCPUs (now %.0f) within %d days.", v, it.NeedAtHorizon, host.Cores, h)
					}
					if it.Status == "ok" {
						it.Status = "watch"
					}
				} else {
					it.Advice = fmt.Sprintf("%.0f vCPUs are enough for the next %d days.", host.Cores, h)
				}
			}
			items = append(items, it)
		}
		if len(host.Mem) > 1 {
			it := newItem("mem:"+node, "memory", "Memory on "+node, node, "pct", dailyPercentile(host.Mem, 95), 100, memWarn, h, now)
			it.Now = busyNow(host.Mem)
			if it.Status != "ok" {
				it.Advice = fmt.Sprintf("Busy-hour memory reaches %.0f %% around %s: add RAM or lower memory settings.", memWarn, fmtDate(it.WarnDate))
			} else {
				it.Advice = fmt.Sprintf("Enough for the next %d days.", h)
			}
			items = append(items, it)
		}
	}

	// connections against max_connections
	if len(conns) > 1 {
		maxc := r.Load.MaxConnections
		warn := 0.0
		if maxc > 0 {
			warn = connWarnPct / 100 * maxc
		}
		it := newItem("connections", "connections", "Connections (busy hour)", "", "count", dailyPercentile(conns, 95), maxc, warn, h, now)
		it.Now = busyNow(conns)
		switch it.Status {
		case "act":
			it.Advice = fmt.Sprintf("max_connections (%.0f) reached around %s: use PgBouncer or raise it.", maxc, fmtDate(it.LimitDate))
		case "watch":
			it.Advice = fmt.Sprintf("80 %% of max_connections around %s.", fmtDate(it.WarnDate))
		default:
			it.Advice = fmt.Sprintf("Within max_connections (%.0f) for the next %d days.", maxc, h)
		}
		items = append(items, it)
	}

	// load (no hard limit: the trend matters)
	if len(tps) > 1 {
		it := newItem("tps", "load", "Transactions per second (busy hour)", "", "per_sec", dailyPercentile(tps, 95), 0, 0, h, now)
		it.Now = busyNow(tps)
		if it.Forecast.HasForecast {
			v, _ := it.projected()
			it.Advice = fmt.Sprintf("%s/s now, about %s/s in %d days (%+.0f %% a month).", compactNum(it.Now), compactNum(v), h, it.Forecast.GrowthPctMonth)
		}
		items = append(items, it)
	}

	// the biggest databases
	type dbs struct {
		name string
		pts  []Point
	}
	var list []dbs
	for name, pts := range dbSeries {
		if Last(pts) >= 50<<20 {
			list = append(list, dbs{name, pts})
		}
	}
	sort.Slice(list, func(i, j int) bool { return Last(list[i].pts) > Last(list[j].pts) })
	for i, d := range list {
		if i >= 5 {
			break
		}
		it := newItem("db:"+d.name, "database", "Database "+d.name, "", "bytes", d.pts, 0, 0, h, now)
		if v, _ := it.projected(); it.Forecast.HasForecast {
			it.Advice = fmt.Sprintf("%s now, about %s in %d days.", HumanBytes(it.Now), HumanBytes(v), h)
		}
		items = append(items, it)
	}

	rank := map[string]int{"act": 0, "watch": 1, "ok": 2}
	sort.SliceStable(items, func(i, j int) bool { return rank[items[i].Status] < rank[items[j].Status] })
	r.Capacity = items
	r.Outlook = buildOutlook(r, st, items, h)
	r.Score, r.Grade = HealthScore(r.Recommendations)
}

func compactNum(n float64) string {
	switch a := math.Abs(n); {
	case a >= 1e6:
		return fmt.Sprintf("%.1fM", n/1e6)
	case a >= 1e4:
		return fmt.Sprintf("%.1fK", n/1e3)
	case a >= 100:
		return fmt.Sprintf("%.0f", n)
	default:
		return fmt.Sprintf("%.1f", n)
	}
}

func projAt(f Forecast, days int) (Projection, bool) {
	for _, p := range f.Projections {
		if p.Days == days {
			return p, true
		}
	}
	return Projection{}, false
}

// buildOutlook writes the overview sentences: what runs out and when, then how the data grows.
func buildOutlook(r *Report, st CapacityItem, items []CapacityItem, h int) []OutlookLine {
	var out []OutlookLine
	for _, it := range items {
		switch {
		case it.Status == "act" && it.Kind == "disk":
			out = append(out, OutlookLine{"critical", fmt.Sprintf("%s is full around %s (80 %% around %s). Have %s by then.",
				it.Title, fmtDate(it.LimitDate), orNow(it.WarnDate), HumanBytes(it.NeedAtHorizon))})
		case it.Status == "watch" && it.Kind == "disk":
			out = append(out, OutlookLine{"warning", fmt.Sprintf("%s reaches 80 %% around %s; plan %s.", it.Title, fmtDate(it.WarnDate), HumanBytes(it.NeedAtHorizon))})
		case it.Kind == "cpu" && it.NeedUnit == "vcpu" && it.NeedAtHorizon > it.NeedNow && it.Status != "ok":
			sev := "warning"
			if it.Status == "act" || it.Now >= cpuCrit {
				sev = "critical"
			}
			out = append(out, OutlookLine{sev, fmt.Sprintf("%s needs %.0f vCPUs within %d days to keep busy hours near 65 %%.", it.Node, it.NeedAtHorizon, h)})
		case it.Kind == "memory" && it.Status != "ok":
			out = append(out, OutlookLine{"warning", fmt.Sprintf("Memory on %s reaches %.0f %% around %s.", it.Node, memWarn, orNow(it.WarnDate))})
		case it.Kind == "connections" && it.Status != "ok":
			sev := "warning"
			if it.Status == "act" {
				sev = "critical"
			}
			when := it.WarnDate
			if it.Status == "act" {
				when = it.LimitDate
			}
			out = append(out, OutlookLine{sev, fmt.Sprintf("Connections reach %s around %s.",
				map[bool]string{true: "max_connections", false: "80 % of max_connections"}[it.Status == "act"], orNow(when))})
		}
	}
	if len(out) == 0 {
		out = append(out, OutlookLine{"ok", fmt.Sprintf("No capacity limit is reached in the next %d days.", h)})
	}
	if f := st.Forecast; f.HasForecast {
		var parts []string
		for _, d := range []int{90, 365} {
			if p, ok := projAt(f, d); ok {
				s := fmt.Sprintf("about %s in %s", HumanBytes(p.V), map[int]string{90: "3 months", 365: "a year"}[d])
				if !p.Reliable {
					s += " (rough)"
				}
				parts = append(parts, s)
			}
		}
		model := "steady growth"
		if f.Model == "compound" {
			model = "growth speeding up (compound)"
		}
		out = append(out, OutlookLine{"info", fmt.Sprintf("Data: %s today, growing %s a month (%+.0f %%, %s): %s.",
			HumanBytes(st.Now), HumanBytes(f.PerDay*30), f.GrowthPctMonth, model, strings.Join(parts, ", "))})
	}
	for _, it := range items {
		if it.Kind == "load" && it.Forecast.HasForecast {
			if p, ok := projAt(it.Forecast, 90); ok {
				out = append(out, OutlookLine{"info", fmt.Sprintf("Busy-hour load: %s transactions/s now, about %s/s in 3 months (%+.0f %% a month).",
					compactNum(it.Now), compactNum(p.V), it.Forecast.GrowthPctMonth)})
			}
		}
	}
	return out
}

func orNow(t *time.Time) string {
	if t == nil {
		return "now"
	}
	if time.Until(*t) < 24*time.Hour {
		return "now"
	}
	return fmtDate(t)
}

// HealthScore: 100 minus the weight of the findings (critical 25, warning 8, info 2 - at most 10 for info).
func HealthScore(recs []Recommendation) (int, string) {
	score, info := 100, 0
	for _, r := range recs {
		switch r.Severity {
		case "critical":
			score -= 25
		case "warning":
			score -= 8
		default:
			info += 2
		}
	}
	score -= min(info, 10)
	score = max(score, 0)
	switch {
	case score >= 85:
		return score, "good"
	case score >= 60:
		return score, "fair"
	default:
		return score, "poor"
	}
}

// ClusterSummary is one cluster's line in the multi-cluster summary (kept hourly in insight_reports).
type ClusterSummary struct {
	ClusterID   int64            `json:"cluster_id"`
	At          time.Time        `json:"at"`
	Score       int              `json:"score"`
	Grade       string           `json:"grade"`
	Critical    int              `json:"critical"`
	Warning     int              `json:"warning"`
	Info        int              `json:"info"`
	Top         []Recommendation `json:"top"`
	SizeBytes   float64          `json:"size_bytes"`
	SizePerDay  float64          `json:"size_per_day"`
	SizeIn30    float64          `json:"size_in_30"`
	SizeIn365   float64          `json:"size_in_365"`
	TPSPeak     float64          `json:"tps_peak"`
	ConnPeak    float64          `json:"connections_peak"`
	MaxConn     float64          `json:"max_connections"`
	CPUP95Max   float64          `json:"cpu_p95_max"`
	DiskFullIn  float64          `json:"disk_full_in_days"` // soonest of the nodes, -1 = not in sight
	Act         int              `json:"capacity_act"`
	Watch       int              `json:"capacity_watch"`
	Outlook     []OutlookLine    `json:"outlook"`
	Version     string           `json:"version,omitempty"`
	Unreachable string           `json:"unreachable,omitempty"`
}

// Summarize a report for the multi-cluster summary.
func Summarize(r *Report) ClusterSummary {
	s := ClusterSummary{ClusterID: r.ClusterID, At: r.GeneratedAt, Score: r.Score, Grade: r.Grade, DiskFullIn: -1,
		SizeBytes: r.Storage.Forecast.Current, SizePerDay: r.Storage.Forecast.PerDay, SizeIn30: r.Storage.Forecast.In30Days,
		TPSPeak: r.Load.TPSPeak, ConnPeak: r.Load.ConnPeak, MaxConn: r.Load.MaxConnections, Outlook: r.Outlook,
		Unreachable: r.OverviewError}
	if p, ok := projAt(r.Storage.Forecast, 365); ok {
		s.SizeIn365 = p.V
	}
	for _, rec := range r.Recommendations {
		switch rec.Severity {
		case "critical":
			s.Critical++
		case "warning":
			s.Warning++
		default:
			s.Info++
		}
		if len(s.Top) < 3 && rec.Severity != "info" {
			s.Top = append(s.Top, rec)
		}
	}
	for _, h := range r.Hosts {
		if h.Node == "" {
			continue
		}
		s.CPUP95Max = math.Max(s.CPUP95Max, h.CPUP95)
	}
	for _, it := range r.Capacity {
		if it.Kind == "disk" && it.LimitInDays >= 0 && (s.DiskFullIn < 0 || it.LimitInDays < s.DiskFullIn) {
			s.DiskFullIn = it.LimitInDays
		}
		switch it.Status {
		case "act":
			s.Act++
		case "watch":
			s.Watch++
		}
	}
	if r.Overview != nil {
		s.Version = r.Overview.Version
	}
	if len(s.Outlook) > 3 {
		s.Outlook = s.Outlook[:3]
	}
	return s
}
