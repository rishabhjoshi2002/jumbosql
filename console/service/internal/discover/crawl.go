package discover

// Following connections: start from one machine (best: the PostgreSQL primary) and find the rest of the setup
// from what it talks to - replication, its clients (balancers, poolers), the Patroni members and their etcd,
// the Prometheus that scrapes it, the configs of HAProxy / PgBouncer / keepalived / pgBackRest, and the
// established TCP connections on the known ports. Every new machine is probed the same way, round after round.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Link is a connection between two machines (seen live, in a config, or in an API).
type Link struct {
	From   string `json:"from"` // machine address
	To     string `json:"to"`
	Kind   string `json:"kind"` // postgres | replication | pgbouncer | balancer | etcd | patroni | metrics | prometheus | backup | vip
	Port   int    `json:"port,omitempty"`
	Source string `json:"source"` // connection | config | api | login
}

// SSHNeed: a machine of the setup that SSH could not enter.
type SSHNeed struct {
	Address string   `json:"address"`
	Name    string   `json:"name,omitempty"`
	Roles   []string `json:"roles"`
	Reason  string   `json:"reason"`
	Via     string   `json:"via,omitempty"`
}

// ClientHost: an address that only connects to PostgreSQL / the balancer (an application server).
type ClientHost struct {
	Address     string `json:"address"`
	Connections int    `json:"connections"`
	Apps        string `json:"apps,omitempty"`
	Users       string `json:"users,omitempty"`
	To          string `json:"to"`
}

type peer struct {
	addr, via string
	client    bool
}

// what a port is, for links and for telling infrastructure peers from application clients
var portKind = map[int]string{5432: "postgres", 6432: "pgbouncer", 2379: "etcd", 2380: "etcd", 8008: "patroni", 8009: "patroni",
	9100: "metrics", 9187: "metrics", 9127: "metrics", 9101: "metrics", 8404: "metrics", 9090: "prometheus", 9093: "prometheus",
	3000: "prometheus", 5000: "balancer", 5001: "balancer", 5002: "balancer", 5003: "balancer", 7000: "balancer", 8432: "backup"}

// ports whose callers may be applications (kept only if they run something of the stack)
var clientPorts = map[int]bool{5432: true, 6432: true, 5000: true, 5001: true, 5002: true, 5003: true, 9090: true, 3000: true}

const maxCrawlHosts = 60

// PrepareSSH writes the temporary key / askpass files of every SSH login of this run; call cleanup when done.
func PrepareSSH(req *Request) (cleanup func(), err error) {
	var dirs []string
	cleanup = func() {
		for _, d := range dirs {
			os.RemoveAll(d)
		}
	}
	req.sshFiles = map[*SSHAuth][2]string{}
	auths := []*SSHAuth{req.SSH}
	for _, a := range req.HostAuth {
		auths = append(auths, a)
	}
	for _, a := range auths {
		if a == nil || a.User == "" {
			continue
		}
		dir, key, askpass, e := prepareSSH(a)
		if dir != "" {
			dirs = append(dirs, dir)
		}
		if e != nil {
			return cleanup, e
		}
		req.sshFiles[a] = [2]string{key, askpass}
	}
	return cleanup, nil
}

// authsFor: the SSH logins to try on a machine, in order: its own, the main one, then "*" (same for all)
func (req Request) authsFor(h InvHost) []*SSHAuth {
	var out []*SSHAuth
	add := func(a *SSHAuth) {
		if a == nil || a.User == "" {
			return
		}
		for _, x := range out {
			if x == a {
				return
			}
		}
		out = append(out, a)
	}
	add(req.HostAuth[h.Address])
	add(req.HostAuth[h.Name])
	add(req.SSH)
	add(req.HostAuth["*"])
	return out
}

// publicIP: an address worth following (not localhost, any-address, link-local or multicast)
func publicIP(a string) bool {
	ip := net.ParseIP(a)
	if a == "" || a == "localhost" || a == "127.0.0.1" || a == "::1" {
		return false
	}
	return ip == nil || !(ip.IsUnspecified() || ip.IsLinkLocalUnicast() || ip.IsMulticast())
}

// crawl probes the inventory, then (with Follow) the machines found from it, until nothing new turns up.
func crawl(ctx context.Context, req Request) (*Infra, []*Node) {
	inf := &Infra{Routes: []Route{}, VIPs: []string{}, Summary: []string{}, Links: []Link{}, SSHNeeded: []SSHNeed{},
		Clients: []ClientHost{}, SSHUsed: req.SSH != nil && req.SSH.User != ""}
	var nodes []*Node
	seen := map[string]bool{}
	for _, h := range req.Hosts {
		for ip := range hostIPs(h.Address) {
			seen[ip] = true
		}
	}
	queue := req.Hosts
	clientConns := map[string]*ClientHost{}
	for round := 0; len(queue) > 0 && round < 8; round++ {
		hosts := make([]*HostInfo, len(queue))
		var wg sync.WaitGroup
		sem := make(chan struct{}, 12)
		for i, ih := range queue {
			wg.Add(1)
			go func(i int, ih InvHost) {
				defer wg.Done()
				sem <- struct{}{}
				defer func() { <-sem }()
				hctx, cancel := context.WithTimeout(ctx, 60*time.Second)
				defer cancel()
				h := probeHost(hctx, ih, req.authsFor(ih), req.sshFiles)
				h.FoundVia = ih.FoundVia
				hosts[i] = h
			}(i, ih)
		}
		wg.Wait()
		round_nodes := probeNodes(ctx, req, pgTargets(queue, hosts))
		nodes = append(nodes, round_nodes...)

		var found []peer
		for i, h := range hosts {
			ih := queue[i]
			for _, ip := range h.IPs {
				seen[ip] = true
			}
			if ih.Client && !runsStack(h) {
				continue // an application server: listed as a client, not followed
			}
			inf.Hosts = append(inf.Hosts, h)
			if !req.Follow {
				continue
			}
			ps, ls := hostPeers(ctx, h)
			found = append(found, ps...)
			inf.Links = append(inf.Links, ls...)
		}
		for _, n := range round_nodes {
			if !n.Reachable || !req.Follow {
				continue
			}
			ps, ls := nodePeers(n)
			found = append(found, ps...)
			inf.Links = append(inf.Links, ls...)
			for _, c := range n.Clients {
				ch := clientConns[c.Addr]
				if ch == nil {
					ch = &ClientHost{Address: c.Addr, To: n.Host}
					clientConns[c.Addr] = ch
				}
				ch.Connections += c.Count
				ch.Apps = joinUnique(ch.Apps, c.Apps)
				ch.Users = joinUnique(ch.Users, c.Users)
			}
		}

		// the next round: everything new (an address seen as infrastructure wins over "client")
		next := map[string]*InvHost{}
		var order []string
		for _, p := range found {
			if !publicIP(p.addr) || seen[p.addr] {
				continue
			}
			if x := next[p.addr]; x != nil {
				if !p.client && x.Client {
					x.Client, x.FoundVia = false, p.via
				}
				continue
			}
			if len(inf.Hosts)+len(next) >= maxCrawlHosts {
				break
			}
			next[p.addr] = &InvHost{Address: p.addr, PGPort: defaultPGPort(req), FoundVia: p.via, Client: p.client}
			order = append(order, p.addr)
		}
		queue = nil
		for _, a := range order {
			seen[a] = true
			queue = append(queue, *next[a])
		}
	}

	// application servers: connected, but run nothing of the stack
	known := map[string]bool{}
	for _, h := range inf.Hosts {
		for ip := range hostIPs(h.Address) {
			known[ip] = true
		}
		for _, ip := range h.IPs {
			known[ip] = true
		}
	}
	for addr, c := range clientConns {
		if !known[addr] && publicIP(addr) {
			inf.Clients = append(inf.Clients, *c)
		}
	}
	sort.Slice(inf.Clients, func(i, j int) bool { return inf.Clients[i].Connections > inf.Clients[j].Connections })

	// machines of the stack that SSH could not enter
	for _, h := range inf.Hosts {
		if h.SSH == "failed" || (inf.SSHUsed && h.SSH == "not tried") {
			reason := h.SSHError
			if reason == "" {
				reason = "SSH was not tried"
			}
			inf.SSHNeeded = append(inf.SSHNeeded, SSHNeed{Address: h.Address, Name: h.Name, Roles: h.Roles, Reason: reason, Via: h.FoundVia})
		}
	}
	return inf, nodes
}

func defaultPGPort(req Request) int {
	for _, h := range req.Hosts {
		if h.PGPort != 0 {
			return h.PGPort
		}
	}
	return 5432
}

// runsStack: the machine runs a component of the setup (not only an application, Docker or an exporter)
func runsStack(h *HostInfo) bool {
	for _, c := range h.Components {
		if c.Layer != "platform" && c.Layer != "other" && !strings.HasSuffix(c.Kind, "_exporter") {
			return true
		}
	}
	return false
}

func hasStr(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func joinUnique(a, b string) string {
	set := map[string]bool{}
	var out []string
	for _, s := range strings.Split(a+", "+b, ",") {
		if s = strings.TrimSpace(s); s != "" && !set[s] {
			set[s] = true
			out = append(out, s)
		}
	}
	return strings.Join(out, ", ")
}

var hostPortRe = regexp.MustCompile(`(?:https?://)?\[?([A-Za-z0-9][A-Za-z0-9.\-:]*?[A-Za-z0-9])\]?:(\d{2,5})\b`)

// hostsIn: every host:port in a text (configs, DCS host lists)
func hostsIn(s string) [][2]string {
	var out [][2]string
	for _, m := range hostPortRe.FindAllStringSubmatch(s, -1) {
		out = append(out, [2]string{m[1], m[2]})
	}
	return out
}

func lookupFirst(host string) string {
	if net.ParseIP(host) != nil {
		return host
	}
	if strings.Contains(host, "{{") || !strings.Contains(host, ".") && len(host) < 2 {
		return ""
	}
	if ips, err := net.LookupHost(host); err == nil && len(ips) > 0 {
		return ips[0]
	}
	return ""
}

// hostPeers: the machines this one talks to, from its configs, live connections and APIs.
func hostPeers(ctx context.Context, h *HostInfo) ([]peer, []Link) {
	var ps []peer
	var ls []Link
	label := h.label()
	addPeer := func(addr, why string, client bool) {
		if a := lookupFirst(addr); a != "" {
			ps = append(ps, peer{addr: a, via: label + ": " + why, client: client})
		}
	}
	addLink := func(from, to, kind string, port int, src string) {
		ls = append(ls, Link{From: from, To: to, Kind: kind, Port: port, Source: src})
	}

	// configs (SSH)
	for _, c := range h.Components {
		switch c.Kind {
		case "patroni":
			for _, hp := range hostsIn(c.Details["DCS hosts"]) {
				addPeer(hp[0], "etcd in the Patroni config", false)
				addLink(h.Address, lookupFirst(hp[0]), "etcd", atoi(hp[1]), "config")
			}
		case "etcd":
			for _, hp := range hostsIn(c.Details["cluster"]) {
				addPeer(hp[0], "etcd cluster member", false)
			}
		case "pgbouncer":
			for _, m := range regexp.MustCompile(`host=([^\s;]+)`).FindAllStringSubmatch(c.Details["databases"], -1) {
				addPeer(m[1], "PgBouncer database host", false)
				addLink(h.Address, lookupFirst(m[1]), "pgbouncer", 0, "config")
			}
		}
	}
	for _, r := range parseRoutes(h) {
		for _, t := range r.Targets {
			host, portS, _ := net.SplitHostPort(t)
			addPeer(host, r.Kind+" backend (port "+strconv.Itoa(r.Port)+")", false)
			addLink(h.Address, lookupFirst(host), "balancer", atoi(portS), "config")
		}
	}
	if s := h.raw["keepalived"]; s != "" {
		in := false
		for _, l := range strings.Split(s, "\n") {
			t := strings.TrimSpace(l)
			if strings.HasPrefix(t, "unicast_peer") {
				in = true
				continue
			}
			if in {
				if strings.HasPrefix(t, "}") {
					in = false
					continue
				}
				if f := strings.Fields(t); len(f) > 0 {
					addPeer(f[0], "keepalived peer", false)
					addLink(h.Address, lookupFirst(f[0]), "vip", 0, "config")
				}
			}
		}
	}
	if s := h.raw["pgbackrest"]; s != "" {
		for _, m := range regexp.MustCompile(`(?m)^\s*(pg\d+-host|repo\d+-host)\s*=\s*(\S+)`).FindAllStringSubmatch(s, -1) {
			addPeer(m[2], "pgBackRest "+m[1], false)
			addLink(h.Address, lookupFirst(m[2]), "backup", 0, "config")
		}
	}
	if s := h.raw["prometheus"]; s != "" {
		for _, hp := range hostsIn(s) {
			addPeer(hp[0], "Prometheus scrape target", false)
			addLink(h.Address, lookupFirst(hp[0]), "metrics", atoi(hp[1]), "config")
		}
	}

	// live connections on the known ports (SSH)
	mine := map[string]bool{h.Address: true}
	for _, ip := range h.IPs {
		mine[ip] = true
	}
	for _, c := range h.conns {
		if mine[c.PeerAddr] || !publicIP(c.PeerAddr) {
			continue
		}
		if len(h.IPs) > 0 && !mine[c.LocalAddr] && !hasStr(h.VIPs, c.LocalAddr) {
			continue // another address of a shared host (e.g. a container network)
		}
		if k, ok := portKind[c.LocalPort]; ok { // someone connects to us
			addPeer(c.PeerAddr, fmt.Sprintf("connects to port %d", c.LocalPort), clientPorts[c.LocalPort])
			addLink(c.PeerAddr, h.Address, k, c.LocalPort, "connection")
		} else if k, ok := portKind[c.PeerPort]; ok { // we connect to someone
			addPeer(c.PeerAddr, fmt.Sprintf("connected to its port %d", c.PeerPort), false)
			addLink(h.Address, c.PeerAddr, k, c.PeerPort, "connection")
		}
	}

	// APIs that list the other members (no SSH needed)
	for _, p := range []int{8008, 8009} {
		if !has(h.OpenPorts, p) {
			continue
		}
		b, _, err := get(ctx, fmt.Sprintf("http://%s/cluster", net.JoinHostPort(h.Address, strconv.Itoa(p))), 256<<10)
		if err != nil {
			continue
		}
		var r struct {
			Members []struct {
				Name string `json:"name"`
				Host string `json:"host"`
				Role string `json:"role"`
			} `json:"members"`
		}
		if json.Unmarshal([]byte(b), &r) == nil {
			for _, m := range r.Members {
				addPeer(m.Host, "Patroni member "+m.Name, false)
			}
		}
	}
	if has(h.OpenPorts, 2379) {
		for _, scheme := range []string{"http", "https"} {
			u := scheme + "://" + net.JoinHostPort(h.Address, "2379") + "/v3/cluster/member/list"
			req, _ := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader([]byte("{}")))
			resp, err := httpc.Do(req)
			if err != nil {
				continue
			}
			var r struct {
				Members []struct {
					Name       string   `json:"name"`
					ClientURLs []string `json:"clientURLs"`
					PeerURLs   []string `json:"peerURLs"`
				} `json:"members"`
			}
			_ = json.NewDecoder(resp.Body).Decode(&r)
			resp.Body.Close()
			for _, m := range r.Members {
				for _, cu := range append(m.ClientURLs, m.PeerURLs...) {
					if pu, err := url.Parse(cu); err == nil {
						addPeer(pu.Hostname(), "etcd member "+m.Name, false)
					}
				}
			}
			if len(r.Members) > 0 {
				break
			}
		}
	}
	return ps, ls
}

// nodePeers: the machines a PostgreSQL server knows: standbys, upstream, publishers, and its clients.
func nodePeers(n *Node) ([]peer, []Link) {
	var ps []peer
	var ls []Link
	who := n.Name
	for _, s := range n.Senders {
		if s.ClientAddr != "" {
			kind := "standby"
			if s.Kind == "logical" {
				kind = "logical subscriber"
			}
			ps = append(ps, peer{addr: s.ClientAddr, via: who + ": " + kind})
			ls = append(ls, Link{From: n.Host, To: s.ClientAddr, Kind: "replication", Source: "login"})
		}
	}
	if n.Receiver != nil && n.Receiver.SenderHost != "" {
		if a := lookupFirst(n.Receiver.SenderHost); a != "" {
			ps = append(ps, peer{addr: a, via: who + ": streams from it"})
		}
	}
	for _, s := range n.Subscriptions {
		if a := lookupFirst(s.PublisherHost); a != "" {
			ps = append(ps, peer{addr: a, via: who + ": logical publisher"})
		}
	}
	for _, c := range n.Clients {
		senders := false
		for _, s := range n.Senders {
			senders = senders || s.ClientAddr == c.Addr
		}
		if !senders {
			ps = append(ps, peer{addr: c.Addr, via: fmt.Sprintf("%s: %d connections (%s)", who, c.Count, c.Users), client: true})
			ls = append(ls, Link{From: c.Addr, To: n.Host, Kind: "postgres", Port: n.Port, Source: "login"})
		}
	}
	return ps, ls
}
