package insights

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"postgresql-cluster-console/internal/storage"

	"github.com/rs/zerolog"
)

// Service builds the Insights report of a cluster.
type Service struct {
	db      storage.IStorage
	log     zerolog.Logger
	opts    Options
	httpCli *http.Client
}

func NewService(db storage.IStorage, log zerolog.Logger, opts Options) *Service {
	return &Service{db: db, log: log, opts: opts, httpCli: &http.Client{Timeout: 15 * time.Second}}
}

// Series is a named line for a chart.
type Series struct {
	Name   string  `json:"name"`
	Points []Point `json:"points"`
}

// DBGrowth is one database's size trend.
type DBGrowth struct {
	Name     string   `json:"name"`
	Size     float64  `json:"size_bytes"`
	Forecast Forecast `json:"forecast"`
	Points   []Point  `json:"points"`
}

// Report is everything the Insights page shows for one cluster.
type Report struct {
	GeneratedAt time.Time `json:"generated_at"`
	ClusterID   int64     `json:"cluster_id"`
	Cluster     string    `json:"cluster"`
	Days        int       `json:"days"`
	Collection  struct {
		Enabled  bool      `json:"enabled"`
		Interval string    `json:"interval"`
		Since    time.Time `json:"since"`
		Samples  int64     `json:"samples"`
	} `json:"collection"`

	Overview      *Overview `json:"overview,omitempty"`
	OverviewError string    `json:"overview_error,omitempty"`

	Storage struct {
		Points    []Point    `json:"points"`
		Forecast  Forecast   `json:"forecast"`
		Databases []DBGrowth `json:"databases"`
	} `json:"storage"`

	Load struct {
		TPS               []Point  `json:"tps"` // transactions per second
		TPSForecast       Forecast `json:"tps_forecast"`
		TPSPeak           float64  `json:"tps_peak"` // p95
		Writes            []Point  `json:"writes_per_sec"`
		Reads             []Point  `json:"reads_per_sec"`
		Connections       []Point  `json:"connections"`
		ConnForecast      Forecast `json:"connections_forecast"`
		ConnPeak          float64  `json:"connections_peak"`
		MaxConnections    float64  `json:"max_connections"`
		CacheHit          []Point  `json:"cache_hit_pct"`
		TempPerDay        float64  `json:"temp_bytes_per_day"`
		DeadlocksInWindow float64  `json:"deadlocks_in_window"`
	} `json:"load"`

	Tables struct {
		Database  string   `json:"database"`
		Databases []string `json:"databases"`
		Items     []Table  `json:"items"`
		Error     string   `json:"error,omitempty"`
	} `json:"tables"`
	UnusedIndexes []Index `json:"unused_indexes"`

	Queries      []Query `json:"queries"`
	QueriesError string  `json:"queries_error,omitempty"`

	Hosts       []Host `json:"hosts"`
	HostsSource string `json:"hosts_source,omitempty"`
	HostsError  string `json:"hosts_error,omitempty"`

	Recommendations []Recommendation `json:"recommendations"`
}

var sampledMetrics = []string{MClusterSize, MConnections, MMaxConnections, MXact, MRollbacks, MTupWritten, MTupFetched,
	MBlksHit, MBlksRead, MTempBytes, MDeadlocks, MDBSize}

// Build the report. days = history window (and fit window); database = whose tables to show ("" = the largest).
func (s *Service) Build(ctx context.Context, clusterID int64, days int, database string) (*Report, error) {
	if days <= 0 {
		days = 30
	}
	now := time.Now()
	cl, err := s.db.GetCluster(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	r := &Report{GeneratedAt: now, ClusterID: clusterID, Cluster: cl.Name, Days: days}
	r.Collection.Enabled = s.opts.Enabled
	r.Collection.Interval = s.opts.Interval.String()
	r.Collection.Since, r.Collection.Samples, _ = s.db.FirstMetricSample(ctx, clusterID)
	from := now.Add(-time.Duration(days) * 24 * time.Hour)

	// history from the samples
	samples, err := s.db.GetMetricSamples(ctx, clusterID, sampledMetrics, from)
	if err != nil {
		return nil, err
	}
	series := map[string][]Point{}
	for _, m := range samples {
		k := m.Metric + "\x00" + m.Key
		series[k] = append(series[k], Point{T: m.At, V: m.Value})
	}
	get := func(metric, key string) []Point { return series[metric+"\x00"+key] }
	maxGap := 3 * s.opts.Interval
	if maxGap < 30*time.Minute {
		maxGap = 30 * time.Minute
	}

	size := get(MClusterSize, "")
	r.Storage.Forecast = MakeForecast(size, 30, now)
	r.Storage.Points = Downsample(size, 300)
	for k, pts := range series {
		metric, key, _ := strings.Cut(k, "\x00")
		if metric != MDBSize {
			continue
		}
		r.Storage.Databases = append(r.Storage.Databases, DBGrowth{Name: key, Size: Last(pts), Forecast: MakeForecast(pts, 30, now),
			Points: Downsample(pts, 120)})
	}
	sort.Slice(r.Storage.Databases, func(i, j int) bool { return r.Storage.Databases[i].Size > r.Storage.Databases[j].Size })

	tps := Rates(get(MXact, ""), maxGap)
	r.Load.TPS = Downsample(tps, 300)
	r.Load.TPSPeak = Percentile(tps, 95)
	r.Load.TPSForecast = MakeForecast(dailyPercentile(tps, 95), 30, now)
	r.Load.Writes = Downsample(Rates(get(MTupWritten, ""), maxGap), 300)
	r.Load.Reads = Downsample(Rates(get(MTupFetched, ""), maxGap), 300)
	conns := get(MConnections, "")
	r.Load.Connections = Downsample(conns, 300)
	r.Load.ConnPeak = Percentile(conns, 95)
	r.Load.ConnForecast = MakeForecast(dailyPercentile(conns, 95), 30, now)
	r.Load.MaxConnections = Last(get(MMaxConnections, ""))
	r.Load.CacheHit = Downsample(hitRatio(get(MBlksHit, ""), get(MBlksRead, ""), maxGap), 300)
	if tr := Rates(get(MTempBytes, ""), maxGap); len(tr) > 0 {
		var sum float64
		for _, p := range tr {
			sum += p.V
		}
		r.Load.TempPerDay = sum / float64(len(tr)) * 86400
	}
	if dl := get(MDeadlocks, ""); len(dl) > 1 {
		for i := 1; i < len(dl); i++ { // counter increases between samples (resets ignored)
			if d := dl[i].V - dl[i-1].V; d > 0 {
				r.Load.DeadlocksInWindow += d
			}
		}
	}

	// live state of the server
	if conn, err := connect(ctx, cl, "postgres", s.opts.SSLMode); err != nil {
		r.OverviewError = err.Error()
	} else {
		ov, err := overview(ctx, conn)
		if err != nil {
			r.OverviewError = err.Error()
		} else {
			r.Overview = &ov
			if r.Load.MaxConnections == 0 {
				r.Load.MaxConnections = float64(ov.MaxConnections)
			}
			if ov.PgStatStatements {
				if q, err := topQueries(ctx, conn, ov.VersionNum); err != nil {
					r.QueriesError = err.Error()
				} else {
					r.Queries = q
				}
			}
			// databases for the table picker
			if dbs, err := rows(ctx, conn, `select datname from pg_database where datallowconn and not datistemplate
			   order by pg_database_size(oid) desc`); err == nil {
				for _, d := range dbs {
					r.Tables.Databases = append(r.Tables.Databases, d[0])
				}
			}
		}
		conn.Close(context.Background())
	}

	// tables of one database, with their growth from the samples
	if database == "" {
		database = pickDatabase(r.Tables.Databases)
	}
	r.Tables.Database = database
	if database != "" && contains(r.Tables.Databases, database) {
		if conn, err := connect(ctx, cl, database, s.opts.SSLMode); err != nil {
			r.Tables.Error = err.Error()
		} else {
			if items, err := liveTables(ctx, conn, database, 100); err != nil {
				r.Tables.Error = err.Error()
			} else {
				r.Tables.Items = items
			}
			r.UnusedIndexes, _ = unusedIndexes(ctx, conn, database)
			conn.Close(context.Background())
		}
		s.tableTrends(ctx, clusterID, from, now, r.Tables.Items)
	}

	// hosts from Prometheus
	if prom := s.prometheusURL(ctx, cl); prom != "" {
		r.HostsSource = prom
		servers := map[string][2]string{}
		if srv, err := s.db.GetClusterServers(ctx, clusterID); err == nil {
			for _, x := range srv {
				servers[x.IpAddress.String()] = [2]string{x.Name, x.Role}
			}
		}
		dataDir := ""
		if r.Overview != nil {
			dataDir = r.Overview.DataDirectory
		}
		p := &Prometheus{BaseURL: prom, HTTP: s.httpCli}
		hosts, err := p.Hosts(ctx, servers, dataDir, days, now)
		if err != nil {
			r.HostsError = err.Error()
		}
		r.Hosts = hosts
	}

	r.Recommendations = Recommend(r, now)
	return r, nil
}

func (s *Service) tableTrends(ctx context.Context, clusterID int64, from, now time.Time, items []Table) {
	if len(items) == 0 {
		return
	}
	ts, err := s.db.GetMetricSamples(ctx, clusterID, []string{MTableSize}, from)
	if err != nil {
		return
	}
	byKey := map[string][]Point{}
	for _, m := range ts {
		byKey[m.Key] = append(byKey[m.Key], Point{T: m.At, V: m.Value})
	}
	for i := range items {
		pts := byKey[items[i].Database+"/"+items[i].Name]
		if f := MakeForecast(pts, 30, now); f.HasForecast {
			items[i].GrowthPerDay, items[i].In30Days, items[i].HasTrend = f.PerDay, f.In30Days, true
		}
	}
}

// hitRatio: % of block reads served from shared buffers, per sample interval.
func hitRatio(hit, read []Point, maxGap time.Duration) []Point {
	h, r := Rates(hit, maxGap), Rates(read, maxGap)
	rd := map[int64]float64{}
	for _, p := range r {
		rd[p.T.Unix()] = p.V
	}
	var out []Point
	for _, p := range h {
		rv, ok := rd[p.T.Unix()]
		if !ok || p.V+rv == 0 {
			continue
		}
		out = append(out, Point{T: p.T, V: 100 * p.V / (p.V + rv)})
	}
	return out
}

func pickDatabase(dbs []string) string {
	for _, d := range dbs {
		if d != "postgres" {
			return d // the largest non-default database
		}
	}
	if len(dbs) > 0 {
		return dbs[0]
	}
	return ""
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// prometheusURL: the per-cluster override from the Observability page, else the Monitoring VM of the inventory.
func (s *Service) prometheusURL(ctx context.Context, cl *storage.Cluster) string {
	if st, err := s.db.GetSettingByName(ctx, "observability_links"); err == nil && st != nil && st.Value != nil {
		b, _ := json.Marshal(st.Value)
		var o map[string]map[string]string
		if json.Unmarshal(b, &o) == nil {
			if u := strings.TrimSpace(o[strconv.FormatInt(cl.ID, 10)]["prometheus"]); u != "" {
				return u
			}
		}
	}
	return PrometheusFromInventory(cl.Inventory)
}

// PrometheusFromInventory: http://<host of prometheus_cluster>:9090 (pgMonitor default), "" when there is none.
func PrometheusFromInventory(inv []byte) string {
	if len(inv) == 0 {
		return ""
	}
	var raw any
	if err := json.Unmarshal(inv, &raw); err != nil {
		return ""
	}
	if str, ok := raw.(string); ok { // stored as a JSON string
		if err := json.Unmarshal([]byte(str), &raw); err != nil {
			return ""
		}
	}
	b, _ := json.Marshal(raw)
	var parsed struct {
		All struct {
			Children map[string]struct {
				Hosts map[string]struct {
					AnsibleHost string `json:"ansible_host"`
				} `json:"hosts"`
			} `json:"children"`
		} `json:"all"`
	}
	if json.Unmarshal(b, &parsed) != nil {
		return ""
	}
	hosts := parsed.All.Children["prometheus_cluster"].Hosts
	names := make([]string, 0, len(hosts))
	for n := range hosts {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		h := hosts[n].AnsibleHost
		if h == "" {
			h = n
		}
		return "http://" + h + ":9090"
	}
	return ""
}

// InventoryHosts: ip (ansible_host) -> host name and its first inventory group, for every VM of the cluster.
func InventoryHosts(inv []byte) map[string][2]string {
	out := map[string][2]string{}
	if len(inv) == 0 {
		return out
	}
	var raw any
	if json.Unmarshal(inv, &raw) != nil {
		return out
	}
	if str, ok := raw.(string); ok {
		if json.Unmarshal([]byte(str), &raw) != nil {
			return out
		}
	}
	b, _ := json.Marshal(raw)
	var parsed struct {
		All struct {
			Children map[string]struct {
				Hosts map[string]map[string]any `json:"hosts"`
			} `json:"children"`
		} `json:"all"`
	}
	if json.Unmarshal(b, &parsed) != nil {
		return out
	}
	// the name the VM is known by (ip66_etcd1, ip69_pg1, ip73_util, ...); the host key is usually the IP
	display := map[string]string{}
	for _, g := range parsed.All.Children {
		for key, vars := range g.Hosts {
			for _, v := range []string{"patroni_name", "etcd_name", "node_jobname", "jumbo_hostname"} {
				if n, ok := vars[v].(string); ok && n != "" {
					if _, done := display[key]; !done || v == "patroni_name" {
						display[key] = n
					}
					break
				}
			}
		}
	}
	groups := make([]string, 0, len(parsed.All.Children))
	for g := range parsed.All.Children {
		groups = append(groups, g)
	}
	sort.Strings(groups)
	for _, g := range groups {
		if g == "pgmonitor_cluster" {
			continue
		}
		for name, vars := range parsed.All.Children[g].Hosts {
			role := strings.TrimSuffix(g, "_cluster")
			label := name
			if d := display[name]; d != "" {
				label = d
			}
			ah, _ := vars["ansible_host"].(string)
			for _, key := range []string{ah, name} {
				if key == "" {
					continue
				}
				if cur, ok := out[key]; ok {
					if !strings.Contains(cur[1], role) {
						out[key] = [2]string{cur[0], cur[1] + "," + role}
					}
					continue
				}
				out[key] = [2]string{label, role}
			}
		}
	}
	return out
}
