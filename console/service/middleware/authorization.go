package middleware

import (
	"context"
	"encoding/json"
	"net/http"
	"postgresql-cluster-console/models"
	"regexp"
	"strings"
)

// JumboSQL: requests are accepted with either the static API token (PG_CONSOLE_AUTHORIZATION_TOKEN, for
// scripts and automation) or a session token from POST /auth/login. The SQL editor's cookie is checked
// through the same path (nginx auth_request -> /version), so it works with both as well.

// Principal - who is calling.
type Principal struct {
	UserID   int64 // 0 for the static API token
	Username string
	Role     string // admin | operator | viewer
}

type principalKey struct{}

// PrincipalFrom returns the authenticated caller of a request, or nil.
func PrincipalFrom(ctx context.Context) *Principal {
	p, _ := ctx.Value(principalKey{}).(*Principal)
	return p
}

// SessionLookup resolves a session token to a principal (nil = not a valid session).
type SessionLookup func(ctx context.Context, token string) *Principal

const apiBasePath = "/api/v1"

var (
	patroniCommandPath = regexp.MustCompile(`^` + apiBasePath + `/clusters/\d+/patroni$`)
	// refreshing re-reads Patroni's status; it changes nothing, so viewers may do it
	clusterRefreshPath = regexp.MustCompile(`^` + apiBasePath + `/clusters/\d+/refresh$`)
)

// Paths reachable without signing in.
var publicPaths = map[string]bool{
	apiBasePath + "/auth/login": true,
}

func writeError(w http.ResponseWriter, status int, title, description string) {
	w.Header().Add("content-type", "application/json")
	w.WriteHeader(status)
	resp, _ := json.Marshal(&models.ResponseError{Code: int64(status), Title: title, Description: description})
	_, _ = w.Write(resp)
}

// allowed applies the role rules: viewers are read-only, user management is for admins.
func allowed(p *Principal, r *http.Request) bool {
	path := strings.TrimSuffix(r.URL.Path, "/")
	if strings.HasPrefix(path, apiBasePath+"/auth/") {
		return true // logout, me, own password
	}
	if path == apiBasePath+"/users" || strings.HasPrefix(path, apiBasePath+"/users/") {
		return p.Role == "admin"
	}
	// Patroni console: read commands (list, history, show-config) are POSTs too; the handler refuses
	// changing commands for viewers, so the request is let through here.
	if p.Role == "viewer" && r.Method == http.MethodPost && (patroniCommandPath.MatchString(path) || clusterRefreshPath.MatchString(path)) {
		return true
	}
	if p.Role == "viewer" && r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	return true
}

func Authorization(token string, sessions SessionLookup, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if publicPaths[strings.TrimSuffix(r.URL.Path, "/")] {
			next.ServeHTTP(w, r)
			return
		}

		parts := strings.SplitN(r.Header.Get("Authorization"), " ", 2)
		var p *Principal
		if len(parts) == 2 && parts[0] == "Bearer" && parts[1] != "" {
			switch {
			case token != "" && parts[1] == token:
				p = &Principal{Username: "api-token", Role: "admin"}
			case sessions != nil:
				p = sessions(r.Context(), parts[1])
			}
		}
		if p == nil {
			writeError(w, http.StatusUnauthorized, "Invalid token", "sign in again")
			return
		}
		if !allowed(p, r) {
			writeError(w, http.StatusForbidden, "Forbidden", "your role ("+p.Role+") can't do this")
			return
		}

		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), principalKey{}, p)))
	})
}
