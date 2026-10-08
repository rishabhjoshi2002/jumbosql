package discover

import (
	"fmt"
	"net"
	"sort"
	"strings"
)

/* ------------------------------------------------------------ who replicates from whom ------------------------------------------------------------ */

type graph struct {
	res   *Result
	byID  map[string]*Node
	edges map[string]bool
}

func (g *graph) find(host string, port int) *Node {
	host = strings.ToLower(strings.Trim(host, "[]"))
	if host == "" {
		return nil
	}
	names := map[string]bool{host: true}
	if net.ParseIP(host) == nil {
		if ips, err := net.LookupHost(host); err == nil {
			for _, ip := range ips {
				names[ip] = true
			}
		}
	}
	var hit *Node
	for _, n := range g.res.Nodes {
		if port != 0 && n.Port != port {
			continue
		}
		for a := range names {
			if n.aliases[a] {
				if !n.External {
					return n
				}
				hit = n
			}
		}
	}
	return hit
}

// byIP: the inventory node behind a client address (several ports on one host: prefer one that points at "to")
func (g *graph) byIP(ip string, prefer func(*Node) bool) *Node {
	var hits []*Node
	for _, n := range g.res.Nodes {
		if !n.External && n.aliases[strings.ToLower(ip)] {
			hits = append(hits, n)
		}
	}
	for _, n := range hits {
		if prefer != nil && prefer(n) {
			return n
		}
	}
	if len(hits) == 1 {
		return hits[0]
	}
	return nil
}

func (g *graph) external(host string, port int, role string) *Node {
	id := host
	if port != 0 {
		id = fmt.Sprintf("%s:%d", host, port)
	}
	if n := g.byID[id]; n != nil {
		return n
	}
	n := newNode(host, port)
	n.ID, n.External, n.Role, n.Name = id, true, role, host
	g.byID[id] = n
	g.res.Nodes = append(g.res.Nodes, n)
	return n
}

func (g *graph) externalNamed(addr, app, role string) *Node {
	if app == "" || app == "walreceiver" {
		return g.external(addr, 0, role)
	}
	id := app + "@" + addr
	if n := g.byID[id]; n != nil {
		return n
	}
	n := g.external(addr, 0, role)
	delete(g.byID, n.ID)
	n.ID, n.Name = id, app
	g.byID[id] = n
	return n
}

func (g *graph) add(e Edge) {
	key := e.Kind + "|" + e.From + "|" + e.To + "|" + e.Label
	if !g.edges[key] {
		g.edges[key] = true
		g.res.Edges = append(g.res.Edges, e)
	}
}

func link(res *Result) {
	g := &graph{res: res, byID: map[string]*Node{}, edges: map[string]bool{}}
	for _, n := range res.Nodes {
		n.resolveAliases()
		g.byID[n.ID] = n
	}
	inv := append([]*Node(nil), res.Nodes...)

	// 1. every standby names its upstream
	for _, n := range inv {
		if n.Receiver == nil {
			continue
		}
		up := g.find(n.Receiver.SenderHost, n.Receiver.SenderPort)
		if up == nil {
			up = g.external(n.Receiver.SenderHost, n.Receiver.SenderPort, "upstream (not in the inventory)")
		}
		e := Edge{From: up.ID, To: n.ID, Kind: "streaming", Slot: n.Receiver.SlotName, State: n.Receiver.Status,
			Healthy: n.Receiver.Status == "streaming"}
		// the upstream's walsender for this standby: same slot, else same application name, else the only one
		// from its address
		app := conninfoApp(n.primaryConninfo)
		var pick *Sender
		for pass := 0; pass < 3 && pick == nil; pass++ {
			var hits []*Sender
			for i := range up.Senders {
				s := &up.Senders[i]
				if s.Kind != "physical" || s.matched {
					continue
				}
				switch {
				case pass == 0 && n.Receiver.SlotName != "" && s.SlotName == n.Receiver.SlotName,
					pass == 1 && s.Application != "" && (s.Application == app || s.Application == n.Name),
					pass == 2 && n.aliases[s.ClientAddr]:
					hits = append(hits, s)
				}
			}
			if len(hits) == 1 {
				pick = hits[0]
			}
		}
		if pick != nil {
			pick.matched = true
			e.Sync, e.State, e.LagBytes, e.ReplayLag = pick.SyncState, pick.State, pick.LagBytes, pick.ReplayLag
		}
		g.add(e)
	}

	// 2. subscriptions name their publisher
	for _, n := range inv {
		for _, s := range n.Subscriptions {
			var pub *Node
			if s.PublisherHost != "" {
				pub = g.find(s.PublisherHost, s.PublisherPort)
			}
			if pub == nil && s.PublisherHost == "" { // connection string hidden: find the walsender using this slot
				slot := s.SlotName
				if slot == "" {
					slot = s.Name
				}
				for _, m := range inv {
					for _, w := range m.Senders {
						if w.Kind == "logical" && w.SlotName == slot && n.aliases[w.ClientAddr] {
							pub = m
						}
					}
				}
			}
			if pub == nil {
				if s.PublisherHost == "" {
					continue
				}
				pub = g.external(s.PublisherHost, s.PublisherPort, "publisher (not in the inventory)")
			}
			label := strings.Join(s.Publications, ", ")
			if s.PublisherDB != "" && s.PublisherDB != s.Database {
				label += " · " + s.PublisherDB + " → " + s.Database
			} else {
				label += " · " + s.Database
			}
			e := Edge{From: pub.ID, To: n.ID, Kind: "logical", Label: label, Slot: s.SlotName,
				State: map[bool]string{true: "receiving", false: "not receiving"}[s.Receiving], Healthy: s.Enabled && s.Receiving}
			if !s.Enabled {
				e.State = "disabled"
			}
			slot := s.SlotName
			if slot == "" {
				slot = s.Name
			}
			for i := range pub.Senders {
				w := &pub.Senders[i]
				if w.Kind == "logical" && w.SlotName == slot {
					w.matched = true
					e.LagBytes = w.LagBytes
				}
			}
			g.add(e)
		}
	}

	// 3. walsenders nobody claimed: standbys or subscribers outside the inventory (or we could not read them)
	for _, n := range inv {
		for i := range n.Senders {
			w := &n.Senders[i]
			if w.matched || w.ClientAddr == "" {
				continue
			}
			w.matched = true
			target := g.byIP(w.ClientAddr, nil)
			if target == n {
				target = nil
			}
			if w.Kind == "physical" {
				// only a standby that we could not tie to an upstream can be the reader
				if target != nil && (target.Role != "standby" || target.Receiver != nil) {
					target = nil
				}
				if target == nil { // one outside node per standby: the address, plus its name when it gives one
					target = g.externalNamed(w.ClientAddr, w.Application, "standby (not in the inventory)")
				}
				g.add(Edge{From: n.ID, To: target.ID, Kind: "streaming", Sync: w.SyncState, State: w.State,
					LagBytes: w.LagBytes, ReplayLag: w.ReplayLag, Slot: w.SlotName, Healthy: w.State == "streaming"})
			} else {
				if target != nil && target.Role == "standby" {
					target = nil
				}
				if target == nil {
					target = g.externalNamed(w.ClientAddr, w.Application, "subscriber (not in the inventory)")
				}
				g.add(Edge{From: n.ID, To: target.ID, Kind: "logical", Label: "slot " + w.SlotName, State: w.State,
					LagBytes: w.LagBytes, Slot: w.SlotName, Healthy: w.State == "streaming"})
			}
		}
	}

	// roles: a writable server that only takes data through subscriptions is a logical replica
	streamsTo := map[string]int{}
	for _, e := range res.Edges {
		if e.Kind == "streaming" {
			streamsTo[e.From]++
		}
	}
	for _, n := range res.Nodes {
		if !n.Reachable || n.External {
			continue
		}
		if n.Role == "primary" && streamsTo[n.ID] == 0 {
			if len(n.Subscriptions) > 0 {
				n.Role = "subscriber"
			} else if !publishes(res, n.ID) {
				n.Role = "standalone"
			}
		}
	}
	groups(res)
}

func publishes(res *Result, id string) bool {
	for _, e := range res.Edges {
		if e.From == id && e.Kind == "logical" {
			return true
		}
	}
	return false
}

// groups: physical clusters = nodes joined by streaming replication (or sharing a system identifier)
func groups(res *Result) {
	parent := map[string]string{}
	var root func(string) string
	root = func(x string) string {
		if parent[x] == "" || parent[x] == x {
			return x
		}
		parent[x] = root(parent[x])
		return parent[x]
	}
	union := func(a, b string) { parent[root(a)] = root(b) }
	bySys := map[string]string{}
	for _, n := range res.Nodes {
		parent[n.ID] = n.ID
	}
	for _, n := range res.Nodes {
		if n.SystemID != "" {
			if o, ok := bySys[n.SystemID]; ok {
				union(n.ID, o)
			} else {
				bySys[n.SystemID] = n.ID
			}
		}
	}
	for _, e := range res.Edges {
		if e.Kind == "streaming" {
			union(e.From, e.To)
		}
	}
	members := map[string][]*Node{}
	var order []string
	for _, n := range res.Nodes {
		r := root(n.ID)
		if _, ok := members[r]; !ok {
			order = append(order, r)
		}
		members[r] = append(members[r], n)
	}
	for i, r := range order {
		ms := members[r]
		gr := Group{ID: fmt.Sprintf("g%d", i+1)}
		var scopes, ha []string
		for _, n := range ms {
			n.Group = gr.ID
			gr.Members = append(gr.Members, n.ID)
			if n.SystemID != "" {
				gr.SystemID = n.SystemID
			}
			if n.Role == "primary" || ((n.Role == "standalone" || n.Role == "subscriber") && len(ms) > 1) {
				gr.Primary = n.ID
			}
			if n.Patroni != nil && n.Patroni.Scope != "" {
				scopes = appendOnce(scopes, n.Patroni.Scope)
			}
			for _, s := range n.Stack {
				if s == "Patroni" || s == "repmgr" || s == "pg_auto_failover" {
					ha = appendOnce(ha, s)
				}
			}
		}
		if gr.Primary == "" && len(ms) == 1 {
			gr.Primary = ms[0].ID
		}
		switch {
		case len(scopes) > 0:
			gr.Name = scopes[0]
		case gr.Primary != "":
			gr.Name = nodeByID(res, gr.Primary).Name
		default:
			gr.Name = ms[0].Name
		}
		if len(ha) > 0 {
			gr.HA = strings.Join(ha, ", ")
		} else if len(ms) > 1 {
			gr.HA = "none (manual failover)"
		}
		res.Groups = append(res.Groups, gr)
	}
}

func appendOnce(list []string, s string) []string {
	for _, x := range list {
		if x == s {
			return list
		}
	}
	return append(list, s)
}

func nodeByID(res *Result, id string) *Node {
	for _, n := range res.Nodes {
		if n.ID == id {
			return n
		}
	}
	return &Node{ID: id, Name: id}
}

/* ------------------------------------------------------------ in plain words ------------------------------------------------------------ */

func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%d %s", n, many)
}

func bytesText(b float64) string {
	units := []string{"B", "KB", "MB", "GB", "TB"}
	i := 0
	for b >= 1024 && i < len(units)-1 {
		b /= 1024
		i++
	}
	if i == 0 {
		return fmt.Sprintf("%.0f B", b)
	}
	return fmt.Sprintf("%.1f %s", b, units[i])
}

func describe(res *Result) {
	c := &res.Counts
	versions := map[string]bool{}
	stack := map[string]bool{}
	for _, n := range res.Nodes {
		if n.External {
			continue
		}
		c.Nodes++
		if !n.Reachable {
			continue
		}
		c.Reachable++
		switch n.Role {
		case "primary", "standalone":
			c.Primaries++
		case "standby":
			c.Standbys++
		case "subscriber":
			c.Subscribers++
		}
		if n.Role != "standby" {
			for _, d := range n.Databases {
				c.Databases++
				c.SizeBytes += d.SizeBytes
			}
		}
		if n.VersionNum > 0 {
			versions[fmt.Sprintf("PostgreSQL %d", n.VersionNum/10000)] = true
		}
		for _, s := range n.Stack {
			stack[s] = true
		}
	}

	streaming, logical := 0, 0
	for _, e := range res.Edges {
		if e.Kind == "streaming" {
			streaming++
		} else {
			logical++
		}
	}

	// the short name
	physical := 0
	for _, gr := range res.Groups {
		if len(gr.Members) > 1 {
			physical++
		}
	}
	var name string
	switch {
	case c.Reachable == 0 && allLoginFailed(res):
		name = "Login failed on every server"
	case c.Reachable == 0:
		name = "Nothing reachable"
	case len(res.Groups) == 1 && streaming == 0 && logical == 0:
		name = "Standalone server"
	case len(res.Groups) == 1:
		gr := res.Groups[0]
		name = fmt.Sprintf("Primary with %s", plural(len(gr.Members)-1, "streaming standby", "streaming standbys"))
		if strings.Contains(gr.HA, "Patroni") {
			name = fmt.Sprintf("Patroni HA cluster (%d nodes)", len(gr.Members))
		} else if gr.HA != "" && !strings.HasPrefix(gr.HA, "none") {
			name += " (" + gr.HA + ")"
		}
	default:
		switch {
		case physical == 1:
			for _, gr := range res.Groups {
				if len(gr.Members) > 1 {
					name = fmt.Sprintf("Primary with %s", plural(len(gr.Members)-1, "streaming standby", "streaming standbys"))
					if strings.Contains(gr.HA, "Patroni") {
						name = fmt.Sprintf("Patroni HA cluster (%d nodes)", len(gr.Members))
					}
				}
			}
		case physical > 1 && logical > 0:
			name = plural(physical, "replicated cluster", "replicated clusters") + " linked by logical replication"
		case physical > 1:
			name = plural(physical, "replicated cluster", "replicated clusters")
		default:
			name = plural(c.Reachable, "separate server", "separate servers")
		}
		if c.Subscribers > 0 {
			name += " + " + plural(c.Subscribers, "logical replica", "logical replicas")
		} else if logical > 0 && !strings.Contains(name, "logical") {
			name += " + logical replication"
		}
	}
	if stack["Citus"] {
		name = "Citus distributed cluster · " + name
	}
	res.Architecture = name

	// sentences
	var lines []string
	for _, gr := range res.Groups {
		if len(gr.Members) == 1 {
			n := nodeByID(res, gr.Members[0])
			if n.External || !n.Reachable {
				continue
			}
			if n.Role == "subscriber" {
				lines = append(lines, fmt.Sprintf("%s is its own read-write server that receives data through logical replication.", n.Name))
			} else if n.Role != "standby" {
				lines = append(lines, fmt.Sprintf("%s is a primary with no streaming standbys.", n.Name))
			}
			continue
		}
		p := nodeByID(res, gr.Primary)
		var sync, async, cascade int
		for _, e := range res.Edges {
			if e.Kind != "streaming" || nodeByID(res, e.To).Group != gr.ID {
				continue
			}
			if e.From != gr.Primary {
				cascade++
			}
			if e.Sync == "sync" || e.Sync == "quorum" {
				sync++
			} else {
				async++
			}
		}
		verb := "copy"
		if len(gr.Members) == 2 {
			verb = "copies"
		}
		s := fmt.Sprintf("%s is the primary; %s %s it by streaming replication", p.Name,
			plural(len(gr.Members)-1, "standby", "standbys"), verb)
		var parts []string
		if async > 0 {
			parts = append(parts, fmt.Sprintf("%d asynchronous", async))
		}
		if sync > 0 {
			parts = append(parts, fmt.Sprintf("%d synchronous", sync))
		}
		if cascade > 0 {
			parts = append(parts, fmt.Sprintf("%d cascading (from another standby)", cascade))
		}
		if len(parts) > 0 {
			s += " (" + strings.Join(parts, ", ") + ")"
		}
		lines = append(lines, s+".")
		if gr.HA != "" {
			if strings.HasPrefix(gr.HA, "none") {
				lines = append(lines, fmt.Sprintf("No failover manager found for %s: if the primary fails, a standby must be promoted by hand.", gr.Name))
			} else {
				lines = append(lines, fmt.Sprintf("Failover for %s is managed by %s.", gr.Name, gr.HA))
			}
		}
	}
	for _, e := range res.Edges {
		if e.Kind == "logical" {
			lines = append(lines, fmt.Sprintf("%s sends %s to %s by logical replication.",
				nodeByID(res, e.From).Name, e.Label, nodeByID(res, e.To).Name))
		}
	}
	if len(versions) > 0 {
		vs := make([]string, 0, len(versions))
		for v := range versions {
			vs = append(vs, v)
		}
		sort.Strings(vs)
		lines = append(lines, fmt.Sprintf("Versions: %s. %s, %s in total.", strings.Join(vs, ", "),
			plural(c.Databases, "database", "databases"), bytesText(c.SizeBytes)))
	}
	if c.Reachable < c.Nodes {
		lines = append(lines, fmt.Sprintf("%d of %d servers could not be reached.", c.Nodes-c.Reachable, c.Nodes))
	}
	res.Summary = lines
	findings(res)
}

func findings(res *Result) {
	add := func(sev string, n *Node, f string, a ...any) {
		id := ""
		if n != nil {
			id = n.ID
		}
		res.Findings = append(res.Findings, Finding{Severity: sev, Node: id, Text: fmt.Sprintf(f, a...)})
	}
	primaryBySys := map[string][]*Node{}
	for _, n := range res.Nodes {
		if n.External {
			continue
		}
		if !n.Reachable {
			add("critical", n, "%s: cannot connect - %s.", n.ID, n.Error)
			continue
		}
		if n.Role != "standby" && n.SystemID != "" {
			primaryBySys[n.SystemID] = append(primaryBySys[n.SystemID], n)
		}
		if n.VersionNum > 0 && n.VersionNum < 140000 {
			add("warning", n, "%s runs %s, which no longer gets security fixes. Plan an upgrade.", n.Name, n.Version)
		}
		for _, s := range n.Slots {
			if !s.Active && s.RetainedBytes > 1<<30 {
				add("critical", n, "%s: replication slot %s is not in use but keeps %s of WAL; the disk can fill up. Drop it if nothing needs it.", n.Name, s.Name, bytesText(s.RetainedBytes))
			} else if !s.Active {
				add("warning", n, "%s: replication slot %s is not in use (it keeps WAL until it is used or dropped).", n.Name, s.Name)
			}
			if s.WalStatus == "lost" {
				add("critical", n, "%s: replication slot %s has lost WAL its consumer still needs; that standby or subscriber must be rebuilt.", n.Name, s.Name)
			}
		}
		if n.Receiver != nil && n.Receiver.Status != "streaming" {
			add("critical", n, "%s is a standby but is not streaming from %s:%d (%s).", n.Name, n.Receiver.SenderHost, n.Receiver.SenderPort, n.Receiver.Status)
		}
		for _, s := range n.Subscriptions {
			if !s.Enabled {
				add("warning", n, "%s: subscription %s is disabled.", n.Name, s.Name)
			} else if !s.Receiving {
				add("warning", n, "%s: subscription %s is not receiving changes.", n.Name, s.Name)
			}
			if s.Tables > s.TablesReady {
				add("info", n, "%s: subscription %s is still copying %d of %d tables.", n.Name, s.Name, s.Tables-s.TablesReady, s.Tables)
			}
		}
		if n.settingsByName["data_checksums"] == "off" {
			add("info", n, "%s: data checksums are off, so silent disk corruption would go unnoticed.", n.Name)
		}
		if n.settingsByName["password_encryption"] == "md5" {
			add("info", n, "%s: passwords are stored as MD5; scram-sha-256 is safer.", n.Name)
		}
		if !n.Superuser && len(n.Partial) > 0 {
			add("info", n, "%s: this login is not a superuser, so some details could not be read (%d parts). A superuser or a role with pg_monitor and pg_read_all_settings shows everything.", n.Name, len(n.Partial))
		}
	}
	for _, e := range res.Edges {
		to := nodeByID(res, e.To)
		if e.Kind == "streaming" && e.LagBytes > 64<<20 {
			add("warning", to, "%s is %s behind its upstream.", to.Name, bytesText(e.LagBytes))
		}
		if e.Kind == "streaming" && e.Slot == "" {
			from := nodeByID(res, e.From)
			if am := from.settingsByName["archive_mode"]; am != "on" && am != "always" {
				add("info", to, "%s streams without a replication slot and the primary does not archive WAL: if it falls behind too far it cannot catch up.", to.Name)
			}
		}
	}
	for _, ns := range primaryBySys {
		if len(ns) > 1 {
			var names []string
			for _, n := range ns {
				names = append(names, n.Name)
			}
			add("critical", ns[0], "Split brain: %s are all writable copies of the same cluster (same system identifier).", strings.Join(names, ", "))
		}
	}
	for _, gr := range res.Groups {
		vs := map[int]bool{}
		for _, id := range gr.Members {
			if n := nodeByID(res, id); n.VersionNum > 0 {
				vs[n.VersionNum/10000] = true
			}
		}
		if len(vs) > 1 {
			add("warning", nil, "%s: its servers run different major versions.", gr.Name)
		}
	}
	order := map[string]int{"critical": 0, "warning": 1, "info": 2}
	sort.SliceStable(res.Findings, func(i, j int) bool { return order[res.Findings[i].Severity] < order[res.Findings[j].Severity] })
}

// allLoginFailed: every server answered but refused the login (wrong user/password or pg_hba)
func allLoginFailed(res *Result) bool {
	n := 0
	for _, x := range res.Nodes {
		if x.External {
			continue
		}
		if !strings.Contains(x.Error, "username or password") && !strings.Contains(x.Error, "pg_hba") {
			return false
		}
		n++
	}
	return n > 0
}
