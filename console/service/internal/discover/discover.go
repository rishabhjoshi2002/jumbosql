// Package discover looks at any PostgreSQL servers the console can reach - built by pg_genin or not - with
// one database login, and works out the architecture: which node is a primary, which are streaming
// standbys (and of whom), which take data through logical replication, what manages failover, and the
// details of every node. It only reads; it never changes anything on the servers.
package discover

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"postgresql-cluster-console/pkg/sqlrun"
)

// Target is one entry of the inventory.
type Target struct {
	Host string `json:"host"`
	Port int    `json:"port"`
}

// Request: the inventory and one login for all of it.
type Request struct {
	Targets  []Target
	User     string
	Password string
	Database string // the database to log in to first (default postgres)
	SSLMode  string
}

type Setting struct {
	Name  string `json:"name"`
	Value string `json:"value"`
	Unit  string `json:"unit,omitempty"`
}

type Publication struct {
	Name      string   `json:"name"`
	AllTables bool     `json:"all_tables"`
	Tables    []string `json:"tables"`
}

type Subscription struct {
	Name          string   `json:"name"`
	Database      string   `json:"database"`
	Enabled       bool     `json:"enabled"`
	Publications  []string `json:"publications"`
	PublisherHost string   `json:"publisher_host,omitempty"`
	PublisherPort int      `json:"publisher_port,omitempty"`
	PublisherDB   string   `json:"publisher_db,omitempty"`
	SlotName      string   `json:"slot_name,omitempty"`
	Receiving     bool     `json:"receiving"`
	LastMessageAt string   `json:"last_message_at,omitempty"`
	Tables        int      `json:"tables"`
	TablesReady   int      `json:"tables_ready"`
}

type Database struct {
	Name          string        `json:"name"`
	Owner         string        `json:"owner"`
	Encoding      string        `json:"encoding"`
	SizeBytes     float64       `json:"size_bytes"`
	Tables        int           `json:"tables"`
	Extensions    []string      `json:"extensions"`
	Publications  []Publication `json:"publications"`
	Inventory     *Inventory    `json:"inventory,omitempty"` // everything inside (for migrations)
	Error         string        `json:"error,omitempty"`
	connectFailed bool
}

// Sender is a walsender on this node: a standby or a logical subscriber reading from it.
type Sender struct {
	Application string  `json:"application_name"`
	ClientAddr  string  `json:"client_addr"`
	State       string  `json:"state"`
	SyncState   string  `json:"sync_state"`
	Kind        string  `json:"kind"` // physical | logical
	SlotName    string  `json:"slot_name,omitempty"`
	LagBytes    float64 `json:"lag_bytes"` // not yet replayed (physical) / confirmed (logical)
	ReplayLag   float64 `json:"replay_lag_seconds"`
	matched     bool
}

type Slot struct {
	Name          string  `json:"name"`
	Type          string  `json:"type"`
	Database      string  `json:"database,omitempty"`
	Plugin        string  `json:"plugin,omitempty"`
	Active        bool    `json:"active"`
	RetainedBytes float64 `json:"retained_bytes"`
	WalStatus     string  `json:"wal_status,omitempty"`
}

// Receiver is this standby's connection to its upstream.
type Receiver struct {
	SenderHost string `json:"sender_host"`
	SenderPort int    `json:"sender_port"`
	Status     string `json:"status"`
	SlotName   string `json:"slot_name,omitempty"`
	LastMsgAt  string `json:"last_message_at,omitempty"`
	FromConf   bool   `json:"from_config,omitempty"` // not streaming: taken from primary_conninfo
}

type Role struct {
	Name        string `json:"name"`
	Superuser   bool   `json:"superuser"`
	Replication bool   `json:"replication"`
	Login       bool   `json:"login"`
	CreateDB    bool   `json:"createdb"`
	CreateRole  bool   `json:"createrole"`
	ValidUntil  string `json:"valid_until,omitempty"`
}

type Patroni struct {
	URL     string `json:"url"`
	Scope   string `json:"scope,omitempty"`
	Role    string `json:"role,omitempty"`
	State   string `json:"state,omitempty"`
	Version string `json:"version,omitempty"`
}

// Node is everything learned about one inventory entry (or an upstream / client found outside it).
type Node struct {
	ID              string         `json:"id"`
	Host            string         `json:"host"`
	Port            int            `json:"port"`
	External        bool           `json:"external,omitempty"` // seen as an upstream or client, not in the inventory
	Reachable       bool           `json:"reachable"`
	Error           string         `json:"error,omitempty"`
	Name            string         `json:"name,omitempty"` // cluster_name, or the host
	Role            string         `json:"role"`           // primary | standby | standalone | subscriber | unknown
	Version         string         `json:"version,omitempty"`
	VersionNum      int            `json:"version_num,omitempty"`
	SystemID        string         `json:"system_id,omitempty"`
	Timeline        int            `json:"timeline,omitempty"`
	StartedAt       string         `json:"started_at,omitempty"`
	ServerAddr      string         `json:"server_addr,omitempty"`
	DataDirectory   string         `json:"data_directory,omitempty"`
	Superuser       bool           `json:"login_is_superuser"`
	Connections     map[string]int `json:"connections,omitempty"`
	MaxConnections  int            `json:"max_connections,omitempty"`
	Settings        []Setting      `json:"settings,omitempty"`
	Databases       []Database     `json:"databases,omitempty"`
	Senders         []Sender       `json:"senders,omitempty"`
	Slots           []Slot         `json:"slots,omitempty"`
	Receiver        *Receiver      `json:"receiver,omitempty"`
	Subscriptions   []Subscription `json:"subscriptions,omitempty"`
	Roles           []Role         `json:"roles,omitempty"`
	Stack           []string       `json:"stack,omitempty"` // Patroni, repmgr, Citus, pglogical, ...
	Patroni         *Patroni       `json:"patroni,omitempty"`
	Group           string         `json:"group,omitempty"`   // physical cluster (same system identifier)
	Partial         []string       `json:"partial,omitempty"` // what this login could not read
	aliases         map[string]bool
	settingsByName  map[string]string
	primaryConninfo string
}

type Edge struct {
	From      string  `json:"from"`
	To        string  `json:"to"`
	Kind      string  `json:"kind"` // streaming | logical
	Sync      string  `json:"sync,omitempty"`
	State     string  `json:"state,omitempty"`
	LagBytes  float64 `json:"lag_bytes"`
	ReplayLag float64 `json:"replay_lag_seconds"`
	Slot      string  `json:"slot,omitempty"`
	Label     string  `json:"label,omitempty"` // logical: publications and database
	Healthy   bool    `json:"healthy"`
}

type Group struct {
	ID       string   `json:"id"`
	SystemID string   `json:"system_id"`
	Name     string   `json:"name"`
	Primary  string   `json:"primary,omitempty"`
	Members  []string `json:"members"`
	HA       string   `json:"ha"`
}

type Finding struct {
	Severity string `json:"severity"` // critical | warning | info
	Node     string `json:"node,omitempty"`
	Text     string `json:"text"`
}

type Result struct {
	At           time.Time `json:"at"`
	Architecture string    `json:"architecture"` // a short name for the whole setup
	Summary      []string  `json:"summary"`      // plain sentences
	Nodes        []*Node   `json:"nodes"`
	Edges        []Edge    `json:"edges"`
	Groups       []Group   `json:"groups"`
	Findings     []Finding `json:"findings"`
	Counts       struct {
		Nodes       int     `json:"nodes"`
		Reachable   int     `json:"reachable"`
		Primaries   int     `json:"primaries"`
		Standbys    int     `json:"standbys"`
		Subscribers int     `json:"subscribers"`
		Databases   int     `json:"databases"`
		SizeBytes   float64 `json:"size_bytes"`
	} `json:"counts"`
}

// ParseInventory reads "host", "host:port", "host port" or "host,port" lines; # starts a comment.
func ParseInventory(text string) ([]Target, error) {
	var out []Target
	seen := map[string]bool{}
	for i, line := range strings.Split(text, "\n") {
		if j := strings.IndexByte(line, '#'); j >= 0 {
			line = line[:j]
		}
		f := strings.FieldsFunc(line, func(r rune) bool { return r == ' ' || r == '\t' || r == ',' })
		if len(f) == 0 {
			continue
		}
		host, port := f[0], 5432
		if h, p, err := net.SplitHostPort(f[0]); err == nil {
			host = h
			n, err := strconv.Atoi(p)
			if err != nil {
				return nil, fmt.Errorf("line %d: bad port %q", i+1, p)
			}
			port = n
		} else if len(f) > 1 {
			n, err := strconv.Atoi(f[1])
			if err != nil {
				return nil, fmt.Errorf("line %d: bad port %q", i+1, f[1])
			}
			port = n
		}
		host = strings.Trim(host, "[]")
		if port < 1 || port > 65535 || host == "" || strings.ContainsAny(host, "'\"\\ ") {
			return nil, fmt.Errorf("line %d: %q is not a host[:port]", i+1, strings.TrimSpace(line))
		}
		key := fmt.Sprintf("%s:%d", host, port)
		if !seen[key] {
			seen[key] = true
			out = append(out, Target{Host: host, Port: port})
		}
	}
	if len(out) == 0 {
		return nil, errors.New("the inventory is empty")
	}
	if len(out) > 50 {
		return nil, errors.New("at most 50 servers at a time")
	}
	return out, nil
}

// Run probes every target (in parallel) and puts the picture together.
func Run(ctx context.Context, req Request) *Result {
	res := &Result{At: time.Now().UTC(), Edges: []Edge{}, Groups: []Group{}, Findings: []Finding{}, Summary: []string{}}
	nodes := make([]*Node, len(req.Targets))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	for i, t := range req.Targets {
		wg.Add(1)
		go func(i int, t Target) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			nctx, cancel := context.WithTimeout(ctx, 45*time.Second)
			defer cancel()
			nodes[i] = probe(nctx, req, t)
		}(i, t)
	}
	wg.Wait()
	res.Nodes = nodes
	link(res)
	describe(res)
	return res
}

/* ------------------------------------------------------------ one node ------------------------------------------------------------ */

func newNode(host string, port int) *Node {
	n := &Node{ID: fmt.Sprintf("%s:%d", host, port), Host: host, Port: port, Role: "unknown", Name: host,
		aliases: map[string]bool{}, settingsByName: map[string]string{}}
	n.addAlias(host)
	return n
}

func (n *Node) addAlias(h string) {
	h = strings.TrimSpace(strings.Trim(h, "[]"))
	if h == "" {
		return
	}
	if i := strings.IndexByte(h, '/'); i > 0 { // inet text "10.0.0.5/32"
		h = h[:i]
	}
	n.aliases[strings.ToLower(h)] = true
}

func (n *Node) resolveAliases() {
	for h := range n.aliases {
		if net.ParseIP(h) == nil {
			if ips, err := net.LookupHost(h); err == nil {
				for _, ip := range ips {
					n.aliases[ip] = true
				}
			}
		}
	}
}

func q(ctx context.Context, c *pgconn.PgConn, sql string) ([][]string, error) {
	res, err := c.Exec(ctx, sql).ReadAll()
	if err != nil {
		return nil, err
	}
	var out [][]string
	for _, r := range res {
		if r.Err != nil {
			return nil, r.Err
		}
		for _, row := range r.Rows {
			v := make([]string, len(row))
			for i, b := range row {
				v[i] = string(b)
			}
			out = append(out, v)
		}
	}
	return out, nil
}

func atoi(s string) int { v, _ := strconv.Atoi(strings.TrimSpace(s)); return v }
func atof(s string) float64 {
	v, _ := strconv.ParseFloat(strings.TrimSpace(s), 64)
	return v
}
func tb(s string) bool { return s == "t" || s == "true" || s == "on" }

func target(req Request, host string, port int, db string) sqlrun.Target {
	return sqlrun.Target{Host: host, Port: port, User: req.User, Password: req.Password, Database: db,
		SSLMode: req.SSLMode, AppName: "pg_genin discover"}
}

// settings shown for every node (the ones that describe its role and capacity)
var shownSettings = []string{
	"server_version", "data_directory", "port", "listen_addresses", "max_connections", "shared_buffers", "effective_cache_size",
	"work_mem", "maintenance_work_mem", "wal_level", "max_wal_senders", "max_replication_slots",
	"wal_keep_size", "max_slot_wal_keep_size", "synchronous_commit", "synchronous_standby_names", "hot_standby",
	"hot_standby_feedback", "primary_conninfo", "primary_slot_name", "recovery_target_timeline", "archive_mode",
	"archive_command", "restore_command", "data_checksums", "ssl", "password_encryption",
	"shared_preload_libraries", "cluster_name", "timezone", "max_worker_processes", "max_logical_replication_workers",
	"autovacuum", "log_destination", "logging_collector", "log_directory",
}

func probe(ctx context.Context, req Request, t Target) *Node {
	n := newNode(t.Host, t.Port)
	db := req.Database
	if db == "" {
		db = "postgres"
	}
	c, err := sqlrun.Connect(ctx, target(req, t.Host, t.Port, db))
	if err != nil {
		n.Error = friendlyErr(err)
		n.Patroni = probePatroni(ctx, t.Host) // still useful: tells what runs there
		return n
	}
	defer c.Close(context.Background())
	n.Reachable = true
	partial := func(what string, err error) {
		if err != nil {
			n.Partial = append(n.Partial, what+": "+friendlyErr(err))
		}
	}

	// identity and role
	if r, err := q(ctx, c, `select version(), current_setting('server_version_num'), pg_is_in_recovery(),
		pg_postmaster_start_time(), coalesce(host(inet_server_addr()), ''),
		(select rolsuper from pg_roles where rolname = current_user),
		coalesce(current_setting('cluster_name', true), '')`); err == nil && len(r) == 1 {
		v := r[0]
		n.Version = shortVersion(v[0])
		n.VersionNum = atoi(v[1])
		if tb(v[2]) {
			n.Role = "standby"
		} else {
			n.Role = "primary"
		}
		n.StartedAt = v[3]
		n.ServerAddr = v[4]
		n.addAlias(v[4])
		n.Superuser = tb(v[5])
		n.Name = v[6]
	} else {
		partial("identity", err)
	}
	if r, err := q(ctx, c, `select system_identifier from pg_control_system()`); err == nil && len(r) == 1 {
		n.SystemID = r[0][0]
	} else {
		partial("system identifier (needs superuser or pg_monitor... try a superuser)", err)
	}
	if r, err := q(ctx, c, `select timeline_id from pg_control_checkpoint()`); err == nil && len(r) == 1 {
		n.Timeline = atoi(r[0][0])
	}

	// settings (primary_conninfo etc. need superuser or pg_read_all_settings; others show '********')
	names := "'" + strings.Join(shownSettings, "','") + "'"
	if r, err := q(ctx, c, `select name, setting, coalesce(unit, '') from pg_settings where name in (`+names+`)`); err == nil {
		for _, v := range r {
			n.settingsByName[v[0]] = v[1]
		}
		for _, name := range shownSettings {
			if val, ok := n.settingsByName[name]; ok {
				if name == "primary_conninfo" {
					n.primaryConninfo = val
					val = maskConninfo(val)
				}
				n.Settings = append(n.Settings, Setting{Name: name, Value: val, Unit: unitOf(r, name)})
			}
		}
		n.MaxConnections = atoi(n.settingsByName["max_connections"])
	} else {
		partial("settings", err)
	}
	if n.Name == "" {
		n.Name = n.Host
	}

	// connections by state
	if r, err := q(ctx, c, `select coalesce(state, 'background'), count(*) from pg_stat_activity group by 1`); err == nil {
		n.Connections = map[string]int{}
		for _, v := range r {
			n.Connections[v[0]] = atoi(v[1])
		}
	}

	// walsenders (who reads from this node), with the slot they use to tell physical from logical
	if r, err := q(ctx, c, `select coalesce(r.application_name, ''), coalesce(host(r.client_addr), ''), coalesce(r.state, ''),
		coalesce(r.sync_state, ''), coalesce(s.slot_type, 'physical'),
		coalesce(s.slot_name, ''),
		coalesce(case when pg_is_in_recovery() then pg_wal_lsn_diff(pg_last_wal_receive_lsn(), r.replay_lsn)
		              else pg_wal_lsn_diff(pg_current_wal_lsn(), coalesce(r.replay_lsn, r.flush_lsn)) end, 0),
		coalesce(extract(epoch from r.replay_lag), 0)
		from pg_stat_replication r left join pg_replication_slots s on s.active_pid = r.pid`); err == nil {
		for _, v := range r {
			n.Senders = append(n.Senders, Sender{Application: v[0], ClientAddr: v[1], State: v[2], SyncState: v[3],
				Kind: v[4], SlotName: v[5], LagBytes: atof(v[6]), ReplayLag: atof(v[7])})
		}
	} else {
		partial("replication (pg_stat_replication)", err)
	}

	// replication slots
	if r, err := q(ctx, c, `select slot_name, slot_type, coalesce(database, ''), coalesce(plugin, ''), active,
		coalesce(pg_wal_lsn_diff(case when pg_is_in_recovery() then pg_last_wal_replay_lsn() else pg_current_wal_lsn() end,
		         coalesce(confirmed_flush_lsn, restart_lsn)), 0), coalesce(wal_status, '')
		from pg_replication_slots order by slot_name`); err == nil {
		for _, v := range r {
			n.Slots = append(n.Slots, Slot{Name: v[0], Type: v[1], Database: v[2], Plugin: v[3], Active: tb(v[4]),
				RetainedBytes: atof(v[5]), WalStatus: v[6]})
		}
	} else {
		partial("replication slots", err)
	}

	// a standby's upstream
	if n.Role == "standby" {
		if r, err := q(ctx, c, `select coalesce(sender_host, ''), coalesce(sender_port, 0), coalesce(status, ''),
			coalesce(slot_name, ''), coalesce(last_msg_receipt_time::text, '') from pg_stat_wal_receiver`); err == nil && len(r) > 0 && r[0][0] != "" {
			v := r[0]
			n.Receiver = &Receiver{SenderHost: v[0], SenderPort: atoi(v[1]), Status: v[2], SlotName: v[3], LastMsgAt: v[4]}
		} else if h, p, ok := conninfoHost(n.primaryConninfo); ok {
			n.Receiver = &Receiver{SenderHost: h, SenderPort: p, Status: "not streaming", FromConf: true,
				SlotName: n.settingsByName["primary_slot_name"]}
		} else if err != nil {
			partial("standby upstream (pg_stat_wal_receiver)", err)
		}
	}

	// roles
	if r, err := q(ctx, c, `select rolname, rolsuper, rolreplication, rolcanlogin, rolcreatedb, rolcreaterole,
		coalesce(rolvaliduntil::text, '') from pg_roles where rolname !~ '^pg_' order by rolname`); err == nil {
		for _, v := range r {
			n.Roles = append(n.Roles, Role{Name: v[0], Superuser: tb(v[1]), Replication: tb(v[2]), Login: tb(v[3]),
				CreateDB: tb(v[4]), CreateRole: tb(v[5]), ValidUntil: v[6]})
		}
	}

	// databases (size needs CONNECT on it, or pg_read_all_stats)
	if r, err := q(ctx, c, `select d.datname, pg_get_userbyid(d.datdba), pg_encoding_to_char(d.encoding),
		coalesce(case when has_database_privilege(d.oid, 'CONNECT') then pg_database_size(d.oid) end, 0)
		from pg_database d where d.datallowconn and not d.datistemplate order by d.datname`); err == nil {
		for _, v := range r {
			n.Databases = append(n.Databases, Database{Name: v[0], Owner: v[1], Encoding: v[2], SizeBytes: atof(v[3])})
		}
	} else {
		partial("databases", err)
	}

	// subscriptions (shared catalog; the connection string is superuser-only)
	subSQL := `select s.subname, d.datname, s.subenabled, array_to_string(s.subpublications, ','), %s,
		coalesce(s.subslotname, ''), coalesce((select bool_or(w.received_lsn is not null) from pg_stat_subscription w where w.subid = s.oid), false),
		coalesce((select max(w.last_msg_receipt_time)::text from pg_stat_subscription w where w.subid = s.oid), '')
		from pg_subscription s join pg_database d on d.oid = s.subdbid order by 1`
	r, err := q(ctx, c, fmt.Sprintf(subSQL, "s.subconninfo"))
	if err != nil {
		r, err = q(ctx, c, fmt.Sprintf(subSQL, "''"))
	}
	if err == nil {
		for _, v := range r {
			s := Subscription{Name: v[0], Database: v[1], Enabled: tb(v[2]), Publications: splitList(v[3]),
				SlotName: v[5], Receiving: tb(v[6]), LastMessageAt: v[7]}
			if h, p, ok := conninfoHost(v[4]); ok {
				s.PublisherHost, s.PublisherPort = h, p
				s.PublisherDB = conninfoDB(v[4])
			}
			n.Subscriptions = append(n.Subscriptions, s)
		}
	} else if n.VersionNum >= 100000 {
		partial("subscriptions", err)
	}

	// per database: tables, extensions, publications, subscription table states
	for i := range n.Databases {
		if i >= 30 {
			n.Partial = append(n.Partial, fmt.Sprintf("only the first 30 of %d databases were opened", len(n.Databases)))
			break
		}
		d := &n.Databases[i]
		dc := c
		if d.Name != db {
			dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			conn, err := sqlrun.Connect(dctx, target(req, t.Host, t.Port, d.Name))
			cancel()
			if err != nil {
				d.Error = friendlyErr(err)
				d.connectFailed = true
				continue
			}
			dc = conn
		}
		probeDatabase(ctx, dc, d, n)
		ictx, cancel := context.WithTimeout(ctx, 30*time.Second)
		d.Inventory = collectInventory(ictx, dc, n.VersionNum)
		cancel()
		if dc != c {
			dc.Close(context.Background())
		}
	}

	n.Stack = stackOf(n)
	n.Patroni = probePatroni(ctx, t.Host)
	if n.Patroni != nil {
		n.Stack = append([]string{"Patroni"}, n.Stack...)
	}
	return n
}

func probeDatabase(ctx context.Context, c *pgconn.PgConn, d *Database, n *Node) {
	if r, err := q(ctx, c, `select count(*) from pg_class c join pg_namespace s on s.oid = c.relnamespace
		where c.relkind in ('r', 'p') and s.nspname not in ('pg_catalog', 'information_schema') and s.nspname !~ '^pg_toast'`); err == nil && len(r) == 1 {
		d.Tables = atoi(r[0][0])
	}
	if r, err := q(ctx, c, `select extname || ' ' || extversion from pg_extension where extname <> 'plpgsql' order by 1`); err == nil {
		for _, v := range r {
			d.Extensions = append(d.Extensions, v[0])
		}
	}
	if r, err := q(ctx, c, `select p.pubname, p.puballtables,
		coalesce((select string_agg(t.schemaname || '.' || t.tablename, ',' order by 1) from pg_publication_tables t where t.pubname = p.pubname), '')
		from pg_publication p order by 1`); err == nil {
		for _, v := range r {
			d.Publications = append(d.Publications, Publication{Name: v[0], AllTables: tb(v[1]), Tables: splitList(v[2])})
		}
	}
	// table sync state of this database's subscriptions
	if r, err := q(ctx, c, `select s.subname, count(*), count(*) filter (where r.srsubstate = 'r')
		from pg_subscription_rel r join pg_subscription s on s.oid = r.srsubid group by 1`); err == nil {
		for _, v := range r {
			for i := range n.Subscriptions {
				if n.Subscriptions[i].Name == v[0] && n.Subscriptions[i].Database == d.Name {
					n.Subscriptions[i].Tables, n.Subscriptions[i].TablesReady = atoi(v[1]), atoi(v[2])
				}
			}
		}
	}
}

func unitOf(rows [][]string, name string) string {
	for _, v := range rows {
		if v[0] == name {
			return v[2]
		}
	}
	return ""
}

func splitList(s string) []string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return strings.Split(s, ",")
}

func shortVersion(v string) string { // "PostgreSQL 17.6 on x86_64-pc-linux-gnu, ..." -> "PostgreSQL 17.6"
	f := strings.Fields(v)
	if len(f) >= 2 {
		return f[0] + " " + strings.TrimSuffix(f[1], ",")
	}
	return v
}

func friendlyErr(err error) string {
	var pe *pgconn.PgError
	if errors.As(err, &pe) {
		switch pe.Code {
		case "28P01":
			return "wrong username or password"
		case "28000":
			return "not allowed by pg_hba.conf (add a line for the console's IP) - " + pe.Message
		case "3D000":
			return "database does not exist"
		case "42501":
			return "permission denied - " + pe.Message
		}
		return pe.Message
	}
	s := err.Error()
	switch {
	case strings.Contains(s, "connection refused"):
		return "connection refused (PostgreSQL not listening on this address/port, or a firewall)"
	case strings.Contains(s, "i/o timeout"), strings.Contains(s, "context deadline"), strings.Contains(s, "no route"):
		return "no answer (host down, wrong address or a firewall)"
	case strings.Contains(s, "no such host"):
		return "unknown host name"
	case strings.Contains(s, "no pg_hba.conf entry"):
		return "not allowed by pg_hba.conf (add a line for the console's IP)"
	case strings.Contains(s, "password authentication failed"):
		return "wrong username or password"
	}
	return s
}

// conninfo helpers: libpq key=value strings or URIs
func parseConninfo(ci string) (map[string]string, bool) {
	ci = strings.TrimSpace(ci)
	if ci == "" {
		return nil, false
	}
	out := map[string]string{}
	if strings.HasPrefix(ci, "postgres://") || strings.HasPrefix(ci, "postgresql://") {
		cfg, err := pgconn.ParseConfig(ci)
		if err != nil {
			return nil, false
		}
		out["host"], out["port"], out["dbname"] = cfg.Host, strconv.Itoa(int(cfg.Port)), cfg.Database
		return out, true
	}
	i := 0
	for i < len(ci) {
		for i < len(ci) && ci[i] == ' ' {
			i++
		}
		j := strings.IndexByte(ci[i:], '=')
		if j < 0 {
			break
		}
		key := strings.TrimSpace(ci[i : i+j])
		i += j + 1
		for i < len(ci) && ci[i] == ' ' {
			i++
		}
		var val strings.Builder
		if i < len(ci) && ci[i] == '\'' {
			i++
			for i < len(ci) && ci[i] != '\'' {
				if ci[i] == '\\' && i+1 < len(ci) {
					i++
				}
				val.WriteByte(ci[i])
				i++
			}
			i++
		} else {
			for i < len(ci) && ci[i] != ' ' {
				val.WriteByte(ci[i])
				i++
			}
		}
		out[key] = val.String()
	}
	return out, len(out) > 0
}

func conninfoHost(ci string) (string, int, bool) {
	m, ok := parseConninfo(ci)
	if !ok {
		return "", 0, false
	}
	h := m["host"]
	if h == "" {
		h = m["hostaddr"]
	}
	if i := strings.IndexByte(h, ','); i > 0 { // multi-host: the first one
		h = h[:i]
	}
	if h == "" || strings.HasPrefix(h, "/") {
		return "", 0, false
	}
	p := atoi(m["port"])
	if p == 0 {
		p = 5432
	}
	return h, p, true
}

func conninfoDB(ci string) string {
	m, _ := parseConninfo(ci)
	return m["dbname"]
}

func maskConninfo(ci string) string {
	m, ok := parseConninfo(ci)
	if !ok {
		return ci
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b []string
	for _, k := range keys {
		v := m[k]
		if k == "password" {
			v = "********"
		}
		switch k { // the useful parts only
		case "host", "hostaddr", "port", "user", "dbname", "application_name", "sslmode", "password":
			b = append(b, k+"="+v)
		}
	}
	return strings.Join(b, " ")
}

func stackOf(n *Node) []string {
	var out []string
	has := map[string]bool{}
	add := func(s string) {
		if !has[s] {
			has[s] = true
			out = append(out, s)
		}
	}
	for _, d := range n.Databases {
		if d.Name == "repmgr" {
			add("repmgr")
		}
		for _, e := range d.Extensions {
			switch strings.Fields(e)[0] {
			case "repmgr":
				add("repmgr")
			case "pgautofailover":
				add("pg_auto_failover")
			case "citus":
				add("Citus")
			case "pglogical":
				add("pglogical")
			case "bdr":
				add("EDB BDR / PGD")
			case "timescaledb":
				add("TimescaleDB")
			case "postgis":
				add("PostGIS")
			}
		}
	}
	if spl := n.settingsByName["shared_preload_libraries"]; strings.Contains(spl, "pg_stat_statements") {
		add("pg_stat_statements")
	}
	if am := n.settingsByName["archive_mode"]; am == "on" || am == "always" {
		cmd := n.settingsByName["archive_command"]
		switch {
		case strings.Contains(cmd, "pgbackrest"):
			add("pgBackRest")
		case strings.Contains(cmd, "wal-g"):
			add("WAL-G")
		case strings.Contains(cmd, "barman"):
			add("Barman")
		default:
			add("WAL archiving")
		}
	}
	return out
}

// probePatroni asks the Patroni REST API on the usual ports (8008, and 8009 used by the HA automation).
func probePatroni(ctx context.Context, host string) *Patroni {
	cli := &http.Client{Timeout: 2 * time.Second}
	for _, port := range []int{8008, 8009} {
		url := fmt.Sprintf("http://%s/patroni", net.JoinHostPort(host, strconv.Itoa(port)))
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		resp, err := cli.Do(req)
		if err != nil {
			continue
		}
		var body struct {
			State   string `json:"state"`
			Role    string `json:"role"`
			Patroni struct {
				Version string `json:"version"`
				Scope   string `json:"scope"`
			} `json:"patroni"`
		}
		err = json.NewDecoder(resp.Body).Decode(&body)
		resp.Body.Close()
		if err == nil && (body.Patroni.Version != "" || body.Role != "") {
			return &Patroni{URL: url, Scope: body.Patroni.Scope, Role: body.Role, State: body.State, Version: body.Patroni.Version}
		}
	}
	return nil
}
