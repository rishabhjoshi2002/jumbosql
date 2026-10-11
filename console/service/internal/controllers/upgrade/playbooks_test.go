package upgrade

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"postgresql-cluster-console/models"
)

func tgz(t *testing.T, files map[string]string) []byte {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for n, c := range files {
		if err := tw.WriteHeader(&tar.Header{Name: n, Mode: 0o644, Size: int64(len(c)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		_, _ = tw.Write([]byte(c))
	}
	_ = tw.Close()
	_ = gz.Close()
	return buf.Bytes()
}

func TestPlaybookFrom(t *testing.T) {
	name := "pgbouncer"
	ok := &models.RequestPlaybook{Name: &name, Playbook: "- hosts: pgbouncer\n  tasks: []\n",
		Variables: []any{map[string]any{"name": "target_version", "type": "text", "required": true},
			map[string]any{"name": "repo_pass", "type": "password", "default": "x"}},
		Groups: []any{map[string]any{"group": "pgbouncer", "from": "pgbouncer"}}}
	pb, _, err := playbookFrom(ok, nil)
	if err != nil {
		t.Fatal(err)
	}
	var vars []Variable
	_ = json.Unmarshal(pb.Variables, &vars)
	if len(vars) != 2 || vars[1].Default != nil {
		t.Errorf("variables %s", pb.Variables)
	}
	bad := []*models.RequestPlaybook{
		{Name: &name},
		{Name: &name, Playbook: "hosts: all"},
		{Name: &name, Playbook: "- hosts: all", Variables: []any{map[string]any{"name": "ansible_user"}}},
		{Name: &name, Playbook: "- hosts: all", Variables: []any{map[string]any{"name": "a-b"}}},
		{Name: &name, Playbook: "- hosts: all", Variables: []any{map[string]any{"name": "x", "type": "select"}}},
		{Name: &name, PlaybookPath: "site.yml"},
		{Name: &name, Playbook: "- hosts: all", Groups: []any{map[string]any{"group": "db"}}},
	}
	for i, b := range bad {
		if _, _, err := playbookFrom(b, nil); err == nil {
			t.Errorf("request %d must be refused", i)
		}
	}
	// archive with one top folder: paths are inside it
	arch := tgz(t, map[string]string{"up/site.yml": "- hosts: all\n", "up/roles/r/tasks/main.yml": "[]", "up/rollback.yml": "- hosts: all\n"})
	withFiles := &models.RequestPlaybook{Name: &name, PlaybookPath: "site.yml", RollbackPath: "./rollback.yml",
		FilesBase64: base64.StdEncoding.EncodeToString(arch), FilesName: "up.tar.gz"}
	pb, _, err = playbookFrom(withFiles, nil)
	if err != nil || pb.RollbackPath != "rollback.yml" {
		t.Fatalf("%v %+v", err, pb)
	}
	dir := t.TempDir()
	if err := extract(pb.Files, pb.FilesName, dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "roles/r/tasks/main.yml")); err != nil {
		t.Error(err)
	}
	evil := tgz(t, map[string]string{"../../etc/x": "no", "a.yml": "- hosts: all\n"})
	if err := extract(evil, "e.tgz", dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "../../etc/x")); err == nil {
		t.Error("a path outside the folder was written")
	}
}

func TestInputValues(t *testing.T) {
	defs := []Variable{{Name: "v", Type: "text", Required: true}, {Name: "n", Type: "number"}, {Name: "b", Type: "boolean"},
		{Name: "s", Type: "select", Options: []string{"a", "b"}, Default: "a"}, {Name: "p", Type: "password"}}
	vals, stored, err := inputValues(defs, map[string]any{"v": "17.6", "n": "5", "b": "true", "p": "secret"})
	if err != nil {
		t.Fatal(err)
	}
	if vals["n"] != int64(5) || vals["b"] != true || vals["s"] != "a" || vals["p"] != "secret" || stored["p"] != secretMask {
		t.Errorf("%v %v", vals, stored)
	}
	if _, _, err := inputValues(defs, map[string]any{}); err == nil {
		t.Error("a required input is missing")
	}
	if _, _, err := inputValues(defs, map[string]any{"v": "x", "s": "z"}); err == nil {
		t.Error("not one of the choices")
	}
}

func TestWithGroups(t *testing.T) {
	inv, _ := inventoryFromDiscovery([]byte(`{"infra": {"hosts": [
		{"address": "10.0.0.31", "components": [{"kind": "postgres"}, {"kind": "pgbouncer"}]},
		{"address": "10.0.0.33", "components": [{"kind": "haproxy"}]}]}}`), true)
	out, err := withGroups(inv, []Group{{"db", "postgres"}, {"everything", "all"}}, func(f string) []string { return []string{"pgm_" + f} })
	if err != nil {
		t.Fatal(err)
	}
	var m struct {
		All struct {
			Children map[string]struct {
				Hosts    map[string]any `json:"hosts"`
				Children map[string]any `json:"children"`
			} `json:"children"`
		} `json:"all"`
	}
	_ = json.Unmarshal(out, &m)
	c := m.All.Children
	if c["db"].Children["pgm_postgres"] == nil || len(c["everything"].Hosts) != 2 || c["pgm_haproxy"].Hosts["10.0.0.33"] == nil {
		t.Errorf("%s", out)
	}
}
