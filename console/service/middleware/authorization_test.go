package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// fakeAuthz allows GETs, refuses DELETEs, and records what happened after the handler.
type fakeAuthz struct{ after []int }

func (f *fakeAuthz) Authorize(r *http.Request, p *Principal) (bool, int, string, func(int)) {
	if r.Method == http.MethodDelete {
		return false, http.StatusForbidden, "no", nil
	}
	return true, 0, "", func(status int) { f.after = append(f.after, status) }
}

func TestAuthorization(t *testing.T) {
	sessions := func(_ context.Context, token string) *Principal {
		if token == "js_alice" {
			return &Principal{UserID: 1, Username: "alice", Attributes: map[string]string{"group": "operator"}}
		}
		return nil
	}
	var seen *Principal
	authz := &fakeAuthz{}
	h := Authorization("static-token", sessions, authz, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = PrincipalFrom(r.Context())
		w.WriteHeader(http.StatusTeapot)
	}))

	cases := []struct {
		name, method, path, token string
		want                      int
	}{
		{"login is public", "POST", "/api/v1/auth/login", "", http.StatusTeapot},
		{"no token", "GET", "/api/v1/clusters", "", 401},
		{"bad token", "GET", "/api/v1/clusters", "js_nope", 401},
		{"session user, allowed", "GET", "/api/v1/clusters", "js_alice", http.StatusTeapot},
		{"session user, refused by the authorizer", "DELETE", "/api/v1/clusters/1", "js_alice", 403},
		{"API token goes through the authorizer too", "GET", "/api/v1/clusters", "static-token", http.StatusTeapot},
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
	if seen == nil || !seen.System || seen.Username != "api-token" {
		t.Fatalf("API token principal: %+v", seen)
	}
	if len(authz.after) == 0 || authz.after[len(authz.after)-1] != http.StatusTeapot {
		t.Fatalf("done callback must get the handler's status: %v", authz.after)
	}
}
