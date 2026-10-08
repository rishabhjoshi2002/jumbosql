package insights

import (
	"strings"
	"testing"
	"time"
)

func series(days int, every time.Duration, f func(d float64) float64, end time.Time) []Point {
	var out []Point
	start := end.Add(-time.Duration(days) * 24 * time.Hour)
	for t := start; !t.After(end); t = t.Add(every) {
		out = append(out, Point{T: t, V: f(t.Sub(start).Hours() / 24)})
	}
	return out
}

func TestCapacityPlanAndOutlook(t *testing.T) {
	now := time.Now().Truncate(time.Hour)
	size := series(30, time.Hour, func(d float64) float64 { return 50e9 + 1e9*d }, now) // 50 -> 80 GB, +1 GB/day
	disk := series(30, time.Hour, func(d float64) float64 { return 60e9 + 1e9*d }, now) // 60 -> 90 GB of 100 GB
	cpu := series(30, time.Hour, func(d float64) float64 { return 50 + 1*d }, now)      // 50 -> 80 %
	conns := series(30, time.Hour, func(d float64) float64 { return 40 + 0.5*d }, now)  // 40 -> 55 of 100
	tps := series(30, time.Hour, func(d float64) float64 { return 300 + 5*d }, now)
	r := &Report{GeneratedAt: now, ClusterID: 7}
	r.Load.MaxConnections = 100
	r.Storage.Forecast = MakeForecast(size, 90, now)
	r.Hosts = []Host{{Node: "pg1", Role: "leader", Cores: 4, CPU: cpu, CPUP95: Percentile(cpu, 95), DiskSize: 100 << 30,
		DiskUsed: disk, Mem: series(30, time.Hour, func(float64) float64 { return 50 }, now), MemP95: 50}}
	r.Recommendations = []Recommendation{{Severity: "critical"}, {Severity: "warning"}, {Severity: "info"}}
	BuildCapacity(r, size, conns, tps, map[string][]Point{"shop": size}, 90, now)

	byKey := map[string]CapacityItem{}
	for _, it := range r.Capacity {
		byKey[it.Key] = it
	}
	d := byKey["disk:pg1"]
	// 90 GB used of 107.4 GB (100 GiB), +1 GB/day: 80 % (85.9 GB) is already passed, full in ~17 days
	if d.Status != "act" || d.LimitInDays < 14 || d.LimitInDays > 20 || d.LimitDate == nil || d.NeedAtHorizon <= d.Limit {
		t.Fatalf("disk item = %+v", d)
	}
	if c := byKey["cpu:pg1"]; c.NeedUnit != "vcpu" || c.NeedAtHorizon <= 4 || c.Status == "ok" {
		t.Fatalf("cpu item = %+v", c)
	}
	if c := byKey["connections"]; c.Limit != 100 || c.WarnAt != 80 {
		t.Fatalf("connections item = %+v", c)
	}
	if _, ok := byKey["db:shop"]; !ok {
		t.Fatal("biggest databases are planned too")
	}
	if r.Capacity[0].Status != "act" {
		t.Fatal("items needing action come first")
	}
	text := ""
	for _, l := range r.Outlook {
		text += l.Severity + ": " + l.Text + "\n"
	}
	for _, want := range []string{"critical: Disk on pg1 is full around", "pg1 needs", "info: Data:", "Busy-hour load"} {
		if !strings.Contains(text, want) {
			t.Fatalf("outlook misses %q:\n%s", want, text)
		}
	}
	if r.Score != 100-25-8-2 || r.Grade != "fair" {
		t.Fatalf("score %d %s", r.Score, r.Grade)
	}
	s := Summarize(r)
	if s.Critical != 1 || s.Warning != 1 || s.Act < 1 || s.DiskFullIn < 14 || s.DiskFullIn > 20 || s.SizeIn365 <= s.SizeBytes || len(s.Outlook) > 3 {
		t.Fatalf("summary = %+v", s)
	}
}

func TestHealthScore(t *testing.T) {
	if s, g := HealthScore(nil); s != 100 || g != "good" {
		t.Fatal(s, g)
	}
	many := make([]Recommendation, 20)
	for i := range many {
		many[i].Severity = "info"
	}
	if s, _ := HealthScore(many); s != 90 { // info counts at most 10
		t.Fatal(s)
	}
	if s, g := HealthScore([]Recommendation{{Severity: "critical"}, {Severity: "critical"}, {Severity: "critical"}, {Severity: "critical"}, {Severity: "critical"}}); s != 0 || g != "poor" {
		t.Fatal(s, g)
	}
}
