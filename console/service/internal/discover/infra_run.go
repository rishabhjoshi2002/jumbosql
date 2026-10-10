package discover

// Putting the machines together: probe every host, decide where PostgreSQL is, then join what the database
// logins found with what the machines run (balancer routes, VIPs, Prometheus targets) and name the stack.

import (
	"context"
	"fmt"
	"net"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// PrepareSSH writes the temporary key / askpass files for this run; call the returned cleanup when done.
func PrepareSSH(req *Request) (cleanup func(), err error) {
	dir, key, askpass, err := prepareSSH(req.SSH)
	cleanup = func() {
		if dir != "" {
			os.RemoveAll(dir)
		}
	}
	req.KeyFile, req.Askpass = key, askpass
	return cleanup, err
}

func probeInfra(ctx context.Context, req Request) *Infra {
	inf := &Infra{Hosts: make([]*HostInfo, len(req.Hosts)), Routes: []Route{}, VIPs: []string{}, Summary: []string{},
		SSHUsed: req.SSH != nil && req.SSH.User != ""}
	var wg sync.WaitGroup
	sem := make(chan struct{}, 12)
	for i, h := range req.Hosts {
		wg.Add(1)
		go func(i int, h InvHost) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			hctx, cancel := context.WithTimeout(ctx, 60*time.Second)
			defer cancel()
			inf.Hosts[i] = probeHost(hctx, h, req.SSH, req.KeyFile, req.Askpass)
		}(i, h)
	}
	wg.Wait()
	return inf
}

// pgTargets: where to log in. A machine is a database server when its PostgreSQL port answers, when SSH saw
// postgres listening, or when the inventory says so (then a failure is worth reporting). Balancers, etcd and
// monitoring machines are not reported as "unreachable databases".
func pgTargets(req Request, inf *Infra) []Target {
	var out []Target
	seen := map[string]bool{}
	add := func(host string, port int) {
		k := fmt.Sprintf("%s:%d", host, port)
		if !seen[k] && len(out) < 50 {
			seen[k] = true
			out = append(out, Target{Host: host, Port: port})
		}
	}
	for i, h := range inf.Hosts {
		ih := req.Hosts[i]
		ports := []int{}
		for _, l := range h.Listening {
			if l.Process != "postgres" && l.Process != "postmaster" || has(ports, l.Port) {
				continue
			}
			// only what the console can reach: not localhost-only, and the port answers from here
			if ip := net.ParseIP(l.Addr); ip != nil && ip.IsLoopback() && l.Addr != h.Address {
				continue
			}
			if c, err := net.DialTimeout("tcp", net.JoinHostPort(h.Address, strconv.Itoa(l.Port)), 1500*time.Millisecond); err == nil {
				c.Close()
				ports = append(ports, l.Port)
			}
		}
		switch {
		case len(ports) > 0:
			for _, p := range ports {
				add(h.Address, p)
			}
		case has(h.OpenPorts, ih.PGPort):
			add(h.Address, ih.PGPort)
		case h.declaredDB || len(ih.Groups) == 0 && (h.SSH != "ok"):
			add(h.Address, ih.PGPort) // a plain list names database servers
		}
	}
	return out
}

func (h *HostInfo) label() string {
	if h.Name != "" && h.Name != h.Address {
		return h.Name
	}
	return h.Address
}

// hostIndex finds the machine behind an address or name (also through DNS).
type hostIndex map[string]*HostInfo

func newHostIndex(hosts []*HostInfo, res *Result) hostIndex {
	ix := hostIndex{}
	for _, h := range hosts {
		for _, k := range []string{h.Address, h.Name, strings.Split(h.Name, ".")[0]} {
			if k != "" {
				ix[strings.ToLower(k)] = h
			}
		}
		if net.ParseIP(h.Address) == nil {
			if ips, err := net.LookupHost(h.Address); err == nil {
				for _, ip := range ips {
					ix[ip] = h
				}
			}
		}
	}
	// PostgreSQL nodes know their own server address (inet_server_addr) and aliases
	for _, n := range res.Nodes {
		if h := ix[strings.ToLower(n.Host)]; h != nil {
			for a := range n.aliases {
				if _, ok := ix[a]; !ok {
					ix[a] = h
				}
			}
			if n.ServerAddr != "" {
				if _, ok := ix[n.ServerAddr]; !ok {
					ix[n.ServerAddr] = h
				}
			}
		}
	}
	return ix
}

func (ix hostIndex) find(addr string) *HostInfo {
	a := strings.ToLower(strings.Trim(addr, "[]"))
	if h, _, err := net.SplitHostPort(addr); err == nil {
		a = strings.ToLower(h)
	}
	if h := ix[a]; h != nil {
		return h
	}
	if h := ix[strings.Split(a, ".")[0]]; h != nil && net.ParseIP(a) == nil {
		return h
	}
	return nil
}

func finishInfra(ctx context.Context, res *Result, inf *Infra, req Request) {
	ix := newHostIndex(inf.Hosts, res)

	// 1. PostgreSQL facts from the logins onto the machines
	for _, n := range res.Nodes {
		if n.External {
			continue
		}
		h := ix.find(n.Host)
		if h == nil {
			continue
		}
		c := h.comp("postgres")
		c.port(n.Port)
		if n.Reachable {
			c.Running = true
			c.source("login")
			if v := firstVersion(n.Version); v != "" {
				c.Version = v
			}
			c.detail("role", n.Role)
			c.detail("data directory", n.DataDirectory)
			for _, g := range res.Groups {
				if g.ID == n.Group && len(g.Members) > 1 {
					c.detail("cluster", g.Name)
				}
			}
		}
		if n.Patroni != nil {
			p := h.comp("patroni")
			p.Running = true
			p.source("http")
			if p.Version == "" {
				p.Version = n.Patroni.Version
			}
			p.detail("scope", n.Patroni.Scope)
			p.detail("role", n.Patroni.Role)
		}
	}

	// 2. balancer routes, with targets resolved to machines
	for _, h := range inf.Hosts {
		for _, r := range parseRoutes(h) {
			r.TargetOf = []string{}
			for _, t := range r.Targets {
				if th := ix.find(t); th != nil {
					r.TargetOf = appendOnce(r.TargetOf, th.Address)
				}
			}
			inf.Routes = append(inf.Routes, r)
			if c := h.comp(r.Kind); c != nil {
				c.port(r.Port)
				c.detail("routes", strings.TrimPrefix(c.Details["routes"]+fmt.Sprintf("; %d → %s", r.Port, strings.Join(r.Targets, ", ")), "; "))
			}
		}
		for _, v := range h.VIPs {
			inf.VIPs = appendOnce(inf.VIPs, v)
		}
	}

	// 3. Prometheus: the given URL, else one found on the machines
	prom := strings.TrimRight(strings.TrimSpace(req.PromURL), "/")
	if prom == "" {
		for _, h := range inf.Hosts {
			for _, c := range h.Components {
				if c.Kind == "prometheus" && c.Running && has(c.Ports, 9090) {
					prom = "http://" + net.JoinHostPort(h.Address, "9090")
					break
				}
			}
			if prom != "" {
				break
			}
		}
	}
	if prom != "" {
		inf.Prometheus = prom
		pctx, cancel := context.WithTimeout(ctx, 15*time.Second)
		targets, err := promTargets(pctx, prom)
		cancel()
		if err != nil {
			inf.PromError = err.Error()
		}
		for i, t := range targets {
			hostPart, portS, _ := net.SplitHostPort(t.Instance)
			if hostPart == "" {
				hostPart = t.Instance
			}
			port, _ := strconv.Atoi(portS)
			h := ix.find(hostPart)
			if h == nil {
				continue
			}
			targets[i].Host = h.Address
			if k := jobKind(t.Job, port); k != "" {
				c := h.comp(k)
				c.source("prometheus")
				if t.Health == "up" {
					c.Running = true
				}
				if port > 0 {
					c.port(port)
				}
			}
		}
		inf.Targets = targets
	}

	for _, h := range inf.Hosts {
		finish(h)
	}
	inf.Stack, inf.Summary = stackName(inf, res), infraSummary(inf, res)
	infraFindings(res, inf)
}

// hostsWith: the machines running a component kind, "name (version)".
func hostsWith(inf *Infra, kind string) (names []string, versions map[string][]string) {
	versions = map[string][]string{}
	for _, h := range inf.Hosts {
		for _, c := range h.Components {
			if c.Kind == kind {
				names = append(names, h.label())
				v := c.Version
				if v == "" {
					v = "?"
				}
				versions[v] = append(versions[v], h.label())
			}
		}
	}
	return names, versions
}

func stackName(inf *Infra, res *Result) string {
	present := func(k string) bool { n, _ := hostsWith(inf, k); return len(n) > 0 }
	groups := map[string]bool{}
	for _, h := range inf.Hosts {
		for _, g := range h.Groups {
			groups[g] = true
		}
	}
	var parts []string
	switch {
	case present("patroni"):
		parts = append(parts, "Patroni HA cluster")
	case present("repmgr"):
		parts = append(parts, "repmgr cluster")
	case present("pg_auto_failover"):
		parts = append(parts, "pg_auto_failover cluster")
	case present("pgpool"):
		parts = append(parts, "Pgpool-II cluster")
	case res.Counts.Reachable > 0:
		parts = append(parts, res.Architecture)
	default:
		parts = append(parts, "Servers")
	}
	var with []string
	for _, k := range []string{"etcd", "consul", "haproxy", "nginx", "keepalived", "vip-manager", "pgbouncer", "odyssey", "pgbackrest", "prometheus"} {
		if present(k) {
			with = append(with, defOf(k).label)
		}
	}
	name := parts[0]
	if len(with) > 0 {
		name += " · " + strings.Join(with, ", ")
	}
	name = strings.ReplaceAll(name, " (VIP)", "")
	if (groups["master"] || groups["replica"]) && (groups["etcd_cluster"] || groups["balancers"] || groups["consul_instances"]) {
		name += " (CPA / Autobase layout)"
	}
	return name
}

func infraSummary(inf *Infra, res *Result) []string {
	var out []string
	reach, ssh := 0, 0
	for _, h := range inf.Hosts {
		if h.Reachable {
			reach++
		}
		if h.SSH == "ok" {
			ssh++
		}
	}
	s := fmt.Sprintf("%s: %d reachable", plural(len(inf.Hosts), "machine", "machines"), reach)
	if inf.SSHUsed {
		s += fmt.Sprintf(", SSH worked on %d", ssh)
	} else {
		s += " (no SSH given: components are guessed from open ports and HTTP answers)"
	}
	out = append(out, s+".")
	if len(inf.VIPs) > 0 {
		k, _ := hostsWith(inf, "keepalived")
		if len(k) == 0 {
			k, _ = hostsWith(inf, "vip-manager")
		}
		out = append(out, fmt.Sprintf("Clients connect to the virtual IP %s (held by %s).", strings.Join(inf.VIPs, ", "), strings.Join(k, ", ")))
	}
	for _, l := range layerOrder {
		if l == "entry" || l == "platform" {
			continue
		}
		seen := map[string]bool{}
		for _, h := range inf.Hosts {
			for _, c := range h.Components {
				if c.Layer != l || seen[c.Kind] {
					continue
				}
				seen[c.Kind] = true
				names, versions := hostsWith(inf, c.Kind)
				var vs []string
				for v := range versions {
					if v != "?" {
						vs = append(vs, v)
					}
				}
				sort.Strings(vs)
				line := c.Label
				if len(vs) > 0 {
					line += " " + strings.Join(vs, " / ")
				}
				out = append(out, fmt.Sprintf("%s on %s.", line, strings.Join(names, ", ")))
			}
		}
	}
	// nginx doing HAProxy's job (a stream proxy, or a machine of the "balancers" group)
	for _, h := range inf.Hosts {
		c := (*Component)(nil)
		for _, x := range h.Components {
			if x.Kind == "nginx" {
				c = x
			}
		}
		if c == nil || h.hasKind("haproxy") {
			continue
		}
		routed := false
		for _, r := range inf.Routes {
			routed = routed || r.Host == h.Address && r.Kind == "nginx"
		}
		inBal := false
		for _, g := range h.Groups {
			inBal = inBal || strings.Contains(g, "balancer")
		}
		if routed || inBal || has(h.OpenPorts, 5000) {
			out = append(out, fmt.Sprintf("%s uses nginx as the database load balancer (instead of HAProxy).", h.label()))
		}
	}
	return out
}

func infraFindings(res *Result, inf *Infra) {
	add := func(sev, node, text string) {
		res.Findings = append(res.Findings, Finding{Severity: sev, Node: node, Text: text})
	}
	for _, h := range inf.Hosts {
		if !h.Reachable {
			add("critical", h.Address, fmt.Sprintf("%s does not answer on any known port.", h.label()))
		}
		if h.SSH == "failed" {
			add("warning", h.Address, fmt.Sprintf("SSH to %s failed: %s.", h.label(), h.SSHError))
		}
		for _, c := range h.Components {
			if !c.Running && len(c.Sources) > 0 && !(len(c.Sources) == 1 && c.Sources[0] == "prometheus") && c.Layer != "backup" && c.Layer != "platform" && h.SSH == "ok" &&
				!(len(c.Sources) == 1 && c.Sources[0] == "package" && c.Kind == "postgres") {
				add("warning", h.Address, fmt.Sprintf("%s is installed on %s but not running.", c.Label, h.label()))
			}
		}
		if h.MemBytes > 0 && h.SwapBytes == 0 && h.hasKind("postgres") {
			add("info", h.Address, fmt.Sprintf("%s has no swap.", h.label()))
		}
		for _, d := range h.Disks {
			if d.Size > 0 && d.Used/d.Size > 0.85 {
				add("warning", h.Address, fmt.Sprintf("%s on %s is %.0f%% full.", d.Mount, h.label(), 100*d.Used/d.Size))
			}
		}
	}
	for _, k := range []string{"postgres", "patroni", "etcd", "haproxy", "pgbouncer", "keepalived"} {
		_, versions := hostsWith(inf, k)
		delete(versions, "?")
		if len(versions) > 1 {
			var parts []string
			for v, hs := range versions {
				parts = append(parts, v+" on "+strings.Join(hs, ", "))
			}
			sort.Strings(parts)
			add("warning", "", fmt.Sprintf("%s versions differ: %s.", defOf(k).label, strings.Join(parts, "; ")))
		}
	}
	if n, _ := hostsWith(inf, "etcd"); len(n) == 2 || len(n) == 4 {
		add("warning", "", fmt.Sprintf("etcd has %d members; an odd number (3 or 5) survives failures better.", len(n)))
	} else if len(n) == 1 {
		add("warning", "", "etcd has a single member: if it stops, Patroni cannot fail over.")
	}
	bal := 0
	for _, h := range inf.Hosts {
		if h.hasKind("haproxy") || h.hasKind("nginx") || h.hasKind("pgpool") {
			bal++
		}
	}
	if bal == 1 && len(inf.VIPs) == 0 {
		add("info", "", "There is one load balancer and no virtual IP: it is a single point of failure.")
	}
	for _, r := range inf.Routes {
		if len(r.TargetOf) < len(r.Targets) {
			add("info", r.Host, fmt.Sprintf("%s port %d sends to servers that are not in the inventory (%s).", r.Kind, r.Port, strings.Join(r.Targets, ", ")))
		}
	}
	var down []string
	for _, t := range inf.Targets {
		if t.Health != "up" {
			down = append(down, fmt.Sprintf("%s (%s)", t.Job, t.Instance))
		}
	}
	if len(down) > 0 {
		if len(down) > 8 {
			down = append(down[:8], "...")
		}
		add("warning", "", fmt.Sprintf("Prometheus reports %s down: %s.", plural(len(down), "target", "targets"), strings.Join(down, ", ")))
	}
	if inf.PromError != "" {
		add("info", "", "Prometheus could not be read: "+inf.PromError)
	}
	order := map[string]int{"critical": 0, "warning": 1, "info": 2}
	sort.SliceStable(res.Findings, func(i, j int) bool { return order[res.Findings[i].Severity] < order[res.Findings[j].Severity] })
}
