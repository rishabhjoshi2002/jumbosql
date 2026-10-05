package patroni

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

// fakePatroni serves plain HTTP like Patroni without restapi TLS; the client must fall back from HTTPS.
func fakePatroni(t *testing.T, handler http.HandlerFunc) (host string, port int) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	h, p, err := net.SplitHostPort(srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	port, _ = strconv.Atoi(p)
	return h, port
}

func TestSwitchoverSendsLeaderAndCandidate(t *testing.T) {
	var got map[string]string
	var user, pass string
	host, port := fakePatroni(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/switchover" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		user, pass, _ = r.BasicAuth()
		_ = json.NewDecoder(r.Body).Decode(&got)
		_, _ = w.Write([]byte("Successfully switched over to \"pg2\"\n"))
	})

	a := NewActions(ActionsConfig{Port: port, Username: "patroni", Password: "secret", Timeout: 5 * time.Second})
	msg, err := a.Switchover(t.Context(), host, "pg1", "pg2")
	if err != nil {
		t.Fatal(err)
	}
	if got["leader"] != "pg1" || got["candidate"] != "pg2" {
		t.Fatalf("body = %v", got)
	}
	if user != "patroni" || pass != "secret" {
		t.Fatalf("basic auth = %q/%q", user, pass)
	}
	if msg != `Successfully switched over to "pg2"` {
		t.Fatalf("msg = %q", msg)
	}
}

func TestSwitchoverWithoutCandidateOmitsIt(t *testing.T) {
	var got map[string]string
	host, port := fakePatroni(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		_, _ = w.Write([]byte("ok"))
	})
	a := NewActions(ActionsConfig{Port: port, Timeout: 5 * time.Second})
	if _, err := a.Switchover(t.Context(), host, "pg1", ""); err != nil {
		t.Fatal(err)
	}
	if _, ok := got["candidate"]; ok || got["leader"] != "pg1" {
		t.Fatalf("body = %v", got)
	}
}

func TestPatroniRefusalIsReturnedAndNotRetried(t *testing.T) {
	var calls int32
	host, port := fakePatroni(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("candidate name does not match with sync_standby"))
	})
	a := NewActions(ActionsConfig{Port: port, Timeout: 5 * time.Second})
	_, err := a.Restart(t.Context(), host)
	var pErr *PatroniError
	if !errors.As(err, &pErr) || pErr.Status != http.StatusServiceUnavailable {
		t.Fatalf("err = %v", err)
	}
	if n := atomic.LoadInt32(&calls); n != 1 {
		t.Fatalf("Patroni was called %d times, want exactly 1", n)
	}
}

func TestGetClusterTriesNextNode(t *testing.T) {
	host, port := fakePatroni(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"members":[{"name":"pg1","role":"leader","host":"10.0.0.1"},{"name":"pg2","role":"replica","host":"10.0.0.2"}]}`))
	})
	a := NewActions(ActionsConfig{Port: port, Timeout: 2 * time.Second})
	// 192.0.2.1 (TEST-NET-1) never answers; the client must move on to the working node.
	info, err := a.GetCluster(t.Context(), []string{"192.0.2.1", host})
	if err != nil {
		t.Fatal(err)
	}
	if len(info.Members) != 2 || info.Members[0].Role != "leader" {
		t.Fatalf("members = %+v", info.Members)
	}
}
