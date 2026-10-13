package upgrade

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseRepo(t *testing.T) {
	for in, want := range map[string]string{
		"https://github.com/acme/pg-playbooks":     "github.com acme pg-playbooks",
		"https://github.com/acme/pg-playbooks.git": "github.com acme pg-playbooks",
		"github.com/acme/pg-playbooks/":            "github.com acme pg-playbooks",
		"acme/pg-playbooks":                        "github.com acme pg-playbooks",
		"git@github.com:acme/pg-playbooks.git":     "github.com acme pg-playbooks",
		"https://git.example.in/dba/upgrades":      "git.example.in dba upgrades",
	} {
		h, o, r, err := parseRepo(in)
		if err != nil || h+" "+o+" "+r != want {
			t.Errorf("%s: %s %s %s %v", in, h, o, r, err)
		}
	}
	if _, _, _, err := parseRepo("https://github.com/acme"); err == nil {
		t.Error("a repository needs owner and name")
	}
}

func TestPullRepo(t *testing.T) {
	arch := tgz(t, map[string]string{"acme-pgplay-1a2b3c4/site.yml": "- hosts: all\n", "acme-pgplay-1a2b3c4/roles/x/tasks/main.yml": "[]"})
	var auth, path string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth, path = r.Header.Get("Authorization"), r.URL.Path
		if strings.Contains(r.URL.Path, "missing") {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(arch)
	}))
	defer srv.Close()
	old := githubAPI
	githubAPI = func(string) string { return srv.URL }
	defer func() { githubAPI = old }()

	p, err := pullRepo(context.Background(), "https://github.com/acme/pgplay", "release-1", "tok")
	if err != nil {
		t.Fatal(err)
	}
	if p.commit != "1a2b3c4" || p.url != "https://github.com/acme/pgplay" || p.ref != "release-1" || auth != "Bearer tok" ||
		path != "/repos/acme/pgplay/tarball/release-1" {
		t.Errorf("%+v %s %s", p, auth, path)
	}
	names, err := archiveNames(p.data, p.name)
	if err != nil || !names["site.yml"] || !names["roles/x/tasks/main.yml"] {
		t.Errorf("%v %v", names, err)
	}
	if _, err := pullRepo(context.Background(), "acme/missing", "", ""); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Errorf("%v", err)
	}
	if _, err := pullRepo(context.Background(), "acme/pgplay", "../x", ""); err == nil {
		t.Error("bad ref accepted")
	}
}
