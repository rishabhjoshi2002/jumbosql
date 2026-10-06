package insights

// JumboSQL Observability dashboard: what the cluster's Prometheus knows right now - which services are up, which
// alerts fire, and the main PostgreSQL / Patroni / etcd / HAProxy / PgBouncer / node graphs. Exporters differ between
// setups (postgres_exporter, pgMonitor's ccp_* metrics, ...), so every panel tries a few queries and uses the first
// that returns data.

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// instant query (api/v1/query)
func (p *Prometheus) query(ctx context.Context, q string) ([]promSeries, error) {
	u, err := url.Parse(strings.TrimRight(p.BaseURL, "/") + "/api/v1/query")
	if err != nil {
		return nil, err
	}
	u.RawQuery = url.Values{"query": {q}}.Encode()
	var body struct {
		Status string `json:"status"`
		Error  string `json:"error"`
		Data   struct {
			Result []struct {
				Metric map[string]string `json:"metric"`
				Value  [2]any            `json:"value"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := p.getJSON(ctx, u.String(), &body); err != nil {
		return nil, err
	}
	if body.Status != "success" {
		return nil, fmt.Errorf("prometheus: %s", body.Error)
	}
	var out []promSeries
	for _, r := range body.Data.Result {
		ts, _ := r.Value[0].(float64)
		str, _ := r.Value[1].(string)
		f, err := strconv.ParseFloat(str, 64)
		if err != nil {
			continue
		}
		out = append(out, promSeries{Labels: r.Metric, Points: []Point{{T: time.Unix(int64(ts), 0), V: f}}})
	}
	return out, nil
}

func (p *Prometheus) getJSON(ctx context.Context, u string, into any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	cli := p.HTTP
	if cli == nil {
		cli = &http.Client{Timeout: 15 * time.Second}
	}
	resp, err := cli.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(into); err != nil {
		return fmt.Errorf("prometheus answered %s: %w", resp.Status, err)
	}
	return nil
}

// Target is one scrape target (an exporter) and whether Prometheus reaches it.
type Target struct {
	Service  string `json:"service"` // postgres | patroni | etcd | haproxy | pgbouncer | pgbackrest | node | prometheus | ...
	Job      string `json:"job"`
	Instance string `json:"instance"`
	Node     string `json:"node,omitempty"`
	Role     string `json:"role,omitempty"`
	Up       bool   `json:"up"`
}

// VM is one VM with everything Prometheus scrapes on it (several jobs can scrape the same service).
type VM struct {
	Address  string        `json:"host"` // IP / host name
	Name     string        `json:"name"`
	Roles    string        `json:"roles,omitempty"` // inventory groups, e.g. "haproxy,pgbouncer"
	Kind     string        `json:"kind"`            // database | etcd | proxy | backup | monitoring | other
	DBRole   string        `json:"db_role,omitempty"`
	Up       bool          `json:"up"`
	Services []HostService `json:"services"`
}

// HostService: one service on a host; up only when every job scraping it answers.
type HostService struct {
	Service string   `json:"service"`
	Up      bool     `json:"up"`
	Jobs    []string `json:"jobs"`
}

func hostKind(roles string, services []HostService) string {
	kinds := []struct {
		kind  string
		names []string
	}{
		{"database", []string{"postgres", "patroni", "master", "replica"}},
		{"etcd", []string{"etcd"}},
		{"proxy", []string{"haproxy", "pgbouncer", "balancers"}},
		{"backup", []string{"pgbackrest", "backrest"}},
		{"monitoring", []string{"prometheus", "grafana", "alertmanager"}},
	}
	// what Prometheus actually scrapes on the VM decides; the inventory roles only when it sees nothing but node
	for _, k := range kinds {
		for _, n := range k.names {
			for _, s := range services {
				if s.Service == n {
					return k.kind
				}
			}
		}
	}
	for _, k := range kinds {
		for _, n := range k.names {
			if strings.Contains(roles, n) {
				return k.kind
			}
		}
	}
	return "other"
}

// Alert is a firing (or pending) Prometheus alert.
type Alert struct {
	Name     string    `json:"name"`
	State    string    `json:"state"`
	Severity string    `json:"severity,omitempty"`
	Instance string    `json:"instance,omitempty"`
	Summary  string    `json:"summary,omitempty"`
	Since    time.Time `json:"since"`
}

// Panel is one graph: the series of the first query that returned data (Query = which one; empty = none did).
type Panel struct {
	Series []Series `json:"series"`
	Query  string   `json:"query,omitempty"`
}

// Monitoring is everything the Observability dashboard shows.
type Monitoring struct {
	Prometheus  string             `json:"prometheus"`
	Error       string             `json:"error,omitempty"`
	Minutes     int                `json:"minutes"`
	Targets     []Target           `json:"targets"`
	Hosts       []VM               `json:"hosts"` // one entry per VM, services de-duplicated
	Alerts      []Alert            `json:"alerts"`
	Panels      map[string]*Panel  `json:"panels"`
	Stats       map[string]float64 `json:"stats"` // single numbers (latest values)
	GeneratedAt time.Time          `json:"generated_at"`
}

// serviceOf guesses the service from the job name, else from the exporter's usual port.
func serviceOf(job, instance string) string {
	j := strings.ToLower(job)
	for _, k := range []struct{ key, svc string }{
		{"patroni", "patroni"}, {"etcd", "etcd"}, {"haproxy", "haproxy"}, {"pgbouncer", "pgbouncer"},
		{"backrest", "pgbackrest"}, {"alertmanager", "alertmanager"}, {"grafana", "grafana"}, {"node", "node"},
		{"postgres", "postgres"}, {"pgmonitor", "postgres"}, {"sql_exporter", "postgres"}, {"pg", "postgres"},
		{"prometheus", "prometheus"},
	} {
		if strings.Contains(j, k.key) {
			return k.svc
		}
	}
	_, port, _ := strings.Cut(instance, ":")
	switch port {
	case "9100":
		return "node"
	case "9187", "9399":
		return "postgres"
	case "8008", "8009":
		return "patroni"
	case "2379", "2381":
		return "etcd"
	case "8404", "9101":
		return "haproxy"
	case "9127":
		return "pgbouncer"
	case "9854":
		return "pgbackrest"
	case "9090":
		return "prometheus"
	case "9093":
		return "alertmanager"
	case "3000":
		return "grafana"
	}
	return j
}

const nodeNet = `device!~"lo|veth.*|docker.*|virbr.*|br-.*|cni.*|flannel.*"`

// panelQueries: per panel, the queries to try in order (each must yield one series per entity).
var panelQueries = map[string][]string{
	// PostgreSQL
	"pg_connections": {
		`sum by (instance) (pg_stat_activity_count)`,
		`sum by (instance) (ccp_connection_stats_total)`,
		`sum by (instance) (pg_stat_database_numbackends)`,
	},
	"pg_tps": {
		`sum by (instance) (rate(pg_stat_database_xact_commit[5m])) + sum by (instance) (rate(pg_stat_database_xact_rollback[5m]))`,
		`sum by (instance) (rate(ccp_stat_database_xact_commit[5m])) + sum by (instance) (rate(ccp_stat_database_xact_rollback[5m]))`,
	},
	"pg_db_size": {
		`sum by (instance) (pg_database_size_bytes)`,
		`sum by (instance) (ccp_database_size_bytes)`,
	},
	"pg_cache_hit": {
		`100 * sum by (instance) (rate(pg_stat_database_blks_hit[5m])) / (sum by (instance) (rate(pg_stat_database_blks_hit[5m])) + sum by (instance) (rate(pg_stat_database_blks_read[5m])) > 0)`,
		`100 * sum by (instance) (rate(ccp_stat_database_blks_hit[5m])) / (sum by (instance) (rate(ccp_stat_database_blks_hit[5m])) + sum by (instance) (rate(ccp_stat_database_blks_read[5m])) > 0)`,
	},
	"pg_replication_lag": { // seconds
		`max by (instance) (pg_replication_lag_seconds)`,
		`max by (instance) (pg_replication_lag)`,
		`max by (instance) (ccp_replication_lag_replay_time)`,
	},
	"pg_replication_lag_bytes": {
		`max by (instance) (ccp_replication_lag_size_bytes)`,
		`max by (instance) (pg_stat_replication_pg_wal_lsn_diff)`,
	},
	"pg_deadlocks": {
		`sum by (instance) (increase(pg_stat_database_deadlocks[5m]))`,
		`sum by (instance) (increase(ccp_stat_database_deadlocks[5m]))`,
	},
	// etcd
	"etcd_db_size": {`max by (instance) (etcd_mvcc_db_total_size_in_bytes)`},
	"etcd_fsync_p99": { // seconds
		`histogram_quantile(0.99, sum by (instance, le) (rate(etcd_disk_wal_fsync_duration_seconds_bucket[5m])))`,
	},
	"etcd_leader_changes": {`sum by (instance) (increase(etcd_server_leader_changes_seen_total[10m]))`},
	// proxies
	"haproxy_backends": {
		`sum by (proxy) (haproxy_backend_active_servers)`,
		`sum by (backend) (haproxy_backend_active_servers)`,
		`sum by (backend) (haproxy_server_up)`,
	},
	"pgbouncer_clients": {
		`sum by (instance) (pgbouncer_pools_client_active_connections)`,
		`sum by (instance) (pgbouncer_pools_cl_active)`,
		`sum by (instance) (ccp_pgbouncer_clients_active)`,
	},
	// nodes
	"node_cpu":  {`100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])))`},
	"node_mem":  {`100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)`},
	"node_disk": {`max by (instance) (100 * (1 - node_filesystem_avail_bytes{` + fsFilter + `} / node_filesystem_size_bytes{` + fsFilter + `}))`},
	"node_load": {`node_load1`},
	"node_net_in": {
		`sum by (instance) (rate(node_network_receive_bytes_total{` + nodeNet + `}[5m]))`,
	},
	"node_net_out": {
		`sum by (instance) (rate(node_network_transmit_bytes_total{` + nodeNet + `}[5m]))`,
	},
	"node_disk_busy": {`max by (instance) (100 * rate(node_disk_io_time_seconds_total[5m]))`},
}

// statQueries: single numbers.
var statQueries = map[string][]string{
	"pg_up":           {`sum(pg_up)`, `count(ccp_is_ready == 1)`},
	"pg_instances":    {`count(pg_up)`, `count(ccp_is_ready)`},
	"patroni_running": {`sum(patroni_postgres_running)`},
	"patroni_members": {`count(patroni_postgres_running)`},
	"patroni_leaders": {`sum(patroni_primary)`, `sum(patroni_master)`},
	"etcd_has_leader": {`min(etcd_server_has_leader)`},
	"etcd_members":    {`count(etcd_server_has_leader)`},
	"backup_age":      {`min(ccp_backrest_last_full_backup_time_since_completion_seconds)`, `min(pgbackrest_backup_since_last_completion_seconds)`},
	"backup_incr_age": {`min(ccp_backrest_last_incr_backup_time_since_completion_seconds)`, `min(ccp_backrest_last_diff_backup_time_since_completion_seconds)`},
	"max_repl_lag_s":  {`max(pg_replication_lag_seconds)`, `max(pg_replication_lag)`, `max(ccp_replication_lag_replay_time)`},
	"max_connections": {`max(pg_settings_max_connections)`, `max(ccp_connection_stats_max_connections)`},
}

// Monitoring reads the dashboard from the cluster's Prometheus.
func (s *Service) Monitoring(ctx context.Context, clusterID int64, minutes int) (*Monitoring, error) {
	if minutes <= 0 {
		minutes = 60
	}
	cl, err := s.db.GetCluster(ctx, clusterID)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	m := &Monitoring{Minutes: minutes, Panels: map[string]*Panel{}, Stats: map[string]float64{}, Targets: []Target{}, Hosts: []VM{}, Alerts: []Alert{},
		GeneratedAt: now}
	m.Prometheus = s.prometheusURL(ctx, cl)
	if m.Prometheus == "" {
		m.Error = "no Prometheus for this cluster (no Monitoring VM in the inventory and no URL set)"
		return m, nil
	}
	servers := InventoryHosts(cl.Inventory) // every VM of the cluster (etcd, proxies, monitoring too)
	if srv, err := s.db.GetClusterServers(ctx, clusterID); err == nil {
		for _, x := range srv {
			servers[x.IpAddress.String()] = [2]string{x.Name, x.Role}
			servers[x.Name] = [2]string{x.Name, x.Role}
		}
	}
	nameOf := func(labels map[string]string) string {
		if inst := labels["instance"]; inst != "" {
			if s, ok := servers[instanceHost(inst)]; ok {
				return s[0]
			}
			return instanceHost(inst)
		}
		for _, k := range []string{"proxy", "backend", "datname", "job"} {
			if v := labels[k]; v != "" {
				return v
			}
		}
		return "value"
	}
	p := &Prometheus{BaseURL: m.Prometheus, HTTP: s.httpCli}

	// targets: is everything Prometheus scrapes up?
	up, err := p.query(ctx, `up`)
	if err != nil {
		m.Error = err.Error()
		return m, nil
	}
	for _, x := range up {
		inst := x.Labels["instance"]
		t := Target{Job: x.Labels["job"], Instance: inst, Service: serviceOf(x.Labels["job"], inst), Up: Last(x.Points) == 1}
		if sv, ok := servers[instanceHost(inst)]; ok {
			t.Node, t.Role = sv[0], sv[1]
		}
		m.Targets = append(m.Targets, t)
	}
	m.Hosts = groupHosts(m.Targets, servers)
	sort.Slice(m.Targets, func(i, j int) bool {
		if m.Targets[i].Service != m.Targets[j].Service {
			return m.Targets[i].Service < m.Targets[j].Service
		}
		return m.Targets[i].Instance < m.Targets[j].Instance
	})

	start := now.Add(-time.Duration(minutes) * time.Minute)
	step := time.Duration(minutes) * time.Minute / 180
	if step < 15*time.Second {
		step = 15 * time.Second
	}
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 6)
	for id, qs := range panelQueries {
		wg.Add(1)
		go func(id string, qs []string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			panel := &Panel{Series: []Series{}}
			for _, q := range qs {
				res, err := p.rangeQuery(ctx, q, start, now, step)
				if err != nil || len(res) == 0 {
					continue
				}
				panel.Query = q
				byName := map[string][]Point{}
				var names []string
				for _, r := range res {
					n := nameOf(r.Labels)
					if _, ok := byName[n]; !ok {
						names = append(names, n)
					}
					byName[n] = mergeMax(byName[n], r.Points)
				}
				for _, n := range names {
					panel.Series = append(panel.Series, Series{Name: n, Points: byName[n]})
				}
				sort.Slice(panel.Series, func(i, j int) bool { return panel.Series[i].Name < panel.Series[j].Name })
				break
			}
			mu.Lock()
			m.Panels[id] = panel
			mu.Unlock()
		}(id, qs)
	}
	for id, qs := range statQueries {
		wg.Add(1)
		go func(id string, qs []string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			for _, q := range qs {
				res, err := p.query(ctx, q)
				if err == nil && len(res) > 0 {
					mu.Lock()
					m.Stats[id] = Last(res[0].Points)
					mu.Unlock()
					return
				}
			}
		}(id, qs)
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		var body struct {
			Data struct {
				Alerts []struct {
					Labels      map[string]string `json:"labels"`
					Annotations map[string]string `json:"annotations"`
					State       string            `json:"state"`
					ActiveAt    time.Time         `json:"activeAt"`
				} `json:"alerts"`
			} `json:"data"`
		}
		if err := p.getJSON(ctx, strings.TrimRight(p.BaseURL, "/")+"/api/v1/alerts", &body); err != nil {
			return
		}
		var alerts []Alert
		for _, a := range body.Data.Alerts {
			sum := a.Annotations["summary"]
			if sum == "" {
				sum = a.Annotations["description"]
			}
			alerts = append(alerts, Alert{Name: a.Labels["alertname"], State: a.State, Severity: a.Labels["severity"],
				Instance: a.Labels["instance"], Summary: sum, Since: a.ActiveAt})
		}
		rank := map[string]int{"critical": 0, "warning": 1}
		sort.SliceStable(alerts, func(i, j int) bool {
			ri, ok := rank[alerts[i].Severity]
			if !ok {
				ri = 2
			}
			rj, ok := rank[alerts[j].Severity]
			if !ok {
				rj = 2
			}
			return ri < rj
		})
		mu.Lock()
		m.Alerts = append(m.Alerts, alerts...)
		mu.Unlock()
	}()
	wg.Wait()
	return m, nil
}

// mergeMax combines two series of the same entity (e.g. scraped by two jobs): the larger value per timestamp.
func mergeMax(a, b []Point) []Point {
	if len(a) == 0 {
		return b
	}
	at := map[int64]int{}
	for i, p := range a {
		at[p.T.Unix()] = i
	}
	for _, p := range b {
		if i, ok := at[p.T.Unix()]; ok {
			if p.V > a[i].V {
				a[i].V = p.V
			}
		} else {
			a = append(a, p)
		}
	}
	sort.Slice(a, func(i, j int) bool { return a[i].T.Before(a[j].T) })
	return a
}

// groupHosts: one entry per VM, its services de-duplicated over the jobs that scrape them.
func groupHosts(targets []Target, inv map[string][2]string) []VM {
	type acc struct {
		h    VM
		svcs map[string]*HostService
	}
	byHost := map[string]*acc{}
	var order []string
	for _, t := range targets {
		host := instanceHost(t.Instance)
		if host == "localhost" || host == "127.0.0.1" {
			// Prometheus scraping itself: it runs on the monitoring VM
			for k, v := range inv {
				if strings.Contains(v[1], "prometheus") && net.ParseIP(k) != nil {
					host = k
					break
				}
			}
		}
		a := byHost[host]
		if a == nil {
			a = &acc{h: VM{Address: host, Name: host}, svcs: map[string]*HostService{}}
			if v, ok := inv[host]; ok {
				a.h.Name, a.h.Roles = v[0], v[1]
			}
			byHost[host] = a
			order = append(order, host)
		}
		switch t.Role { // Patroni roles (the inventory gives group names instead)
		case "leader", "master", "primary", "replica", "standby_leader", "sync_standby":
			a.h.Name, a.h.DBRole = t.Node, t.Role
		}
		sv := a.svcs[t.Service]
		if sv == nil {
			sv = &HostService{Service: t.Service, Up: true}
			a.svcs[t.Service] = sv
		}
		sv.Up = sv.Up && t.Up
		sv.Jobs = append(sv.Jobs, t.Job)
	}
	rank := map[string]int{"postgres": 0, "patroni": 1, "etcd": 2, "haproxy": 3, "pgbouncer": 4, "pgbackrest": 5,
		"prometheus": 6, "alertmanager": 7, "grafana": 8, "node": 9}
	out := make([]VM, 0, len(order))
	for _, k := range order {
		a := byHost[k]
		a.h.Up = true
		for _, sv := range a.svcs {
			a.h.Services = append(a.h.Services, *sv)
			a.h.Up = a.h.Up && sv.Up
		}
		sort.Slice(a.h.Services, func(i, j int) bool {
			ri, ok := rank[a.h.Services[i].Service]
			if !ok {
				ri = 99
			}
			rj, ok := rank[a.h.Services[j].Service]
			if !ok {
				rj = 99
			}
			return ri < rj
		})
		a.h.Kind = hostKind(a.h.Roles, a.h.Services)
		out = append(out, a.h)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}
