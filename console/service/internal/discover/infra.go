package discover

// Everything around PostgreSQL: which machine runs the load balancer (HAProxy, nginx, pgpool), the virtual IP
// (keepalived, vip-manager), the pooler (PgBouncer, Odyssey), the HA manager and its store (Patroni + etcd /
// Consul, repmgr), backups (pgBackRest, Barman, WAL-G) and monitoring (Prometheus, Grafana, Alertmanager,
// exporters) - with versions and package names. Three sources, each optional:
//   - the network: open ports, and the HTTP endpoints that say what and which version they are;
//   - SSH (read-only): packages, running services, listening programs, and the relevant config files;
//   - Prometheus: every scrape target it knows.

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// SSHAuth: how to log in to the machines (read-only commands only). The secret is used for this run only.
type SSHAuth struct {
	User     string
	Port     int
	Password string
	Key      string // private key (PEM / OpenSSH)
}

type Disk struct {
	Mount string  `json:"mount"`
	FS    string  `json:"fs"`
	Size  float64 `json:"size_bytes"`
	Used  float64 `json:"used_bytes"`
}

type Listen struct {
	Port    int    `json:"port"`
	Addr    string `json:"addr"`
	Process string `json:"process,omitempty"`
}

type Package struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// Component is one piece of software found on a machine.
type Component struct {
	Kind     string            `json:"kind"`  // haproxy, nginx, keepalived, pgbouncer, postgres, patroni, etcd, ...
	Layer    string            `json:"layer"` // entry | balancer | pooler | database | ha | dcs | backup | monitoring | platform
	Label    string            `json:"label"` // display name
	Version  string            `json:"version,omitempty"`
	Package  string            `json:"package,omitempty"` // package name and full version, e.g. "haproxy 2.8.5-1.el9"
	Path     string            `json:"path,omitempty"`
	Running  bool              `json:"running"`
	Ports    []int             `json:"ports,omitempty"`
	Sources  []string          `json:"sources"` // package | binary | service | process | container | port | http | prometheus
	Details  map[string]string `json:"details,omitempty"`
	Endpoint string            `json:"endpoint,omitempty"` // an HTTP endpoint that answered
}

// Route: a load balancer entry point and where it sends connections.
type Route struct {
	Host     string   `json:"host"` // the balancer machine (inventory address)
	Kind     string   `json:"kind"` // haproxy | nginx | pgpool
	Name     string   `json:"name"`
	Port     int      `json:"port"`
	Mode     string   `json:"mode,omitempty"`
	Targets  []string `json:"targets"`  // ip:port
	TargetOf []string `json:"resolved"` // inventory addresses of the targets (where known)
}

// HostInfo is one machine.
type HostInfo struct {
	Address    string       `json:"address"`
	Name       string       `json:"name,omitempty"`
	Groups     []string     `json:"groups,omitempty"`
	Reachable  bool         `json:"reachable"` // answered on at least one port
	OpenPorts  []int        `json:"open_ports"`
	SSH        string       `json:"ssh"` // ok | failed | not tried
	SSHError   string       `json:"ssh_error,omitempty"`
	Sudo       string       `json:"sudo,omitempty"`
	OS         string       `json:"os,omitempty"`
	Kernel     string       `json:"kernel,omitempty"`
	Arch       string       `json:"arch,omitempty"`
	CPUs       int          `json:"cpus,omitempty"`
	CPUModel   string       `json:"cpu_model,omitempty"`
	MemBytes   float64      `json:"mem_bytes,omitempty"`
	SwapBytes  float64      `json:"swap_bytes,omitempty"`
	Virt       string       `json:"virtualization,omitempty"`
	BootedAt   string       `json:"booted_at,omitempty"`
	Load       string       `json:"load,omitempty"`
	Disks      []Disk       `json:"disks,omitempty"`
	Listening  []Listen     `json:"listening,omitempty"`
	Services   []string     `json:"services,omitempty"`
	Packages   []Package    `json:"packages,omitempty"`
	Components []*Component `json:"components"`
	Roles      []string     `json:"roles"` // layers present, in order
	VIPs       []string     `json:"vips,omitempty"`
	pgPort     int
	declaredDB bool
	raw        map[string]string // SSH sections (configs), not returned
}

type PromTarget struct {
	Job      string `json:"job"`
	Instance string `json:"instance"`
	Health   string `json:"health"`
	Host     string `json:"host,omitempty"` // inventory address
}

type Infra struct {
	Stack      string       `json:"stack"` // e.g. "Patroni HA cluster (CPA / Autobase layout)"
	Summary    []string     `json:"summary"`
	Hosts      []*HostInfo  `json:"hosts"`
	Routes     []Route      `json:"routes"`
	VIPs       []string     `json:"vips"`
	Prometheus string       `json:"prometheus,omitempty"`
	PromError  string       `json:"prometheus_error,omitempty"`
	Targets    []PromTarget `json:"prometheus_targets,omitempty"`
	SSHUsed    bool         `json:"ssh_used"`
}

/* ------------------------------------------------------------ catalog ------------------------------------------------------------ */

type compDef struct {
	kind, layer, label string
	pkgs               []string // package name prefixes
	procs              []string // process names (ss / systemd units)
	bins               []string
	ports              []int
	images             []string // container image name parts
}

var catalog = []compDef{
	{kind: "keepalived", layer: "entry", label: "keepalived (VIP)", pkgs: []string{"keepalived"}, procs: []string{"keepalived"}, bins: []string{"keepalived"}},
	{kind: "vip-manager", layer: "entry", label: "vip-manager (VIP)", pkgs: []string{"vip-manager"}, procs: []string{"vip-manager"}, bins: []string{"vip-manager"}},
	{kind: "haproxy", layer: "balancer", label: "HAProxy", pkgs: []string{"haproxy"}, procs: []string{"haproxy"}, bins: []string{"haproxy"}, images: []string{"haproxy"}},
	{kind: "nginx", layer: "balancer", label: "nginx", pkgs: []string{"nginx"}, procs: []string{"nginx"}, bins: []string{"nginx"}, images: []string{"nginx"}},
	{kind: "pgpool", layer: "balancer", label: "Pgpool-II", pkgs: []string{"pgpool"}, procs: []string{"pgpool"}, bins: []string{"pgpool"}, ports: []int{9999}},
	{kind: "pgbouncer", layer: "pooler", label: "PgBouncer", pkgs: []string{"pgbouncer"}, procs: []string{"pgbouncer"}, bins: []string{"pgbouncer"}, ports: []int{6432}, images: []string{"pgbouncer"}},
	{kind: "odyssey", layer: "pooler", label: "Odyssey", pkgs: []string{"odyssey"}, procs: []string{"odyssey"}, bins: []string{"odyssey"}},
	{kind: "postgres", layer: "database", label: "PostgreSQL", pkgs: []string{"postgresql", "postgres"}, procs: []string{"postgres", "postmaster"}, images: []string{"postgres", "postgis", "timescale", "spilo"}},
	{kind: "patroni", layer: "ha", label: "Patroni", pkgs: []string{"patroni"}, procs: []string{"patroni"}, bins: []string{"patroni"}, ports: []int{8008}},
	{kind: "repmgr", layer: "ha", label: "repmgr", pkgs: []string{"repmgr"}, procs: []string{"repmgrd"}, bins: []string{"repmgr"}},
	{kind: "pg_auto_failover", layer: "ha", label: "pg_auto_failover", pkgs: []string{"pg-auto-failover", "pg_auto_failover"}, procs: []string{"pg_autoctl"}},
	{kind: "etcd", layer: "dcs", label: "etcd", pkgs: []string{"etcd"}, procs: []string{"etcd"}, bins: []string{"etcd"}, ports: []int{2379}, images: []string{"etcd"}},
	{kind: "consul", layer: "dcs", label: "Consul", pkgs: []string{"consul"}, procs: []string{"consul"}, bins: []string{"consul"}, ports: []int{8500}, images: []string{"consul"}},
	{kind: "zookeeper", layer: "dcs", label: "ZooKeeper", pkgs: []string{"zookeeper"}, ports: []int{2181}},
	{kind: "pgbackrest", layer: "backup", label: "pgBackRest", pkgs: []string{"pgbackrest"}, bins: []string{"pgbackrest"}},
	{kind: "barman", layer: "backup", label: "Barman", pkgs: []string{"barman"}, bins: []string{"barman"}},
	{kind: "wal-g", layer: "backup", label: "WAL-G", pkgs: []string{"wal-g"}, bins: []string{"wal-g"}},
	{kind: "prometheus", layer: "monitoring", label: "Prometheus", pkgs: []string{"prometheus", "golang-github-prometheus"}, procs: []string{"prometheus"}, bins: []string{"prometheus"}, ports: []int{9090}, images: []string{"prometheus"}},
	{kind: "alertmanager", layer: "monitoring", label: "Alertmanager", pkgs: []string{"alertmanager", "prometheus-alertmanager"}, procs: []string{"alertmanager"}, bins: []string{"alertmanager"}, ports: []int{9093}, images: []string{"alertmanager"}},
	{kind: "grafana", layer: "monitoring", label: "Grafana", pkgs: []string{"grafana"}, procs: []string{"grafana", "grafana-server"}, bins: []string{"grafana-server", "grafana"}, ports: []int{3000}, images: []string{"grafana"}},
	{kind: "node_exporter", layer: "monitoring", label: "node_exporter", pkgs: []string{"node_exporter", "node-exporter", "prometheus-node-exporter", "golang-github-prometheus-node-exporter"}, procs: []string{"node_exporter", "prometheus-node-exporter"}, bins: []string{"node_exporter"}, ports: []int{9100}, images: []string{"node-exporter"}},
	{kind: "postgres_exporter", layer: "monitoring", label: "postgres_exporter", pkgs: []string{"postgres_exporter", "prometheus-postgres-exporter"}, procs: []string{"postgres_exporter", "prometheus-postgres-exporter"}, bins: []string{"postgres_exporter"}, ports: []int{9187}},
	{kind: "pgbouncer_exporter", layer: "monitoring", label: "pgbouncer_exporter", pkgs: []string{"pgbouncer_exporter", "prometheus-pgbouncer-exporter"}, procs: []string{"pgbouncer_exporter"}, ports: []int{9127}},
	{kind: "docker", layer: "platform", label: "Docker", pkgs: []string{"docker-ce", "docker.io", "moby-engine", "docker"}, procs: []string{"dockerd"}, bins: []string{"docker"}},
	{kind: "podman", layer: "platform", label: "Podman", pkgs: []string{"podman"}, bins: []string{"podman"}},
}

var layerOrder = []string{"entry", "balancer", "pooler", "database", "ha", "dcs", "backup", "monitoring", "platform"}

func defOf(kind string) *compDef {
	for i := range catalog {
		if catalog[i].kind == kind {
			return &catalog[i]
		}
	}
	return nil
}

// the ports worth knocking on, and what usually answers there
var probePorts = []int{22, 80, 443, 2379, 2380, 3000, 5000, 5001, 5002, 5432, 6432, 7000, 8008, 8009, 8404, 8500, 9090, 9093, 9100, 9101, 9127, 9187, 9999}

/* ------------------------------------------------------------ one machine ------------------------------------------------------------ */

func (h *HostInfo) comp(kind string) *Component {
	for _, c := range h.Components {
		if c.Kind == kind {
			return c
		}
	}
	d := defOf(kind)
	c := &Component{Kind: kind, Layer: "other", Label: kind, Sources: []string{}}
	if d != nil {
		c.Layer, c.Label = d.layer, d.label
	}
	h.Components = append(h.Components, c)
	return c
}

func (c *Component) source(s string) {
	for _, x := range c.Sources {
		if x == s {
			return
		}
	}
	c.Sources = append(c.Sources, s)
}

func (c *Component) port(p int) {
	for _, x := range c.Ports {
		if x == p {
			return
		}
	}
	c.Ports = append(c.Ports, p)
	sort.Ints(c.Ports)
}

func (c *Component) detail(k, v string) {
	if v == "" {
		return
	}
	if c.Details == nil {
		c.Details = map[string]string{}
	}
	c.Details[k] = v
}

var versionRe = regexp.MustCompile(`\d+\.\d+(?:\.\d+)?`) // the full build string stays in the package name

func firstVersion(s string) string {
	return versionRe.FindString(s)
}

func probeHost(ctx context.Context, ih InvHost, auth *SSHAuth, keyFile, askpass string) *HostInfo {
	h := &HostInfo{Address: ih.Address, Name: ih.Name, Groups: ih.Groups, SSH: "not tried", Components: []*Component{},
		OpenPorts: []int{}, Roles: []string{}, pgPort: ih.PGPort, declaredDB: ih.DeclaredDB(), raw: map[string]string{}}
	ports := append([]int{}, probePorts...)
	if ih.PGPort != 0 && ih.PGPort != 5432 {
		ports = append(ports, ih.PGPort)
	}
	h.OpenPorts = scanPorts(ctx, ih.Address, ports)
	h.Reachable = len(h.OpenPorts) > 0
	if auth != nil && auth.User != "" {
		port := auth.Port
		if ih.SSHPort != 0 {
			port = ih.SSHPort
		}
		if out, err := runSSH(ctx, ih.Address, port, auth, keyFile, askpass); err != nil {
			h.SSH, h.SSHError = "failed", err.Error()
		} else {
			h.SSH = "ok"
			h.Reachable = true
			parseProbe(h, out)
		}
	}
	fingerprint(ctx, h)
	finish(h)
	return h
}

func scanPorts(ctx context.Context, host string, ports []int) []int {
	var mu sync.Mutex
	var open []int
	var wg sync.WaitGroup
	d := net.Dialer{Timeout: 1500 * time.Millisecond}
	for _, p := range ports {
		wg.Add(1)
		go func(p int) {
			defer wg.Done()
			c, err := d.DialContext(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(p)))
			if err == nil {
				c.Close()
				mu.Lock()
				open = append(open, p)
				mu.Unlock()
			}
		}(p)
	}
	wg.Wait()
	sort.Ints(open)
	return open
}

func has(list []int, p int) bool {
	for _, x := range list {
		if x == p {
			return true
		}
	}
	return false
}

/* ------------------------------------------------------------ HTTP fingerprints ------------------------------------------------------------ */

var httpc = &http.Client{Timeout: 3 * time.Second, Transport: &http.Transport{
	TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, // only reads version banners of the client's own servers
	Proxy:           nil,
}}

func get(ctx context.Context, url string, limit int64) (string, http.Header, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	resp, err := httpc.Do(req)
	if err != nil {
		return "", nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, limit))
	return string(b), resp.Header, nil
}

var buildInfoRe = regexp.MustCompile(`(?m)^(\w+?)_build_info\{[^}]*\bversion="([^"]+)"`)

func fingerprint(ctx context.Context, h *HostInfo) {
	base := func(p int) string { return "http://" + net.JoinHostPort(h.Address, strconv.Itoa(p)) }
	type fp struct {
		port int
		fn   func()
	}
	var mu sync.Mutex
	set := func(kind, version, endpoint string, port int) {
		mu.Lock()
		defer mu.Unlock()
		c := h.comp(kind)
		c.source("http")
		c.Running = true
		c.port(port)
		if c.Version == "" {
			c.Version = version
		}
		if c.Endpoint == "" {
			c.Endpoint = endpoint
		}
	}
	checks := []fp{
		{9090, func() {
			u := base(9090) + "/api/v1/status/buildinfo"
			if b, _, err := get(ctx, u, 64<<10); err == nil {
				var r struct {
					Data struct{ Version string } `json:"data"`
				}
				if json.Unmarshal([]byte(b), &r) == nil && r.Data.Version != "" {
					set("prometheus", r.Data.Version, base(9090), 9090)
				}
			}
		}},
		{9093, func() {
			if b, _, err := get(ctx, base(9093)+"/api/v2/status", 64<<10); err == nil {
				var r struct {
					VersionInfo struct{ Version string } `json:"versionInfo"`
				}
				if json.Unmarshal([]byte(b), &r) == nil && r.VersionInfo.Version != "" {
					set("alertmanager", r.VersionInfo.Version, base(9093), 9093)
				}
			}
		}},
		{3000, func() {
			if b, _, err := get(ctx, base(3000)+"/api/health", 64<<10); err == nil {
				var r struct{ Version string }
				if json.Unmarshal([]byte(b), &r) == nil && r.Version != "" {
					set("grafana", r.Version, base(3000), 3000)
				}
			}
		}},
		{2379, func() {
			for _, scheme := range []string{"http", "https"} {
				u := scheme + "://" + net.JoinHostPort(h.Address, "2379") + "/version"
				if b, _, err := get(ctx, u, 16<<10); err == nil {
					var r struct {
						Server string `json:"etcdserver"`
					}
					if json.Unmarshal([]byte(b), &r) == nil && r.Server != "" {
						set("etcd", r.Server, u, 2379)
						return
					}
				}
			}
		}},
		{8500, func() {
			if b, _, err := get(ctx, base(8500)+"/v1/agent/self", 256<<10); err == nil && strings.Contains(b, "Config") {
				set("consul", firstVersion(regexp.MustCompile(`"Version":"[^"]+"`).FindString(b)), base(8500), 8500)
			}
		}},
		{7000, func() {
			if b, hdr, err := get(ctx, base(7000)+"/", 64<<10); err == nil && (strings.Contains(b, "HAProxy") || strings.Contains(hdr.Get("Server"), "HAProxy")) {
				set("haproxy", firstVersion(regexp.MustCompile(`HAProxy version [0-9.]+`).FindString(b)), base(7000), 7000)
			}
		}},
	}
	for _, p := range []int{8008, 8009} {
		p := p
		checks = append(checks, fp{p, func() {
			if b, _, err := get(ctx, base(p)+"/patroni", 64<<10); err == nil {
				var r struct {
					Role    string `json:"role"`
					State   string `json:"state"`
					Patroni struct {
						Version string `json:"version"`
						Scope   string `json:"scope"`
						Name    string `json:"name"`
					} `json:"patroni"`
				}
				if json.Unmarshal([]byte(b), &r) == nil && (r.Patroni.Version != "" || r.Role != "") {
					set("patroni", r.Patroni.Version, base(p)+"/patroni", p)
					mu.Lock()
					c := h.comp("patroni")
					c.detail("scope", r.Patroni.Scope)
					c.detail("member", r.Patroni.Name)
					c.detail("role", r.Role)
					c.detail("state", r.State)
					mu.Unlock()
				}
			}
		}})
	}
	for _, p := range []int{80, 443} {
		p := p
		checks = append(checks, fp{p, func() {
			scheme := "http"
			if p == 443 {
				scheme = "https"
			}
			if _, hdr, err := get(ctx, scheme+"://"+net.JoinHostPort(h.Address, strconv.Itoa(p))+"/", 16<<10); err == nil {
				srv := strings.ToLower(hdr.Get("Server"))
				switch {
				case strings.HasPrefix(srv, "nginx"):
					set("nginx", firstVersion(srv), "", p)
				case strings.Contains(srv, "haproxy"):
					set("haproxy", firstVersion(srv), "", p)
				}
			}
		}})
	}
	// exporters announce their version in <name>_build_info
	for _, p := range []int{9100, 9187, 9127, 8404, 9101} {
		p := p
		checks = append(checks, fp{p, func() {
			b, _, err := get(ctx, base(p)+"/metrics", 2<<20)
			if err != nil {
				return
			}
			for _, m := range buildInfoRe.FindAllStringSubmatch(b, -1) {
				kind := map[string]string{"node_exporter": "node_exporter", "postgres_exporter": "postgres_exporter",
					"pg_exporter": "postgres_exporter", "pgbouncer_exporter": "pgbouncer_exporter", "haproxy_process": "haproxy",
					"haproxy": "haproxy", "haproxy_exporter": "haproxy"}[m[1]]
				if kind != "" {
					set(kind, m[2], base(p)+"/metrics", p)
					break
				}
			}
		}})
	}
	var wg sync.WaitGroup
	for _, c := range checks {
		if !has(h.OpenPorts, c.port) {
			continue
		}
		wg.Add(1)
		go func(f func()) { defer wg.Done(); f() }(c.fn)
	}
	wg.Wait()
}

/* ------------------------------------------------------------ SSH ------------------------------------------------------------ */

// probeScript runs on every machine. It only reads; secrets are filtered out of the config extracts.
const probeScript = `export LC_ALL=C PATH=$PATH:/usr/sbin:/sbin:/usr/local/bin
R() { if [ "$(id -u)" = 0 ]; then "$@" 2>/dev/null; else sudo -n "$@" 2>/dev/null || "$@" 2>/dev/null; fi; }
echo "@@host"
echo "hostname=$(hostname -f 2>/dev/null || hostname)"
if [ -r /etc/os-release ]; then . /etc/os-release; echo "os=$PRETTY_NAME"; fi
echo "kernel=$(uname -r)"; echo "arch=$(uname -m)"
echo "cpus=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)"
echo "cpu_model=$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ *//')"
echo "mem_kb=$(awk '/^MemTotal/{print $2}' /proc/meminfo)"
echo "swap_kb=$(awk '/^SwapTotal/{print $2}' /proc/meminfo)"
echo "virt=$(systemd-detect-virt 2>/dev/null)"
echo "boot=$(uptime -s 2>/dev/null)"
echo "load=$(cut -d' ' -f1-3 /proc/loadavg)"
if [ "$(id -u)" = 0 ]; then echo "sudo=root"; elif sudo -n true 2>/dev/null; then echo "sudo=yes"; else echo "sudo=no"; fi
echo "@@disk"; df -PB1 -T -x tmpfs -x devtmpfs -x overlay -x squashfs 2>/dev/null | tail -n +2
echo "@@listen"; R ss -Hltnp || ss -Hltn 2>/dev/null
echo "@@services"; systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null | awk '{print $1}'
echo "@@packages"; { rpm -qa --qf '%{NAME}\t%{VERSION}-%{RELEASE}\n' 2>/dev/null || dpkg-query -W -f='${db:Status-Abbrev}\t${Package}\t${Version}\n' 2>/dev/null | awk -F'\t' '$1 ~ /^ii/ {print $2"\t"$3}'; } | grep -Ei '^(postgres|pg|patroni|etcd|haproxy|nginx|keepalived|vip-manager|pgbouncer|odyssey|pgbackrest|pgpool|repmgr|barman|wal-g|consul|zookeeper|prometheus|alertmanager|grafana|node.exporter|golang-github-prometheus|docker|moby|containerd|podman|timescaledb|citus|python3-(patroni|psycopg|etcd))'
echo "@@versions"
for b in patroni etcd haproxy nginx pgbouncer odyssey pgbackrest keepalived vip-manager prometheus alertmanager grafana-server node_exporter postgres_exporter consul repmgr pgpool barman wal-g docker podman; do
  p=$(command -v $b 2>/dev/null) || continue
  case $b in nginx|haproxy|keepalived) v=$($p -v 2>&1 | head -1);; pgbackrest) v=$($p version 2>&1 | head -1);; *) v=$($p --version 2>&1 | head -1);; esac
  printf '%s\t%s\t%s\n' "$b" "$p" "$v"
done
for p in /usr/pgsql-*/bin/postgres /usr/lib/postgresql/*/bin/postgres /usr/local/pgsql/bin/postgres; do [ -x "$p" ] && printf 'postgres\t%s\t%s\n' "$p" "$($p --version 2>&1 | head -1)"; done
echo "@@docker"; R docker ps --format '{{.Image}}\t{{.Names}}\t{{.Ports}}' 2>/dev/null
echo "@@haproxy"; R cat /etc/haproxy/haproxy.cfg | grep -Ev '^[[:space:]]*#' | grep -Ei '^[[:space:]]*(listen|frontend|backend|bind|server|mode|default_backend)[[:space:]]' | grep -Eiv 'auth|password|pass ' | head -300
echo "@@nginx"; R sh -c 'cat /etc/nginx/nginx.conf /etc/nginx/conf.d/*.conf /etc/nginx/stream.d/*.conf /etc/nginx/streams-enabled/* /etc/nginx/sites-enabled/* 2>/dev/null' | grep -Ev '^[[:space:]]*#' | grep -Ei '^[[:space:]]*(stream|http|upstream|server|listen|proxy_pass)([[:space:]]|\{|$)' | grep -Eiv 'password' | head -300
echo "@@keepalived"; R cat /etc/keepalived/keepalived.conf | grep -Ev '^[[:space:]]*#' | grep -Eiv 'auth_pass|auth_type' | head -120
echo "@@patroni"; for f in /etc/patroni/patroni.yml /etc/patroni.yml /etc/patroni/config.yml; do if R test -r "$f"; then R cat "$f" | grep -Ei '^[[:space:]]*(scope|namespace|name|listen|connect_address|hosts?|etcd3?|consul|data_dir|bin_dir)[[:space:]]*:' | grep -Eiv 'pass'; break; fi; done
echo "@@pgbouncer"; R cat /etc/pgbouncer/pgbouncer.ini | grep -Ev '^[[:space:]]*[;#]' | grep -Eiv 'pass|auth_query|auth_user' | head -100
echo "@@etcd"; R sh -c 'cat /etc/etcd/etcd.conf /etc/default/etcd /etc/etcd/etcd.conf.yml /etc/etcd/etcd.env 2>/dev/null' | grep -Ei '(name|initial.cluster|listen.client|advertise.client)' | grep -Eiv 'pass|token' | head -40
echo "@@prometheus"; R cat /etc/prometheus/prometheus.yml | grep -Ei '(job_name|targets|^[[:space:]]+- )' | grep -Eiv 'pass' | head -200
echo "@@pgbackrest"; R sh -c 'cat /etc/pgbackrest.conf /etc/pgbackrest/pgbackrest.conf 2>/dev/null' | grep -Ev '^[[:space:]]*#' | grep -Eiv 'pass|key|secret|cipher|token' | head -80
echo "@@end"
`

func prepareSSH(auth *SSHAuth) (dir, keyFile, askpass string, err error) {
	if auth == nil || auth.User == "" {
		return "", "", "", nil
	}
	dir, err = os.MkdirTemp("", "pggenin-ssh-")
	if err != nil {
		return "", "", "", err
	}
	if strings.TrimSpace(auth.Key) != "" {
		keyFile = filepath.Join(dir, "key")
		key := strings.TrimSpace(strings.ReplaceAll(auth.Key, "\r\n", "\n")) + "\n"
		if err = os.WriteFile(keyFile, []byte(key), 0o600); err != nil {
			return dir, "", "", err
		}
	}
	if auth.Password != "" {
		askpass = filepath.Join(dir, "askpass")
		// the password reaches ssh through the environment, never the command line
		if err = os.WriteFile(askpass, []byte("#!/bin/sh\nprintf '%s\\n' \"$PGGENIN_SSH_SECRET\"\n"), 0o700); err != nil {
			return dir, "", "", err
		}
	}
	return dir, keyFile, askpass, nil
}

func runSSH(ctx context.Context, host string, port int, auth *SSHAuth, keyFile, askpass string) (string, error) {
	if port == 0 {
		port = 22
	}
	if _, err := exec.LookPath("ssh"); err != nil {
		return "", fmt.Errorf("the ssh client is not installed in the console")
	}
	cctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	args := []string{"-p", strconv.Itoa(port), "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
		"-o", "LogLevel=ERROR", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=2",
		"-o", "NumberOfPasswordPrompts=1", "-o", "PreferredAuthentications=publickey,password,keyboard-interactive",
		"-T"}
	if keyFile != "" {
		args = append(args, "-i", keyFile, "-o", "IdentitiesOnly=yes")
	}
	if askpass == "" {
		args = append(args, "-o", "BatchMode=yes")
	}
	args = append(args, auth.User+"@"+host, "sh -s")
	cmd := exec.CommandContext(cctx, "ssh", args...)
	cmd.Stdin = strings.NewReader(probeScript)
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	if askpass != "" {
		cmd.Env = append(cmd.Env, "SSH_ASKPASS="+askpass, "SSH_ASKPASS_REQUIRE=force", "DISPLAY=none", "PGGENIN_SSH_SECRET="+auth.Password)
	}
	var out, errb strings.Builder
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	if !strings.Contains(out.String(), "@@host") {
		msg := strings.TrimSpace(errb.String())
		switch {
		case strings.Contains(msg, "Permission denied"):
			msg = "SSH login refused (wrong user, password or key)"
		case strings.Contains(msg, "Connection refused"):
			msg = "SSH port closed"
		case strings.Contains(msg, "timed out"), cctx.Err() != nil:
			msg = "SSH did not answer in time"
		case msg == "" && err != nil:
			msg = err.Error()
		}
		return "", fmt.Errorf("%s", msg)
	}
	return out.String(), nil
}

func parseProbe(h *HostInfo, out string) {
	sections := map[string][]string{}
	cur := ""
	sc := bufio.NewScanner(strings.NewReader(out))
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		l := sc.Text()
		if strings.HasPrefix(l, "@@") {
			cur = strings.TrimPrefix(l, "@@")
			continue
		}
		sections[cur] = append(sections[cur], l)
	}
	for _, l := range sections["host"] {
		k, v, _ := strings.Cut(l, "=")
		switch k {
		case "hostname":
			if h.Name == "" {
				h.Name = v
			}
		case "os":
			h.OS = v
		case "kernel":
			h.Kernel = v
		case "arch":
			h.Arch = v
		case "cpus":
			h.CPUs = atoi(v)
		case "cpu_model":
			h.CPUModel = v
		case "mem_kb":
			h.MemBytes = atof(v) * 1024
		case "swap_kb":
			h.SwapBytes = atof(v) * 1024
		case "virt":
			h.Virt = v
		case "boot":
			h.BootedAt = v
		case "load":
			h.Load = v
		case "sudo":
			h.Sudo = v
		}
	}
	for _, l := range sections["disk"] {
		f := strings.Fields(l) // fs type size used avail pct mount
		if len(f) >= 7 && atof(f[2]) > 0 {
			h.Disks = append(h.Disks, Disk{FS: f[1], Size: atof(f[2]), Used: atof(f[3]), Mount: f[6]})
		}
	}
	procRe := regexp.MustCompile(`\(\("([^"]+)"`)
	for _, l := range sections["listen"] {
		f := strings.Fields(l)
		if len(f) < 4 {
			continue
		}
		local := f[3]
		i := strings.LastIndex(local, ":")
		if i < 0 {
			continue
		}
		port := atoi(local[i+1:])
		li := Listen{Port: port, Addr: strings.Trim(local[:i], "[]")}
		if m := procRe.FindStringSubmatch(l); m != nil {
			li.Process = m[1]
		}
		dup := false
		for _, x := range h.Listening {
			if x.Port == li.Port && x.Process == li.Process {
				dup = true
			}
		}
		if !dup && port > 0 {
			h.Listening = append(h.Listening, li)
		}
	}
	sort.Slice(h.Listening, func(i, j int) bool { return h.Listening[i].Port < h.Listening[j].Port })
	for _, l := range sections["services"] {
		if l = strings.TrimSpace(l); l != "" {
			h.Services = append(h.Services, strings.TrimSuffix(l, ".service"))
		}
	}
	for _, l := range sections["packages"] {
		if name, ver, ok := strings.Cut(l, "\t"); ok {
			h.Packages = append(h.Packages, Package{Name: name, Version: ver})
		}
	}
	sort.Slice(h.Packages, func(i, j int) bool { return h.Packages[i].Name < h.Packages[j].Name })

	// packages -> components (the main package of each kind)
	for _, p := range h.Packages {
		if d := matchPkg(p.Name); d != nil {
			c := h.comp(d.kind)
			c.source("package")
			if c.Package == "" || len(p.Name) < len(strings.Fields(c.Package)[0]) {
				c.Package = p.Name + " " + p.Version
			}
		}
	}
	// binaries -> version and path
	for _, l := range sections["versions"] {
		f := strings.SplitN(l, "\t", 3)
		if len(f) < 3 {
			continue
		}
		kind := map[string]string{"grafana-server": "grafana", "pgpool": "pgpool", "podman": "podman"}[f[0]]
		if kind == "" {
			kind = f[0]
		}
		if defOf(kind) == nil {
			continue
		}
		c := h.comp(kind)
		c.source("binary")
		if c.Path == "" {
			c.Path = f[1]
		}
		if v := firstVersion(f[2]); v != "" && (c.Version == "" || kind == "postgres" && v > c.Version) {
			c.Version = v
		}
	}
	// listening programs and running services -> running, ports
	for _, li := range h.Listening {
		for _, d := range catalog {
			for _, p := range d.procs {
				if li.Process == p || strings.HasPrefix(li.Process, p) && d.kind != "postgres" {
					c := h.comp(d.kind)
					c.source("process")
					c.Running = true
					c.port(li.Port)
				}
			}
		}
	}
	for _, s := range h.Services {
		for _, d := range catalog {
			for _, p := range d.procs {
				if s == p || strings.HasPrefix(s, p+"-") || strings.HasPrefix(s, p+"@") || strings.HasPrefix(s, p+"_") ||
					(d.kind == "postgres" && strings.HasPrefix(s, "postgresql")) {
					c := h.comp(d.kind)
					c.source("service")
					c.Running = true
					c.detail("service", s)
				}
			}
		}
	}
	for _, l := range sections["docker"] {
		f := strings.Split(l, "\t")
		if len(f) < 2 {
			continue
		}
		img := strings.ToLower(f[0])
		for _, d := range catalog {
			for _, part := range d.images {
				if strings.Contains(img, part) {
					c := h.comp(d.kind)
					c.source("container")
					c.Running = true
					c.detail("container", f[1]+" ("+f[0]+")")
					if v := firstVersion(img[strings.LastIndex(img, ":")+1:]); v != "" && c.Version == "" {
						c.Version = v
					}
				}
			}
		}
	}
	for _, k := range []string{"haproxy", "nginx", "keepalived", "patroni", "pgbouncer", "etcd", "prometheus", "pgbackrest"} {
		if len(sections[k]) > 0 {
			h.raw[k] = strings.Join(sections[k], "\n")
		}
	}
	configDetails(h)
}

// matchPkg: the component a package belongs to; an exact package name wins over a prefix
// ("prometheus-node-exporter" is node_exporter, not prometheus)
func matchPkg(name string) *compDef {
	n := strings.ToLower(name)
	for i := range catalog {
		for _, p := range catalog[i].pkgs {
			if n == p {
				return &catalog[i]
			}
		}
	}
	for i := range catalog {
		if pkgMatches(n, catalog[i]) {
			return &catalog[i]
		}
	}
	return nil
}

func pkgMatches(name string, d compDef) bool {
	n := strings.ToLower(name)
	for _, p := range d.pkgs {
		if n == p || strings.HasPrefix(n, p) && d.kind == "postgres" && regexp.MustCompile(`^postgresql-?\d+(-server)?$|^postgresql\d+-server$|^postgresql-server$|^postgresql$`).MatchString(n) {
			return true
		}
		if d.kind != "postgres" && (n == p || strings.HasPrefix(n, p+"-") || strings.HasPrefix(n, p+"_") || strings.HasPrefix(n, p+"2")) {
			// e.g. haproxy28, pgbouncer, etcd, prometheus2; skip libraries and docs
			if strings.HasSuffix(n, "-doc") || strings.HasSuffix(n, "-docs") || strings.HasSuffix(n, "-devel") || strings.HasPrefix(n, "lib") {
				return false
			}
			return true
		}
	}
	return false
}

/* ------------------------------------------------------------ config files ------------------------------------------------------------ */

func configDetails(h *HostInfo) {
	if s := h.raw["keepalived"]; s != "" {
		inBlock := false
		for _, l := range strings.Split(s, "\n") {
			t := strings.TrimSpace(l)
			if strings.HasPrefix(t, "virtual_ipaddress") {
				inBlock = true
				continue
			}
			if inBlock {
				if strings.HasPrefix(t, "}") {
					inBlock = false
					continue
				}
				if f := strings.Fields(t); len(f) > 0 {
					h.VIPs = appendOnce(h.VIPs, strings.Split(f[0], "/")[0])
				}
			}
		}
		c := h.comp("keepalived")
		c.detail("virtual IPs", strings.Join(h.VIPs, ", "))
		if m := regexp.MustCompile(`(?m)^\s*state\s+(\S+)`).FindStringSubmatch(s); m != nil {
			c.detail("state", m[1])
		}
		if m := regexp.MustCompile(`(?m)^\s*interface\s+(\S+)`).FindStringSubmatch(s); m != nil {
			c.detail("interface", m[1])
		}
	}
	if s := h.raw["patroni"]; s != "" {
		c := h.comp("patroni")
		for _, l := range strings.Split(s, "\n") {
			k, v, ok := strings.Cut(strings.TrimSpace(l), ":")
			if !ok {
				continue
			}
			v = strings.Trim(strings.TrimSpace(v), `"'`)
			switch k {
			case "scope", "namespace", "data_dir", "bin_dir":
				c.detail(k, v)
			case "name":
				if c.Details["member"] == "" {
					c.detail("member", v)
				}
			case "hosts", "host":
				if v != "" {
					c.detail("DCS hosts", v)
				}
			}
		}
	}
	if s := h.raw["pgbouncer"]; s != "" {
		c := h.comp("pgbouncer")
		section := ""
		var dbs []string
		for _, l := range strings.Split(s, "\n") {
			t := strings.TrimSpace(l)
			if strings.HasPrefix(t, "[") {
				section = strings.Trim(t, "[]")
				continue
			}
			k, v, ok := strings.Cut(t, "=")
			if !ok {
				continue
			}
			k, v = strings.TrimSpace(k), strings.TrimSpace(v)
			if section == "databases" {
				dbs = append(dbs, k+" → "+v)
			} else if section == "pgbouncer" {
				switch k {
				case "listen_port", "pool_mode", "max_client_conn", "default_pool_size", "listen_addr":
					c.detail(k, v)
				}
			}
		}
		if len(dbs) > 0 {
			c.detail("databases", strings.Join(dbs, "; "))
		}
	}
	if s := h.raw["etcd"]; s != "" {
		c := h.comp("etcd")
		for _, l := range strings.Split(s, "\n") {
			l = strings.TrimSpace(l)
			if k, v, ok := strings.Cut(l, "="); ok {
				k = strings.ToLower(strings.TrimSpace(strings.TrimPrefix(k, "ETCD_")))
				v = strings.Trim(strings.TrimSpace(v), `"'`)
				switch {
				case k == "name":
					c.detail("member", v)
				case strings.Contains(k, "initial_cluster") && !strings.Contains(k, "state") && !strings.Contains(k, "token"):
					c.detail("cluster", v)
				}
			} else if k, v, ok := strings.Cut(l, ":"); ok {
				k = strings.TrimSpace(k)
				v = strings.Trim(strings.TrimSpace(v), `"'`)
				if k == "name" {
					c.detail("member", v)
				} else if k == "initial-cluster" {
					c.detail("cluster", v)
				}
			}
		}
	}
	if s := h.raw["prometheus"]; s != "" {
		var jobs []string
		for _, m := range regexp.MustCompile(`job_name:\s*['"]?([^'"\s]+)`).FindAllStringSubmatch(s, -1) {
			jobs = append(jobs, m[1])
		}
		h.comp("prometheus").detail("jobs", strings.Join(jobs, ", "))
	}
	if s := h.raw["pgbackrest"]; s != "" {
		c := h.comp("pgbackrest")
		for _, l := range strings.Split(s, "\n") {
			k, v, ok := strings.Cut(strings.TrimSpace(l), "=")
			if !ok {
				continue
			}
			k = strings.TrimSpace(k)
			if strings.HasPrefix(k, "repo1-type") || strings.HasPrefix(k, "repo1-path") || strings.HasPrefix(k, "repo1-host") ||
				strings.HasPrefix(k, "repo1-retention-full") || strings.HasPrefix(k, "repo1-s3-bucket") || k == "pg1-path" {
				c.detail(k, strings.TrimSpace(v))
			}
		}
	}
}

// balancer routes from HAProxy (listen / frontend+backend) and nginx (stream upstream) configs
func parseRoutes(h *HostInfo) []Route {
	var out []Route
	if s := h.raw["haproxy"]; s != "" {
		type sec struct {
			kind, name, mode, def string
			binds                 []int
			servers               []string
		}
		var secs []*sec
		var cur *sec
		for _, l := range strings.Split(s, "\n") {
			f := strings.Fields(l)
			if len(f) == 0 {
				continue
			}
			switch f[0] {
			case "listen", "frontend", "backend":
				name := ""
				if len(f) > 1 {
					name = f[1]
				}
				cur = &sec{kind: f[0], name: name}
				secs = append(secs, cur)
				if len(f) > 2 && f[0] != "backend" { // "listen name 0.0.0.0:5000"
					if i := strings.LastIndex(f[2], ":"); i >= 0 {
						cur.binds = append(cur.binds, atoi(f[2][i+1:]))
					}
				}
			case "bind":
				if cur != nil && len(f) > 1 {
					if i := strings.LastIndex(f[1], ":"); i >= 0 {
						cur.binds = append(cur.binds, atoi(f[1][i+1:]))
					}
				}
			case "mode":
				if cur != nil && len(f) > 1 {
					cur.mode = f[1]
				}
			case "server":
				if cur != nil && len(f) > 2 {
					cur.servers = append(cur.servers, f[2])
				}
			case "default_backend":
				if cur != nil && len(f) > 1 {
					cur.def = f[1]
				}
			}
		}
		backends := map[string]*sec{}
		for _, x := range secs {
			if x.kind == "backend" {
				backends[x.name] = x
			}
		}
		for _, x := range secs {
			if x.kind == "backend" || len(x.binds) == 0 {
				continue
			}
			servers := x.servers
			mode := x.mode
			if b := backends[x.def]; b != nil {
				servers = append(servers, b.servers...)
				if mode == "" {
					mode = b.mode
				}
			}
			if len(servers) == 0 {
				continue // e.g. the stats page
			}
			for _, p := range x.binds {
				out = append(out, Route{Host: h.Address, Kind: "haproxy", Name: x.name, Port: p, Mode: mode, Targets: servers})
			}
		}
	}
	if s := h.raw["nginx"]; s != "" {
		upstreams := map[string][]string{}
		var order []struct {
			port     int
			upstream string
		}
		curUp := ""
		var listen []int
		for _, l := range strings.Split(s, "\n") {
			f := strings.Fields(strings.TrimRight(strings.TrimSpace(l), ";"))
			if len(f) == 0 {
				continue
			}
			switch f[0] {
			case "upstream":
				if len(f) > 1 {
					curUp = f[1]
				}
			case "server":
				if curUp != "" && len(f) > 1 && !strings.Contains(f[1], "{") {
					upstreams[curUp] = append(upstreams[curUp], f[1])
				} else {
					curUp = ""
					listen = nil
				}
			case "listen":
				if len(f) > 1 {
					p := f[1]
					if i := strings.LastIndex(p, ":"); i >= 0 {
						p = p[i+1:]
					}
					listen = append(listen, atoi(p))
				}
			case "proxy_pass":
				if len(f) > 1 {
					up := strings.TrimPrefix(strings.TrimPrefix(f[1], "http://"), "https://")
					for _, p := range listen {
						order = append(order, struct {
							port     int
							upstream string
						}{p, up})
					}
				}
			}
		}
		for _, o := range order {
			targets := upstreams[o.upstream]
			if targets == nil && strings.Contains(o.upstream, ":") {
				targets = []string{o.upstream}
			}
			if len(targets) > 0 && o.port > 0 {
				out = append(out, Route{Host: h.Address, Kind: "nginx", Name: o.upstream, Port: o.port, Mode: "stream/http", Targets: targets})
			}
		}
	}
	return out
}

// finish: roles in order, components sorted, version fallbacks from packages
func finish(h *HostInfo) {
	for _, c := range h.Components {
		if c.Version == "" && c.Package != "" {
			f := strings.Fields(c.Package)
			if len(f) > 1 {
				c.Version = firstVersion(f[1])
			}
		}
		// a known port open on the machine (no SSH) tells which component is likely there
		if d := defOf(c.Kind); d != nil {
			for _, p := range d.ports {
				if has(h.OpenPorts, p) {
					c.port(p)
				}
			}
		}
	}
	// ports open without SSH: guess what listens there (marked by source "port")
	if h.SSH != "ok" {
		guess := map[int]string{6432: "pgbouncer", 2379: "etcd", 9100: "node_exporter", 9187: "postgres_exporter",
			8008: "patroni", 8009: "patroni", 9090: "prometheus", 9093: "alertmanager", 3000: "grafana", 8500: "consul", 9999: "pgpool"}
		for _, p := range h.OpenPorts {
			if k, ok := guess[p]; ok {
				c := h.comp(k)
				c.source("port")
				c.port(p)
				c.Running = true
			}
		}
		for _, k := range []string{"haproxy", "nginx"} {
			if h.hasKind(k) {
				for _, p := range []int{5000, 5001, 5002} {
					if has(h.OpenPorts, p) {
						h.comp(k).port(p)
					}
				}
			}
		}
		if (has(h.OpenPorts, 5000) || has(h.OpenPorts, 5001)) && !h.hasKind("haproxy") && !h.hasKind("nginx") {
			c := h.comp("haproxy")
			c.Label = "Load balancer (HAProxy?)"
			c.source("port")
			c.Running = true
			for _, p := range []int{5000, 5001, 5002, 7000} {
				if has(h.OpenPorts, p) {
					c.port(p)
				}
			}
			c.detail("note", "ports 5000/5001 are open; give SSH access to see which program it is")
		}
		if has(h.OpenPorts, h.pgPort) {
			c := h.comp("postgres")
			c.source("port")
			c.port(h.pgPort)
			c.Running = true
		}
	}
	// nginx with only a plain web site is not a database balancer
	sort.SliceStable(h.Components, func(i, j int) bool {
		return layerIndex(h.Components[i].Layer) < layerIndex(h.Components[j].Layer)
	})
	h.Roles = []string{}
	for _, l := range layerOrder {
		for _, c := range h.Components {
			if c.Layer == l && l != "platform" {
				h.Roles = appendOnce(h.Roles, l)
			}
		}
	}
}

func (h *HostInfo) hasKind(k string) bool {
	for _, c := range h.Components {
		if c.Kind == k {
			return true
		}
	}
	return false
}

func layerIndex(l string) int {
	for i, x := range layerOrder {
		if x == l {
			return i
		}
	}
	return len(layerOrder)
}

/* ------------------------------------------------------------ Prometheus targets ------------------------------------------------------------ */

func promTargets(ctx context.Context, base string) ([]PromTarget, error) {
	b, _, err := get(ctx, strings.TrimRight(base, "/")+"/api/v1/targets?state=active", 8<<20)
	if err != nil {
		return nil, err
	}
	var r struct {
		Status string `json:"status"`
		Data   struct {
			Active []struct {
				Labels map[string]string `json:"labels"`
				Health string            `json:"health"`
			} `json:"activeTargets"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(b), &r); err != nil || r.Status != "success" {
		return nil, fmt.Errorf("not a Prometheus API answer")
	}
	var out []PromTarget
	for _, t := range r.Data.Active {
		out = append(out, PromTarget{Job: t.Labels["job"], Instance: t.Labels["instance"], Health: t.Health})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Job+out[i].Instance < out[j].Job+out[j].Instance })
	return out, nil
}

// jobKind: what a scrape job most likely is
func jobKind(job string, port int) string {
	j := strings.ToLower(job)
	switch {
	case strings.Contains(j, "node"):
		return "node_exporter"
	case strings.Contains(j, "pgbouncer"):
		return "pgbouncer_exporter"
	case strings.Contains(j, "postgres") || strings.Contains(j, "pg_exporter") || strings.Contains(j, "pgsql"):
		return "postgres_exporter"
	case strings.Contains(j, "haproxy"):
		return "haproxy"
	case strings.Contains(j, "patroni"):
		return "patroni"
	case strings.Contains(j, "etcd"):
		return "etcd"
	case strings.Contains(j, "alertmanager"):
		return "alertmanager"
	case strings.Contains(j, "grafana"):
		return "grafana"
	case strings.Contains(j, "prometheus"):
		return "prometheus"
	case strings.Contains(j, "consul"):
		return "consul"
	}
	return map[int]string{9100: "node_exporter", 9187: "postgres_exporter", 9127: "pgbouncer_exporter", 8008: "patroni", 2379: "etcd"}[port]
}
