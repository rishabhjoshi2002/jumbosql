package access

import (
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"postgresql-cluster-console/internal/policy"
)

// What a request is about.
const (
	scopeNone      = iota // not cluster-scoped, or "on any cluster"
	scopeCluster          // /clusters/{id}/...
	scopeServer           // /servers/{id}/... -> its cluster
	scopeOperation        // /operations/{id}/... -> its cluster
)

// Route maps an API endpoint to the permission(s) it needs. Perms are alternatives (any one is enough);
// an empty list means "any signed-in user".
type Route struct {
	Method  string
	Pattern *regexp.Regexp
	Perms   []string
	Scope   int
	Action  string // audit action name
	NoAudit bool   // the handler writes a richer audit event itself
	Audit   bool   // audit even though it's a GET (sensitive reads)
}

const base = "/api/v1"

func r(method, pattern string, scope int, action string, perms ...string) Route {
	return Route{Method: method, Pattern: regexp.MustCompile("^" + base + pattern + "$"), Perms: perms, Scope: scope, Action: action}
}

var routes = []Route{
	r("GET", `/version`, scopeNone, "version"),
	r("POST", `/auth/(logout|password)`, scopeNone, "auth"),
	r("GET", `/auth/me`, scopeNone, "auth.me"),

	r("GET", `/(external/deployments|database/extensions|postgres_versions|clusters/default_name|environments|projects)`, scopeNone, "catalog.read", policy.ClustersView),
	r("POST", `/environments`, scopeNone, "environments.create", policy.SettingsManage),
	r("DELETE", `/environments/\d+`, scopeNone, "environments.delete", policy.SettingsManage),
	r("POST", `/projects`, scopeNone, "projects.create", policy.SettingsManage),
	r("PATCH", `/projects/\d+`, scopeNone, "projects.update", policy.SettingsManage),
	r("DELETE", `/projects/\d+`, scopeNone, "projects.delete", policy.SettingsManage),
	r("GET", `/secrets`, scopeNone, "secrets.list", policy.SettingsManage, policy.ClustersManage),
	r("POST", `/secrets`, scopeNone, "secrets.create", policy.SettingsManage, policy.ClustersManage),
	r("PATCH", `/secrets/\d+`, scopeNone, "secrets.update", policy.SettingsManage),
	r("DELETE", `/secrets/\d+`, scopeNone, "secrets.delete", policy.SettingsManage),
	r("GET", `/settings`, scopeNone, "settings.read", policy.ClustersView),
	r("POST", `/settings`, scopeNone, "settings.create", policy.SettingsManage, policy.ObservabilityManage),
	r("PATCH", `/settings/[^/]+`, scopeNone, "settings.update", policy.SettingsManage, policy.ObservabilityManage),

	r("GET", `/clusters`, scopeNone, "clusters.list", policy.ClustersView),
	r("POST", `/clusters`, scopeNone, "clusters.create", policy.ClustersManage),
	r("GET", `/clusters/(\d+)`, scopeCluster, "clusters.read", policy.ClustersView),
	r("DELETE", `/clusters/(\d+)`, scopeCluster, "clusters.delete", policy.ClustersManage),
	r("DELETE", `/servers/(\d+)`, scopeServer, "servers.delete", policy.ClustersManage),
	r("POST", `/clusters/(\d+)/refresh`, scopeCluster, "clusters.refresh", policy.ClustersView),
	r("POST", `/clusters/(\d+)/switchover`, scopeCluster, "patroni.switchover", policy.PatroniManage),
	r("POST", `/servers/(\d+)/restart`, scopeServer, "patroni.restart", policy.PatroniManage),
	r("POST", `/servers/(\d+)/reinitialize`, scopeServer, "patroni.reinit", policy.PatroniManage),
	r("POST", `/clusters/(\d+)/patroni`, scopeCluster, "patroni.command", policy.PatroniRead),
	r("GET", `/clusters/(\d+)/sql/access`, scopeCluster, "sql.access", policy.ClustersView),
	{Method: "POST", Pattern: regexp.MustCompile("^" + base + `/clusters/(\d+)/sql$`), Scope: scopeCluster, Action: "sql.run",
		Perms: []string{policy.SQLRead, policy.SQLWrite, policy.SQLAdmin}, NoAudit: true},
	r("POST", `/clusters/(\d+)/sql/cancel`, scopeCluster, "sql.cancel", policy.SQLRead, policy.SQLWrite, policy.SQLAdmin),
	{Method: "GET", Pattern: regexp.MustCompile("^" + base + `/clusters/(\d+)/monitoring$`), Scope: scopeCluster, Action: "monitoring.read",
		Perms: []string{policy.ClustersView}},
	{Method: "GET", Pattern: regexp.MustCompile("^" + base + `/clusters/(\d+)/insights$`), Scope: scopeCluster, Action: "insights.read",
		Perms: []string{policy.InsightsView}},
	{Method: "GET", Pattern: regexp.MustCompile("^" + base + `/clusters/(\d+)/logs(/[^/]+)?$`), Scope: scopeCluster, Action: "logs.read",
		Perms: []string{policy.LogsView}, Audit: true},

	r("GET", `/operations`, scopeNone, "operations.list", policy.ClustersView),
	r("GET", `/operations/(\d+)/log`, scopeOperation, "operations.log", policy.ClustersView),

	r("GET", `/users`, scopeNone, "users.list", policy.UsersManage),
	r("POST", `/users`, scopeNone, "users.create", policy.UsersManage),
	r("PATCH", `/users/\d+`, scopeNone, "users.update", policy.UsersManage),
	r("DELETE", `/users/\d+`, scopeNone, "users.delete", policy.UsersManage),

	r("GET", `/policies(/permissions)?`, scopeNone, "policies.list", policy.PoliciesManage),
	r("POST", `/policies`, scopeNone, "policies.create", policy.PoliciesManage),
	r("POST", `/policies/simulate`, scopeNone, "policies.simulate", policy.PoliciesManage),
	r("PATCH", `/policies/\d+`, scopeNone, "policies.update", policy.PoliciesManage),
	r("DELETE", `/policies/\d+`, scopeNone, "policies.delete", policy.PoliciesManage),

	r("GET", `/audit`, scopeNone, "audit.read", policy.AuditView),
}

// Match finds the route of a request and the id in its path (0 if none). ok=false: unknown endpoint (denied).
func Match(method, path string) (Route, int64, bool) {
	path = strings.TrimSuffix(path, "/")
	if method == http.MethodHead {
		method = http.MethodGet
	}
	for _, rt := range routes {
		if rt.Method != method {
			continue
		}
		m := rt.Pattern.FindStringSubmatch(path)
		if m == nil {
			continue
		}
		var id int64
		if rt.Scope != scopeNone && len(m) > 1 {
			id, _ = strconv.ParseInt(m[1], 10, 64)
		}
		return rt, id, true
	}
	return Route{}, 0, false
}
