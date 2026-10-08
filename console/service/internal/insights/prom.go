package insights

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
	"time"
)

// Prometheus is a tiny client for the HTTP query API (query_range only).
type Prometheus struct {
	BaseURL string
	HTTP    *http.Client
}

type promSeries struct {
	Labels map[string]string
	Points []Point
}

func (p *Prometheus) rangeQuery(ctx context.Context, q string, start, end time.Time, step time.Duration) ([]promSeries, error) {
	u, err := url.Parse(strings.TrimRight(p.BaseURL, "/") + "/api/v1/query_range")
	if err != nil {
		return nil, err
	}
	v := url.Values{}
	v.Set("query", q)
	v.Set("start", strconv.FormatInt(start.Unix(), 10))
	v.Set("end", strconv.FormatInt(end.Unix(), 10))
	v.Set("step", strconv.Itoa(int(step.Seconds())))
	u.RawQuery = v.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	cli := p.HTTP
	if cli == nil {
		cli = &http.Client{Timeout: 15 * time.Second}
	}
	resp, err := cli.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var body struct {
		Status string `json:"status"`
		Error  string `json:"error"`
		Data   struct {
			Result []struct {
				Metric map[string]string `json:"metric"`
				Values [][2]any          `json:"values"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("prometheus answered %s: %w", resp.Status, err)
	}
	if body.Status != "success" {
		return nil, fmt.Errorf("prometheus: %s", body.Error)
	}
	var out []promSeries
	for _, r := range body.Data.Result {
		s := promSeries{Labels: r.Metric}
		for _, v := range r.Values {
			ts, _ := v[0].(float64)
			str, _ := v[1].(string)
			f, err := strconv.ParseFloat(str, 64)
			if err != nil {
				continue
			}
			s.Points = append(s.Points, Point{T: time.Unix(int64(ts), 0), V: f})
		}
		out = append(out, s)
	}
	return out, nil
}

// Host is one node's CPU, memory and disk (for the PostgreSQL data directory) from node_exporter.
type Host struct {
	Instance     string   `json:"instance"`
	Node         string   `json:"node,omitempty"` // the cluster server it belongs to
	Role         string   `json:"role,omitempty"`
	Cores        float64  `json:"cores"`
	CPU          []Point  `json:"cpu"` // % busy
	CPUP95       float64  `json:"cpu_p95"`
	CPUForecast  Forecast `json:"cpu_forecast"` // of the daily p95
	MemTotal     float64  `json:"mem_total_bytes"`
	Mem          []Point  `json:"mem"` // % used
	MemP95       float64  `json:"mem_p95"`
	MemForecast  Forecast `json:"mem_forecast"` // of the daily p95
	Mount        string   `json:"mount,omitempty"`
	DiskSize     float64  `json:"disk_size_bytes"`
	DiskUsed     []Point  `json:"disk_used"` // bytes
	DiskForecast Forecast `json:"disk_forecast"`
	DaysToFull   float64  `json:"days_to_full"` // -1 = not growing
	DaysTo80     float64  `json:"days_to_80pct"`
}

// instanceHost: "10.0.0.5:9100" -> "10.0.0.5"
func instanceHost(inst string) string {
	if h, _, err := net.SplitHostPort(inst); err == nil {
		return h
	}
	return inst
}

const fsFilter = `fstype!~"tmpfs|devtmpfs|overlay|squashfs|nsfs|ramfs|fuse.*"`

// Hosts reads CPU, memory and filesystem history for the nodes (servers: ip -> name / role). dataDir picks the
// filesystem that holds PostgreSQL's data directory (longest mount point prefix), else "/".
func (p *Prometheus) Hosts(ctx context.Context, servers map[string][2]string, dataDir string, days, horizon int, now time.Time) ([]Host, error) {
	if horizon <= 0 {
		horizon = 30
	}
	start := now.Add(-time.Duration(days) * 24 * time.Hour)
	step := time.Duration(days) * 24 * time.Hour / 240
	if step < 5*time.Minute {
		step = 5 * time.Minute
	}
	cpu, err := p.rangeQuery(ctx, `100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])))`, start, now, step)
	if err != nil {
		return nil, err
	}
	hosts := map[string]*Host{}
	get := func(inst string) *Host {
		h := hosts[inst]
		if h == nil {
			h = &Host{Instance: inst, DaysToFull: -1, DaysTo80: -1}
			if s, ok := servers[instanceHost(inst)]; ok {
				h.Node, h.Role = s[0], s[1]
			}
			hosts[inst] = h
		}
		return h
	}
	for _, s := range cpu {
		get(s.Labels["instance"]).CPU = s.Points
	}
	if cores, err := p.rangeQuery(ctx, `count by (instance) (node_cpu_seconds_total{mode="idle"})`, now.Add(-step), now, step); err == nil {
		for _, s := range cores {
			get(s.Labels["instance"]).Cores = Last(s.Points)
		}
	}
	if mem, err := p.rangeQuery(ctx, `100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)`, start, now, step); err == nil {
		for _, s := range mem {
			get(s.Labels["instance"]).Mem = s.Points
		}
	}
	if mt, err := p.rangeQuery(ctx, `node_memory_MemTotal_bytes`, now.Add(-step), now, step); err == nil {
		for _, s := range mt {
			get(s.Labels["instance"]).MemTotal = Last(s.Points)
		}
	}
	// filesystems: pick the one holding the data directory per instance
	sizes, _ := p.rangeQuery(ctx, `node_filesystem_size_bytes{`+fsFilter+`}`, now.Add(-step), now, step)
	mount := map[string]string{}
	for _, s := range sizes {
		inst, mp := s.Labels["instance"], s.Labels["mountpoint"]
		if !mountMatches(mp, dataDir) {
			continue
		}
		if cur, ok := mount[inst]; !ok || len(mp) > len(cur) {
			mount[inst] = mp
			get(inst).DiskSize = Last(s.Points)
			get(inst).Mount = mp
		}
	}
	for inst, mp := range mount {
		used, err := p.rangeQuery(ctx, fmt.Sprintf(`node_filesystem_size_bytes{instance=%q,mountpoint=%q} - node_filesystem_avail_bytes{instance=%q,mountpoint=%q}`,
			inst, mp, inst, mp), start, now, step)
		if err == nil && len(used) > 0 {
			get(inst).DiskUsed = used[0].Points
		}
	}

	var out []Host
	for _, h := range hosts {
		h.CPUP95 = Percentile(h.CPU, 95)
		h.MemP95 = Percentile(h.Mem, 95)
		h.CPUForecast = MakeForecast(dailyPercentile(h.CPU, 95), horizon, now)
		h.MemForecast = MakeForecast(dailyPercentile(h.Mem, 95), horizon, now)
		h.DiskForecast = MakeForecast(h.DiskUsed, horizon, now)
		if fit, ok := LinearFit(h.DiskUsed); ok && h.DiskSize > 0 {
			h.DaysToFull = fit.DaysUntil(h.DiskSize, now)
			h.DaysTo80 = fit.DaysUntil(0.8*h.DiskSize, now)
		}
		h.CPU = Downsample(h.CPU, 240)
		h.Mem = Downsample(h.Mem, 240)
		h.DiskUsed = Downsample(h.DiskUsed, 240)
		out = append(out, *h)
	}
	sort.Slice(out, func(i, j int) bool {
		if (out[i].Node == "") != (out[j].Node == "") {
			return out[i].Node != "" // cluster nodes first
		}
		return out[i].Instance < out[j].Instance
	})
	return out, nil
}

func mountMatches(mount, dataDir string) bool {
	if dataDir == "" {
		return mount == "/"
	}
	return mount == "/" || dataDir == mount || strings.HasPrefix(dataDir, strings.TrimRight(mount, "/")+"/")
}

// dailyPercentile: one point per day (the day's p-th percentile), for trends of busy-hour load.
func dailyPercentile(pts []Point, p float64) []Point {
	byDay := map[string][]Point{}
	var days []string
	for _, x := range pts {
		d := x.T.UTC().Format("2006-01-02")
		if _, ok := byDay[d]; !ok {
			days = append(days, d)
		}
		byDay[d] = append(byDay[d], x)
	}
	sort.Strings(days)
	var out []Point
	for _, d := range days {
		v := byDay[d]
		out = append(out, Point{T: v[len(v)-1].T, V: Percentile(v, p)})
	}
	// with less than 3 days, use the raw points so short histories still show a trend
	if len(out) < 3 {
		return pts
	}
	return out
}
