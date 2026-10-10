package middleware

import (
	"context"
	"encoding/json"
	"net/http"
	"postgresql-cluster-console/models"
	"strings"
)

// pg_genie: requests are accepted with either the static API token (PG_CONSOLE_AUTHORIZATION_TOKEN, for
// scripts and automation; it may do everything) or a session token from POST /auth/login. What a signed-in
// user may do is decided by the access policies (internal/access, internal/policy) through the Authorizer.

// Principal - who is calling.
type Principal struct {
	UserID     int64 // 0 for the static API token
	Username   string
	Role       string            // legacy; the "group" attribute replaces it
	Attributes map[string]string // ABAC user attributes (group, team, ...)
	System     bool              // the static API token
}

type principalKey struct{}

// PrincipalFrom returns the authenticated caller of a request, or nil.
func PrincipalFrom(ctx context.Context) *Principal {
	p, _ := ctx.Value(principalKey{}).(*Principal)
	return p
}

// WithPrincipal - for tests and internal calls.
func WithPrincipal(ctx context.Context, p *Principal) context.Context {
	return context.WithValue(ctx, principalKey{}, p)
}

// SessionLookup resolves a session token to a principal (nil = not a valid session).
type SessionLookup func(ctx context.Context, token string) *Principal

// Authorizer decides a request. When ok is false the request is refused with status and reason (the authorizer
// records the denial). When ok is true, done (if not nil) is called with the response status after the handler.
type Authorizer interface {
	Authorize(r *http.Request, p *Principal) (ok bool, status int, reason string, done func(status int))
}

const apiBasePath = "/api/v1"

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

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	return s.ResponseWriter.Write(b)
}

func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Authorization authenticates the caller and asks the Authorizer (nil = allow every signed-in caller).
func Authorization(token string, sessions SessionLookup, authz Authorizer, next http.Handler) http.Handler {
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
				p = &Principal{Username: "api-token", Role: "admin", System: true}
			case sessions != nil:
				p = sessions(r.Context(), parts[1])
			}
		}
		if p == nil {
			writeError(w, http.StatusUnauthorized, "Invalid token", "sign in again")
			return
		}
		r = r.WithContext(WithPrincipal(r.Context(), p))

		var done func(int)
		if authz != nil {
			ok, status, reason, after := authz.Authorize(r, p)
			if !ok {
				if status == 0 {
					status = http.StatusForbidden
				}
				writeError(w, status, http.StatusText(status), reason)
				return
			}
			done = after
		}
		if done == nil {
			next.ServeHTTP(w, r)
			return
		}
		rec := &statusRecorder{ResponseWriter: w}
		next.ServeHTTP(rec, r)
		if rec.status == 0 {
			rec.status = http.StatusOK
		}
		done(rec.status)
	})
}
