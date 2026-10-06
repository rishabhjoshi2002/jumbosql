package access

import (
	"net/http"
	"strings"

	"postgresql-cluster-console/internal/policy"
	localmid "postgresql-cluster-console/middleware"
)

// Authorize implements middleware.Authorizer: route -> permission(s) -> policy decision, with auditing.
func (s *Service) Authorize(r *http.Request, p *localmid.Principal) (bool, int, string, func(int)) {
	ctx := r.Context()
	rt, id, known := Match(r.Method, r.URL.Path)
	sub := Subject(p)
	if !known {
		if sub.System {
			return true, 0, "", nil
		}
		s.Audit(ctx, AuditEventFor(r, p, "access.denied", "denied", http.StatusForbidden, 0,
			map[string]any{"reason": "endpoint not covered by access policies"}))
		return false, http.StatusForbidden, "this endpoint is not available to your account", nil
	}

	clusterID := int64(0)
	switch rt.Scope {
	case scopeCluster:
		clusterID = id
	case scopeServer:
		clusterID, _ = s.db.ClusterIDOfServer(ctx, id)
	case scopeOperation:
		clusterID, _ = s.db.ClusterIDOfOperation(ctx, id)
	}
	if rt.Scope != scopeNone && clusterID == 0 && !sub.System {
		return false, http.StatusNotFound, "not found", nil
	}

	pctx := RequestContext(r)
	if len(rt.Perms) > 0 && !sub.System {
		var last policy.Decision
		allowed := false
		for _, perm := range rt.Perms {
			last = s.Can(ctx, sub, perm, clusterID, pctx)
			if last.Allowed {
				allowed = true
				break
			}
		}
		if !allowed {
			s.Audit(ctx, AuditEventFor(r, p, "access.denied", "denied", http.StatusForbidden, clusterID,
				map[string]any{"action": rt.Action, "needs": strings.Join(rt.Perms, " or "), "reason": last.Reason}))
			msg := "you need " + strings.Join(rt.Perms, " or ")
			if clusterID > 0 {
				msg += " on this cluster"
			}
			return false, http.StatusForbidden, msg + " (" + last.Reason + ")", nil
		}
	}

	if rt.NoAudit || (r.Method == http.MethodGet && !rt.Audit) {
		return true, 0, "", nil
	}
	// a live log tail asks every few seconds for what was written since the last read: the first read of the
	// file is in the audit log, the follow-up polls are not (they would bury everything else)
	if rt.Action == "logs.read" && r.URL.Query().Has("since") {
		return true, 0, "", nil
	}
	return true, 0, "", func(status int) {
		outcome := "ok"
		if status >= 400 {
			outcome = "error"
		}
		s.Audit(ctx, AuditEventFor(r, p, rt.Action, outcome, status, clusterID, nil))
	}
}

// Allows checks one permission for the request's principal (for handlers that decide on the request body,
// e.g. which Patroni command). clusterID 0 = not cluster-specific.
func (s *Service) Allows(r *http.Request, perm string, clusterID int64) policy.Decision {
	return s.Can(r.Context(), Subject(localmid.PrincipalFrom(r.Context())), perm, clusterID, RequestContext(r))
}
