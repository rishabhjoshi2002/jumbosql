package insights

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestPrometheusFromInventory(t *testing.T) {
	inv := `{"all":{"children":{"prometheus_cluster":{"hosts":{"mon1":{"ansible_host":"192.168.122.80"}}},"etcd_cluster":{"hosts":{"e1":{}}}}}}`
	if u := PrometheusFromInventory([]byte(inv)); u != "http://192.168.122.80:9090" {
		t.Fatalf("got %q", u)
	}
	quoted, _ := json.Marshal(inv) // stored as a JSON string
	if u := PrometheusFromInventory(quoted); u != "http://192.168.122.80:9090" {
		t.Fatalf("quoted: got %q", u)
	}
	if PrometheusFromInventory([]byte(`{"all":{"children":{}}}`)) != "" || PrometheusFromInventory(nil) != "" {
		t.Fatal("no monitoring VM -> no URL")
	}
}

// fakeProm answers query_range with a CPU series climbing 2 % a day from 60 %, a disk filling 1 GB a day.
func fakeProm(t *testing.T, now time.Time) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query().Get("query")
		var res []map[string]any
		series := func(labels map[string]string, f func(d float64) float64) {
			var vals [][2]any
			for h := 0; h <= 14*24; h += 1 {
				ts := now.Add(-time.Duration(14*24-h) * time.Hour)
				d := float64(h) / 24
				vals = append(vals, [2]any{float64(ts.Unix()), fmt.Sprintf("%g", f(d))})
			}
			res = append(res, map[string]any{"metric": labels, "values": vals})
		}
		db := map[string]string{"instance": "10.0.0.11:9100"}
		mon := map[string]string{"instance": "10.0.0.80:9100"}
		switch {
		case strings.Contains(q, "node_cpu_seconds_total{mode=\"idle\"}[5m]"):
			series(db, func(d float64) float64 { return 60 + 2*d })
			series(mon, func(d float64) float64 { return 10 })
		case strings.HasPrefix(q, "count by"):
			series(db, func(float64) float64 { return 4 })
		case strings.Contains(q, "MemAvailable"):
			series(db, func(float64) float64 { return 50 })
		case q == "node_memory_MemTotal_bytes":
			series(db, func(float64) float64 { return 16 << 30 })
		case strings.HasPrefix(q, "node_filesystem_size_bytes{fstype"):
			series(map[string]string{"instance": "10.0.0.11:9100", "mountpoint": "/"}, func(float64) float64 { return 20 << 30 })
			series(map[string]string{"instance": "10.0.0.11:9100", "mountpoint": "/pgdata"}, func(float64) float64 { return 100 << 30 })
		case strings.HasPrefix(q, "node_filesystem_size_bytes{instance"):
			if !strings.Contains(q, `mountpoint="/pgdata"`) {
				t.Errorf("disk query should use the data directory's mount: %s", q)
			}
			series(db, func(d float64) float64 { return 50<<30 + d*(1<<30) })
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "success", "data": map[string]any{"resultType": "matrix", "result": res}})
	}))
}

func TestHostsAndRecommendations(t *testing.T) {
	now := time.Now().Truncate(time.Hour)
	srv := fakeProm(t, now)
	defer srv.Close()
	p := &Prometheus{BaseURL: srv.URL}
	hosts, err := p.Hosts(t.Context(), map[string][2]string{"10.0.0.11": {"pg1", "leader"}}, "/pgdata/17/data", 14, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(hosts) != 2 || hosts[0].Node != "pg1" || hosts[0].Cores != 4 || hosts[0].Mount != "/pgdata" {
		t.Fatalf("hosts = %+v", hosts[0])
	}
	h := hosts[0]
	// disk: 64 GB used of 100, +1 GB/day -> 80 % in ~16 days, full in ~36
	if h.DaysTo80 < 14 || h.DaysTo80 > 18 || h.DaysToFull < 34 || h.DaysToFull > 38 {
		t.Fatalf("disk days: 80%% in %.1f, full in %.1f", h.DaysTo80, h.DaysToFull)
	}
	// CPU: p95 ~ 87 %, trend +2 %/day -> forecast > 100 -> more CPUs
	if h.CPUP95 < 80 || h.CPUForecast.PerDay < 1.5 {
		t.Fatalf("cpu p95 %.1f, trend %.2f", h.CPUP95, h.CPUForecast.PerDay)
	}

	r := &Report{Days: 14, Hosts: hosts}
	r.Overview = &Overview{MaxConnections: 100, Connections: 90, CacheHitPct: 91, XidAgeMax: 1.6e9, XidAgeDatabase: "shop", FreezeMaxAge: 2e8,
		SharedBuffers: "128MB", PgStatStatements: false}
	r.Load.MaxConnections = 100
	r.Load.ConnPeak = 85
	r.Tables.Items = []Table{
		{Database: "shop", Name: "public.orders", LiveRows: 100000, DeadRows: 150000, DeadPct: 60, TableBytes: 2 << 30, BloatBytes: 1.2 * (1 << 30)},
		{Database: "shop", Name: "public.events", LiveRows: 500000, SeqScans: 900, IdxScans: 10, SeqRowsRead: 900 * 500000},
	}
	r.UnusedIndexes = []Index{{Database: "shop", Table: "public.orders", Name: "public.orders_note_idx", Bytes: 50 << 20}}
	recs := Recommend(r, now)
	find := func(cat, sev, text string) *Recommendation {
		for i := range recs {
			if recs[i].Category == cat && recs[i].Severity == sev && strings.Contains(recs[i].Title+recs[i].Detail+recs[i].Action, text) {
				return &recs[i]
			}
		}
		return nil
	}
	checks := []struct{ cat, sev, text string }{
		{"storage", "warning", "reaches 80 %"},
		{"cpu", "critical", "from 4 to"},
		{"connections", "warning", "near the limit"},
		{"maintenance", "critical", "Transaction ID age"},
		{"config", "warning", "Cache hit"},
		{"bloat", "critical", "public.orders: 60 % dead rows"},
		{"indexes", "info", "mostly read by full scans"},
		{"indexes", "info", "Unused index"},
		{"queries", "info", "not enabled"},
	}
	for _, c := range checks {
		if find(c.cat, c.sev, c.text) == nil {
			b, _ := json.MarshalIndent(recs, "", " ")
			t.Fatalf("missing %s/%s %q in\n%s", c.cat, c.sev, c.text, b)
		}
	}
	if rec := find("bloat", "critical", "public.orders"); !strings.Contains(rec.SQL, `VACUUM (ANALYZE, VERBOSE) "public"."orders";`) {
		t.Fatalf("bloat SQL = %q", rec.SQL)
	}
	if recs[0].Severity != "critical" || recs[len(recs)-1].Severity != "info" {
		t.Fatal("recommendations are ordered by severity")
	}
	// the monitoring VM (not a cluster node) gets no CPU advice
	if find("cpu", "warning", "10.0.0.80") != nil {
		t.Fatal("no advice for non-cluster hosts")
	}
}

func TestInventoryHostsAndServices(t *testing.T) {
	inv := `{"all":{"children":{"etcd_cluster":{"hosts":{"etcd1":{"ansible_host":"10.0.0.21"}}},
		"postgres_cluster":{"hosts":{"pg1":{"ansible_host":"10.0.0.24"}}},
		"haproxy_cluster":{"hosts":{"proxy1":{"ansible_host":"10.0.0.26"}}},"pgbouncer_cluster":{"hosts":{"proxy1":{"ansible_host":"10.0.0.26"}}}}}}`
	h := InventoryHosts([]byte(inv))
	if h["10.0.0.21"] != [2]string{"etcd1", "etcd"} || h["10.0.0.26"][0] != "proxy1" || h["10.0.0.26"][1] != "haproxy,pgbouncer" {
		t.Fatalf("hosts = %v", h)
	}
	for in, want := range map[[2]string]string{
		{"node", "x:9100"}: "node", {"blackbox", "x:9100"}: "node", {"etcd-cluster", "x:2379"}: "etcd",
		{"pgmonitor", "x:9187"}: "postgres", {"x", "x:8009"}: "patroni", {"haproxy", "x"}: "haproxy",
	} {
		if got := serviceOf(in[0], in[1]); got != want {
			t.Errorf("serviceOf(%v) = %s, want %s", in, got, want)
		}
	}
}
