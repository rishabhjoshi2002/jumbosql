package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAuthorizationRoles(t *testing.T) {
	sessions := func(_ context.Context, token string) *Principal {
		switch token {
		case "js_admin":
			return &Principal{UserID: 1, Username: "admin", Role: "admin"}
		case "js_op":
			return &Principal{UserID: 2, Username: "op", Role: "operator"}
		case "js_view":
			return &Principal{UserID: 3, Username: "view", Role: "viewer"}
		}
		return nil
	}
	var seen *Principal
	h := Authorization("static-token", sessions, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = PrincipalFrom(r.Context())
		w.WriteHeader(http.StatusOK)
	}))

	cases := []struct {
		name, method, path, token string
		want                      int
	}{
		{"login is public", "POST", "/api/v1/auth/login", "", 200},
		{"no token", "GET", "/api/v1/clusters", "", 401},
		{"bad token", "GET", "/api/v1/clusters", "js_nope", 401},
		{"static API token still works", "POST", "/api/v1/clusters", "static-token", 200},
		{"viewer reads", "GET", "/api/v1/clusters/1", "js_view", 200},
		{"viewer can't change", "POST", "/api/v1/clusters/1/switchover", "js_view", 403},
		{"viewer reaches patroni read commands (handler checks the command)", "POST", "/api/v1/clusters/1/patroni", "js_view", 200},
		{"viewer can't delete a cluster", "DELETE", "/api/v1/clusters/1", "js_view", 403},
		{"viewer can refresh a cluster's status", "POST", "/api/v1/clusters/1/refresh", "js_view", 200},
		{"viewer can't restart a server", "POST", "/api/v1/servers/1/restart", "js_view", 403},
		{"viewer can sign out", "POST", "/api/v1/auth/logout", "js_view", 200},
		{"operator runs patroni", "POST", "/api/v1/clusters/1/patroni", "js_op", 200},
		{"operator can't manage users", "GET", "/api/v1/users", "js_op", 403},
		{"admin manages users", "POST", "/api/v1/users", "js_admin", 200},
		{"SQL editor cookie check", "GET", "/api/v1/version", "js_view", 200},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest(c.method, c.path, nil)
			if c.token != "" {
				req.Header.Set("Authorization", "Bearer "+c.token)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != c.want {
				t.Fatalf("status %d, want %d (%s)", rec.Code, c.want, rec.Body.String())
			}
		})
	}

	// the handler sees who is calling
	req := httptest.NewRequest("GET", "/api/v1/clusters", nil)
	req.Header.Set("Authorization", "Bearer js_op")
	h.ServeHTTP(httptest.NewRecorder(), req)
	if seen == nil || seen.Username != "op" {
		t.Fatalf("principal = %+v", seen)
	}
}

func TestUnauthorizedResponseDoesNotEchoToken(t *testing.T) {
	h := Authorization("static-token", nil, http.NotFoundHandler())
	req := httptest.NewRequest("GET", "/api/v1/clusters", nil)
	req.Header.Set("Authorization", "Bearer super-secret-guess")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 401 {
		t.Fatalf("status %d", rec.Code)
	}
	if body := rec.Body.String(); strings.Contains(body, "super-secret-guess") {
		t.Fatalf("token echoed back: %s", body)
	}
}
