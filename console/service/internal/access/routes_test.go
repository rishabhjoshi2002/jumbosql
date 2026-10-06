package access

import (
	"os"
	"regexp"
	"strings"
	"testing"

	"postgresql-cluster-console/internal/policy"
)

// Every endpoint in swagger.yaml must be covered by the route table (unknown endpoints are refused).
func TestEveryEndpointHasARoute(t *testing.T) {
	raw, err := os.ReadFile("../../api/swagger.yaml")
	if err != nil {
		t.Skip("swagger.yaml not found")
	}
	pathRe := regexp.MustCompile(`^  (/[^:]*):\s*$`)
	methodRe := regexp.MustCompile(`^    (get|post|put|patch|delete):`)
	cur := ""
	n := 0
	for _, line := range strings.Split(string(raw), "\n") {
		if m := pathRe.FindStringSubmatch(line); m != nil {
			cur = m[1]
			continue
		}
		m := methodRe.FindStringSubmatch(line)
		if m == nil || cur == "" {
			continue
		}
		method := strings.ToUpper(m[1])
		path := "/api/v1" + regexp.MustCompile(`\{[^}]+\}`).ReplaceAllStringFunc(cur, func(p string) string {
			if p == "{name}" || p == "{file}" {
				return "x"
			}
			return "7"
		})
		n++
		if cur == "/auth/login" {
			continue // public, handled before the authorizer
		}
		if _, _, ok := Match(method, path); !ok {
			t.Errorf("%s %s has no access route", method, cur)
		}
	}
	if n < 40 {
		t.Fatalf("parsed only %d endpoints", n)
	}
}

func TestMatchScopesAndPermissions(t *testing.T) {
	cases := []struct {
		method, path string
		perm         string
		scope        int
		id           int64
	}{
		{"GET", "/api/v1/clusters/12", policy.ClustersView, scopeCluster, 12},
		{"DELETE", "/api/v1/clusters/12", policy.ClustersManage, scopeCluster, 12},
		{"POST", "/api/v1/servers/5/restart", policy.PatroniManage, scopeServer, 5},
		{"GET", "/api/v1/operations/9/log", policy.ClustersView, scopeOperation, 9},
		{"POST", "/api/v1/clusters/3/sql", policy.SQLRead, scopeCluster, 3},
		{"GET", "/api/v1/clusters/3/logs/postgresql-Mon.log", policy.LogsView, scopeCluster, 3},
		{"GET", "/api/v1/clusters/3/logs", policy.LogsView, scopeCluster, 3},
		{"GET", "/api/v1/users", policy.UsersManage, scopeNone, 0},
		{"PATCH", "/api/v1/policies/4", policy.PoliciesManage, scopeNone, 0},
		{"GET", "/api/v1/policies/permissions", policy.PoliciesManage, scopeNone, 0},
		{"GET", "/api/v1/audit", policy.AuditView, scopeNone, 0},
		{"HEAD", "/api/v1/clusters/", policy.ClustersView, scopeNone, 0},
	}
	for _, c := range cases {
		rt, id, ok := Match(c.method, c.path)
		if !ok {
			t.Errorf("%s %s: no route", c.method, c.path)
			continue
		}
		if rt.Perms[0] != c.perm || rt.Scope != c.scope || id != c.id {
			t.Errorf("%s %s: perms %v scope %d id %d", c.method, c.path, rt.Perms, rt.Scope, id)
		}
	}
	for _, unknown := range [][2]string{{"PUT", "/api/v1/clusters/1"}, {"GET", "/api/v1/nope"}, {"POST", "/api/v1/clusters/1/sqlx"}} {
		if _, _, ok := Match(unknown[0], unknown[1]); ok {
			t.Errorf("%v should be unknown", unknown)
		}
	}
	// SQL runs are audited by the handler (with the statement), not twice
	if rt, _, _ := Match("POST", "/api/v1/clusters/1/sql"); !rt.NoAudit {
		t.Error("sql.run must not be audited by the middleware")
	}
}
