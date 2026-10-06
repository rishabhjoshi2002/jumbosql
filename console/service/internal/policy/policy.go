// Package policy is JumboSQL's attribute-based access control (policies only).
//
// A Policy matches a request when all of these hold:
//   - subject:    the user is listed by name, or has every listed attribute with one of the listed values,
//     or the policy is for everyone
//   - resource:   the cluster matches the policy's cluster-name / environment / project patterns (empty = all);
//     only for cluster-scoped permissions
//   - database:   for sql.* permissions, the database matches the policy's database patterns (empty = all)
//   - conditions: the client IP is in one of the ranges, and the time is inside the weekdays / hours
//
// A permission is allowed when an enabled allow policy that grants it matches, and no enabled deny policy that
// lists it matches. Without a matching allow policy everything is denied.
//
// SQL data scope (schemas, tables, hidden columns, limits) comes from the matching policies' "data" and is
// enforced inside PostgreSQL (see pkg/sqlroles).
package policy

import (
	"fmt"
	"net"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Permissions. Cluster-scoped ones are checked against the cluster the request is about.
const (
	ClustersView        = "clusters.view"
	ClustersManage      = "clusters.manage"
	PatroniRead         = "patroni.read"
	PatroniManage       = "patroni.manage"
	SQLRead             = "sql.read"
	SQLWrite            = "sql.write"
	SQLAdmin            = "sql.admin"
	SQLStats            = "sql.stats"
	LogsView            = "logs.view"
	ObservabilityManage = "observability.manage"
	SettingsManage      = "settings.manage"
	UsersManage         = "users.manage"
	PoliciesManage      = "policies.manage"
	AuditView           = "audit.view"
)

type PermissionInfo struct {
	Name          string `json:"name"`
	Description   string `json:"description"`
	ClusterScoped bool   `json:"cluster_scoped"`
}

// Catalog lists every permission, in the order the UI shows them.
var Catalog = []PermissionInfo{
	{ClustersView, "See clusters, their servers, operations and deployment logs", true},
	{ClustersManage, "Create (deploy) and remove clusters and servers", true},
	{PatroniRead, "Patroni status: list, history, show-config, refresh", true},
	{PatroniManage, "Patroni actions: switchover, failover, restart, reload, reinit, pause/resume, edit-config", true},
	{SQLRead, "SQL editor, read-only (SELECT); limited by the policy's data scope", true},
	{SQLWrite, "SQL editor with INSERT / UPDATE / DELETE on the allowed tables", true},
	{SQLAdmin, "SQL editor as the cluster superuser (only when no data scope restriction applies)", true},
	{SQLStats, "See every session and statement in pg_stat_activity and friends (pg_read_all_stats)", true},
	{LogsView, "Read PostgreSQL server logs on the cluster's nodes", true},
	{ObservabilityManage, "Change the Grafana / Prometheus / Alertmanager links", false},
	{SettingsManage, "Projects, environments, secrets and console settings", false},
	{UsersManage, "Add, change and remove console users and their attributes", false},
	{PoliciesManage, "Create, change and delete access policies", false},
	{AuditView, "Read the audit log", false},
}

var clusterScoped = func() map[string]bool {
	m := map[string]bool{}
	for _, p := range Catalog {
		m[p.Name] = p.ClusterScoped
	}
	return m
}()

func Known(perm string) bool { _, ok := clusterScoped[perm]; return ok }

func IsClusterScoped(perm string) bool { return clusterScoped[perm] }

type Subjects struct {
	Everyone   bool                `json:"everyone,omitempty"`
	Users      []string            `json:"users,omitempty"`
	Attributes map[string][]string `json:"attributes,omitempty"`
}

type Resources struct {
	Clusters     []string `json:"clusters,omitempty"`     // cluster name patterns
	Environments []string `json:"environments,omitempty"` // environment names
	Projects     []string `json:"projects,omitempty"`     // project names
}

type Data struct {
	Databases      []string `json:"databases,omitempty"`      // database name patterns
	Schemas        []string `json:"schemas,omitempty"`        // schema name patterns
	Tables         []string `json:"tables,omitempty"`         // "schema.table" or "table" patterns
	HiddenColumns  []string `json:"hidden_columns,omitempty"` // "schema.table.column", "table.column" or "column" patterns
	MaxRows        int      `json:"max_rows,omitempty"`
	TimeoutSeconds int      `json:"timeout_seconds,omitempty"`
}

type Conditions struct {
	IPRanges []string `json:"ip_ranges,omitempty"` // CIDRs or single addresses
	Weekdays []int    `json:"weekdays,omitempty"`  // 1 = Monday ... 7 = Sunday
	Hours    string   `json:"hours,omitempty"`     // "08:00-20:00" (may wrap past midnight)
	Timezone string   `json:"timezone,omitempty"`  // IANA name, default UTC
}

type Policy struct {
	ID          int64      `json:"id"`
	Name        string     `json:"name"`
	Description string     `json:"description,omitempty"`
	Effect      string     `json:"effect"` // allow | deny
	Enabled     bool       `json:"enabled"`
	Builtin     bool       `json:"builtin,omitempty"`
	Subjects    Subjects   `json:"subjects"`
	Permissions []string   `json:"permissions"`
	Resources   Resources  `json:"resources"`
	Data        Data       `json:"data"`
	Conditions  Conditions `json:"conditions"`
}

// Subject is who is asking.
type Subject struct {
	UserID     int64
	Username   string
	Attributes map[string]string
	System     bool // the static API token: everything is allowed
}

// Cluster is what a cluster-scoped request is about.
type Cluster struct {
	ID          int64
	Name        string
	Environment string
	Project     string
}

// Request context for conditions.
type Context struct {
	IP  net.IP
	Now time.Time
}

/* ------------------------------------------------------------------ validation ------------------------------------------------------------------ */

// Validate checks a policy before it is saved and normalizes it (trims, sorts, lower-cases names).
func (p *Policy) Validate() error {
	p.Name = strings.TrimSpace(p.Name)
	if p.Name == "" {
		return fmt.Errorf("the policy needs a name")
	}
	if p.Effect == "" {
		p.Effect = "allow"
	}
	if p.Effect != "allow" && p.Effect != "deny" {
		return fmt.Errorf("effect must be allow or deny")
	}
	seen := map[string]bool{}
	var perms []string
	for _, perm := range p.Permissions {
		perm = strings.TrimSpace(perm)
		if !Known(perm) {
			return fmt.Errorf("unknown permission %q", perm)
		}
		if !seen[perm] {
			seen[perm] = true
			perms = append(perms, perm)
		}
	}
	sort.Strings(perms)
	p.Permissions = perms
	if p.Effect == "allow" && len(p.Permissions) == 0 {
		return fmt.Errorf("an allow policy needs at least one permission")
	}
	if p.Effect == "deny" && len(p.Permissions) == 0 && len(p.Data.HiddenColumns) == 0 {
		return fmt.Errorf("a deny policy needs permissions to take away or columns to hide")
	}
	if !p.Subjects.Everyone && len(p.Subjects.Users) == 0 && len(p.Subjects.Attributes) == 0 {
		return fmt.Errorf("choose who the policy applies to: users, user attributes, or everyone")
	}
	p.Subjects.Users = cleanList(p.Subjects.Users)
	for k, v := range p.Subjects.Attributes {
		if strings.TrimSpace(k) == "" {
			return fmt.Errorf("an attribute name is empty")
		}
		if len(cleanList(v)) == 0 {
			return fmt.Errorf("attribute %q has no values", k)
		}
		p.Subjects.Attributes[k] = cleanList(v)
	}
	p.Resources.Clusters = cleanList(p.Resources.Clusters)
	p.Resources.Environments = cleanList(p.Resources.Environments)
	p.Resources.Projects = cleanList(p.Resources.Projects)
	for _, list := range [][]string{p.Resources.Clusters, p.Data.Databases, p.Data.Schemas, p.Data.Tables, p.Data.HiddenColumns} {
		for _, pat := range list {
			if _, err := path.Match(pat, ""); err != nil {
				return fmt.Errorf("bad pattern %q", pat)
			}
		}
	}
	p.Data.Databases = cleanList(p.Data.Databases)
	p.Data.Schemas = cleanList(p.Data.Schemas)
	p.Data.Tables = cleanList(p.Data.Tables)
	p.Data.HiddenColumns = cleanList(p.Data.HiddenColumns)
	for _, t := range p.Data.Tables {
		if strings.Count(t, ".") > 1 {
			return fmt.Errorf("table pattern %q: use table or schema.table", t)
		}
	}
	for _, c := range p.Data.HiddenColumns {
		if strings.Count(c, ".") > 2 {
			return fmt.Errorf("hidden column %q: use column, table.column or schema.table.column", c)
		}
	}
	if p.Data.MaxRows < 0 || p.Data.TimeoutSeconds < 0 {
		return fmt.Errorf("limits can't be negative")
	}
	for _, r := range p.Conditions.IPRanges {
		if _, _, err := parseRange(r); err != nil {
			return fmt.Errorf("IP range %q: %v", r, err)
		}
	}
	for _, d := range p.Conditions.Weekdays {
		if d < 1 || d > 7 {
			return fmt.Errorf("weekdays are 1 (Monday) to 7 (Sunday)")
		}
	}
	if p.Conditions.Hours != "" {
		if _, _, err := parseHours(p.Conditions.Hours); err != nil {
			return err
		}
	}
	if p.Conditions.Timezone != "" {
		if _, err := time.LoadLocation(p.Conditions.Timezone); err != nil {
			return fmt.Errorf("unknown time zone %q", p.Conditions.Timezone)
		}
	}
	return nil
}

func cleanList(in []string) []string {
	var out []string
	seen := map[string]bool{}
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

/* ------------------------------------------------------------------ matching ------------------------------------------------------------------ */

func globAny(patterns []string, value string, fold bool) bool {
	if len(patterns) == 0 {
		return true
	}
	for _, p := range patterns {
		pp, vv := p, value
		if fold {
			pp, vv = strings.ToLower(p), strings.ToLower(value)
		}
		if ok, _ := path.Match(pp, vv); ok {
			return true
		}
	}
	return false
}

func (p *Policy) matchesSubject(s Subject) bool {
	if p.Subjects.Everyone {
		return true
	}
	for _, u := range p.Subjects.Users {
		if strings.EqualFold(u, s.Username) {
			return true
		}
	}
	if len(p.Subjects.Attributes) == 0 {
		return false
	}
	for key, values := range p.Subjects.Attributes {
		have, ok := s.Attributes[key]
		if !ok {
			return false
		}
		match := false
		for _, v := range values {
			if strings.EqualFold(strings.TrimSpace(v), strings.TrimSpace(have)) || v == "*" {
				match = true
				break
			}
		}
		if !match {
			return false
		}
	}
	return true
}

func (p *Policy) matchesCluster(c *Cluster) bool {
	if c == nil {
		return true
	}
	return globAny(p.Resources.Clusters, c.Name, true) &&
		globAny(p.Resources.Environments, c.Environment, true) &&
		globAny(p.Resources.Projects, c.Project, true)
}

// restrictsClusters: the policy only covers some clusters
func (p *Policy) restrictsClusters() bool {
	return len(p.Resources.Clusters)+len(p.Resources.Environments)+len(p.Resources.Projects) > 0
}

func parseRange(r string) (*net.IPNet, net.IP, error) {
	r = strings.TrimSpace(r)
	if strings.Contains(r, "/") {
		_, n, err := net.ParseCIDR(r)
		return n, nil, err
	}
	ip := net.ParseIP(r)
	if ip == nil {
		return nil, nil, fmt.Errorf("not an IP address or CIDR")
	}
	return nil, ip, nil
}

func parseHours(h string) (int, int, error) {
	parts := strings.Split(strings.TrimSpace(h), "-")
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("hours must look like 08:00-20:00")
	}
	toMin := func(s string) (int, error) {
		t, err := time.Parse("15:04", strings.TrimSpace(s))
		if err != nil {
			return 0, fmt.Errorf("hours must look like 08:00-20:00")
		}
		return t.Hour()*60 + t.Minute(), nil
	}
	a, err := toMin(parts[0])
	if err != nil {
		return 0, 0, err
	}
	b, err := toMin(parts[1])
	if err != nil {
		return 0, 0, err
	}
	return a, b, nil
}

func (p *Policy) matchesConditions(ctx Context) bool {
	c := p.Conditions
	if len(c.IPRanges) > 0 {
		if ctx.IP == nil {
			return false
		}
		in := false
		for _, r := range c.IPRanges {
			n, ip, err := parseRange(r)
			if err == nil && ((n != nil && n.Contains(ctx.IP)) || (ip != nil && ip.Equal(ctx.IP))) {
				in = true
				break
			}
		}
		if !in {
			return false
		}
	}
	if len(c.Weekdays) == 0 && c.Hours == "" {
		return true
	}
	now := ctx.Now
	if now.IsZero() {
		now = time.Now()
	}
	loc := time.UTC
	if c.Timezone != "" {
		if l, err := time.LoadLocation(c.Timezone); err == nil {
			loc = l
		}
	}
	now = now.In(loc)
	if len(c.Weekdays) > 0 {
		wd := int(now.Weekday())
		if wd == 0 {
			wd = 7
		}
		ok := false
		for _, d := range c.Weekdays {
			if d == wd {
				ok = true
				break
			}
		}
		if !ok {
			return false
		}
	}
	if c.Hours != "" {
		from, to, err := parseHours(c.Hours)
		if err != nil {
			return false
		}
		m := now.Hour()*60 + now.Minute()
		if from <= to {
			return m >= from && m < to
		}
		return m >= from || m < to // wraps past midnight
	}
	return true
}

func (p *Policy) has(perm string) bool {
	for _, x := range p.Permissions {
		if x == perm {
			return true
		}
	}
	return false
}

func isSQL(perm string) bool { return strings.HasPrefix(perm, "sql.") }

// applies: does the policy apply to this subject/cluster/database/context (ignoring permissions)?
// db == "" means "no particular database".
func (p *Policy) applies(s Subject, c *Cluster, db string, ctx Context) bool {
	return p.Enabled && p.matchesSubject(s) && p.matchesCluster(c) &&
		(db == "" || globAny(p.Data.Databases, db, false)) && p.matchesConditions(ctx)
}

/* ------------------------------------------------------------------ decisions ------------------------------------------------------------------ */

type Decision struct {
	Allowed bool   `json:"allowed"`
	Policy  string `json:"policy,omitempty"` // the policy that decided (allow or deny)
	Reason  string `json:"reason"`
}

// Set is a snapshot of all policies.
type Set struct{ Policies []Policy }

// Allowed decides one permission. c == nil for a cluster-scoped permission means "on at least one cluster"
// (used for lists and for creating clusters); then only deny policies without a cluster restriction count.
// db is only used for sql.* permissions ("" = any database).
func (set *Set) Allowed(s Subject, perm string, c *Cluster, db string, ctx Context) Decision {
	if s.System {
		return Decision{Allowed: true, Reason: "API token"}
	}
	if !Known(perm) {
		return Decision{Reason: "unknown permission " + perm}
	}
	scoped := IsClusterScoped(perm)
	var cl *Cluster
	if scoped {
		cl = c
	}
	if !isSQL(perm) {
		db = ""
	}
	for i := range set.Policies {
		p := &set.Policies[i]
		if p.Effect != "deny" || !p.has(perm) || !p.applies(s, cl, db, ctx) {
			continue
		}
		if scoped && c == nil && p.restrictsClusters() {
			continue // denies only some clusters; the user may still have it elsewhere
		}
		if isSQL(perm) && db == "" && len(p.Data.Databases) > 0 {
			continue
		}
		return Decision{Allowed: false, Policy: p.Name, Reason: "denied by policy " + p.Name}
	}
	for i := range set.Policies {
		p := &set.Policies[i]
		if p.Effect == "allow" && p.has(perm) && p.applies(s, cl, db, ctx) {
			return Decision{Allowed: true, Policy: p.Name, Reason: "allowed by policy " + p.Name}
		}
	}
	return Decision{Allowed: false, Reason: "no policy allows " + perm}
}

/* ------------------------------------------------------------------ SQL profile ------------------------------------------------------------------ */

const (
	LevelNone  = "none"
	LevelRead  = "read"
	LevelWrite = "write"
	LevelAdmin = "admin" // the cluster superuser
)

// SQLProfile is what a user may do in the SQL editor on one cluster and database.
type SQLProfile struct {
	Level          string   `json:"level"`
	Stats          bool     `json:"stats"`
	Databases      []string `json:"databases"` // patterns of the databases the user may open (empty = all)
	Schemas        []string `json:"schemas"`   // empty = all
	Tables         []string `json:"tables"`    // empty = all
	HiddenColumns  []string `json:"hidden_columns"`
	MaxRows        int      `json:"max_rows"`
	TimeoutSeconds int      `json:"timeout_seconds"`
	Policies       []string `json:"policies"`
	Note           string   `json:"note,omitempty"`
}

// Restricted: a data scope applies, so the superuser can't be used.
func (p SQLProfile) Restricted() bool {
	return len(p.Schemas) > 0 || len(p.Tables) > 0 || len(p.HiddenColumns) > 0
}

// Key identifies the PostgreSQL role for this profile (same scope = same role).
func (p SQLProfile) Key() string {
	parts := []string{p.Level, strconv.FormatBool(p.Stats), strings.Join(sorted(p.Schemas), ","),
		strings.Join(sorted(p.Tables), ","), strings.Join(sorted(p.HiddenColumns), ",")}
	return strings.Join(parts, "|")
}

func sorted(in []string) []string {
	out := append([]string(nil), in...)
	sort.Strings(out)
	return out
}

// union of patterns where an empty list means "everything" (so one unrestricted policy lifts the restriction)
type union struct {
	all  bool
	seen map[string]bool
	list []string
}

func (u *union) add(patterns []string) {
	if u.all {
		return
	}
	if len(patterns) == 0 {
		u.all, u.list = true, nil
		return
	}
	if u.seen == nil {
		u.seen = map[string]bool{}
	}
	for _, p := range patterns {
		if !u.seen[p] {
			u.seen[p] = true
			u.list = append(u.list, p)
		}
	}
}

func (u *union) result() []string {
	if u.all {
		return []string{}
	}
	return sorted(u.list)
}

// SQL works out the SQL editor profile for a user on a cluster. db == "" gives the profile without a
// particular database (level and the database patterns, for the UI).
func (set *Set) SQL(s Subject, c *Cluster, db string, ctx Context) SQLProfile {
	prof := SQLProfile{Level: LevelNone, Schemas: []string{}, Tables: []string{}, HiddenColumns: []string{}, Databases: []string{}}
	switch {
	case set.Allowed(s, SQLAdmin, c, db, ctx).Allowed:
		prof.Level = LevelAdmin
	case set.Allowed(s, SQLWrite, c, db, ctx).Allowed:
		prof.Level = LevelWrite
	case set.Allowed(s, SQLRead, c, db, ctx).Allowed:
		prof.Level = LevelRead
	}
	if prof.Level == LevelNone {
		return prof
	}
	if s.System {
		return prof
	}
	prof.Stats = set.Allowed(s, SQLStats, c, db, ctx).Allowed

	var dbs, schemas, tables union
	hidden := map[string]bool{}
	for i := range set.Policies {
		p := &set.Policies[i]
		if !p.applies(s, c, db, ctx) {
			continue
		}
		for _, h := range p.Data.HiddenColumns { // hiding applies from any matching policy, allow or deny
			hidden[h] = true
		}
		if p.Effect != "allow" || !(p.has(SQLRead) || p.has(SQLWrite) || p.has(SQLAdmin)) {
			continue
		}
		prof.Policies = append(prof.Policies, p.Name)
		dbs.add(p.Data.Databases)
		schemas.add(p.Data.Schemas)
		tables.add(p.Data.Tables)
		if p.Data.MaxRows > prof.MaxRows {
			prof.MaxRows = p.Data.MaxRows
		}
		if p.Data.TimeoutSeconds > prof.TimeoutSeconds {
			prof.TimeoutSeconds = p.Data.TimeoutSeconds
		}
	}
	prof.Databases = dbs.result()
	prof.Schemas = schemas.result()
	prof.Tables = tables.result()
	for h := range hidden {
		prof.HiddenColumns = append(prof.HiddenColumns, h)
	}
	sort.Strings(prof.HiddenColumns)
	if prof.Level == LevelAdmin && prof.Restricted() {
		prof.Level = LevelWrite
		prof.Note = "superuser access is not used because a data scope (schemas, tables or hidden columns) applies"
	}
	return prof
}

/* ------------------------------------------------------------------ explain ------------------------------------------------------------------ */

type PolicyMatch struct {
	Policy  string `json:"policy"`
	Effect  string `json:"effect"`
	Applies bool   `json:"applies"`
	Why     string `json:"why"` // why it does not apply, or "applies"
}

// Explain says, for every policy, whether it applies to this user / cluster / context and if not, why not.
func (set *Set) Explain(s Subject, c *Cluster, ctx Context) []PolicyMatch {
	out := make([]PolicyMatch, 0, len(set.Policies))
	for i := range set.Policies {
		p := &set.Policies[i]
		m := PolicyMatch{Policy: p.Name, Effect: p.Effect}
		switch {
		case !p.Enabled:
			m.Why = "disabled"
		case !p.matchesSubject(s):
			m.Why = "not for this user"
		case !p.matchesCluster(c):
			m.Why = "not for this cluster"
		case !p.matchesConditions(ctx):
			m.Why = "conditions (IP range / time) not met"
		default:
			m.Applies, m.Why = true, "applies"
		}
		out = append(out, m)
	}
	return out
}
