package upgrade

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

// the helper sent over SSH must be the same as the one the runner image uses
func TestBackupHelperInSync(t *testing.T) {
	b, err := os.ReadFile("../../../../../automation-ha/upgrade/pgm_backup.py")
	if err != nil {
		t.Skip("automation-ha not next to the console:", err)
	}
	if string(b) != backupHelper {
		t.Fatal("assets/pgm_backup.py differs from automation-ha/upgrade/pgm_backup.py: copy it again")
	}
}

func TestInventoryNodes(t *testing.T) {
	inv := `"{\"all\":{\"vars\":{\"ansible_user\":\"admin\"},\"children\":{\"master\":{\"hosts\":{\"10.0.0.1\":{\"hostname\":\"pg1\"}}},` +
		`\"replica\":{\"hosts\":{\"pg2\":{\"ansible_host\":\"10.0.0.2\"}}},\"etcd_cluster\":{\"hosts\":{\"10.0.0.9\":{}}}}}}"`
	n := inventoryNodes([]byte(inv), backupGroups)
	if len(n) != 2 || n[0].Address != "10.0.0.1" || n[1].Name != "pg2" || n[1].Address != "10.0.0.2" {
		t.Fatalf("nodes: %+v", n)
	}
	if u := inventoryUser([]byte(inv)); u != "admin" {
		t.Fatalf("user %q", u)
	}
}

func TestSummarize(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	stop := float64(now.Add(-2 * time.Hour).Unix())
	primary := map[string]any{"ok": true, "installed": true, "stanza": "main",
		"config": "[global]\nrepo1-path=/r\nrepo1-retention-full=2\n[main]\npg1-path=/d1\n",
		"pg":     map[string]any{"role": "primary", "archive_mode": "on", "archive_command": "pgbackrest --stanza=main archive-push %p", "last_archived_time": now.Add(-time.Minute).UTC().Format("2006-01-02 15:04:05.999999-07")},
		"cron":   []any{"0 1 * * 0 postgres pgbackrest backup --type=full"},
		"info": []any{map[string]any{"name": "main", "status": map[string]any{"code": 0.0, "message": "ok"},
			"backup": []any{map[string]any{"label": "20270115-000000F", "type": "full", "timestamp": map[string]any{"start": stop - 60, "stop": stop},
				"info": map[string]any{"size": 100.0, "delta": 100.0, "repository": map[string]any{"size": 10.0, "delta": 10.0}}}}}},
		"usable_sets": []any{"20270115-000000F"}}
	replica := map[string]any{"ok": true, "installed": true, "stanza": "main",
		"config": "[global]\nrepo1-path=/r\nrepo1-retention-full=3\n[main]\npg1-path=/d2\n",
		"pg":     map[string]any{"role": "replica"}}
	out := summarize([]BackupNodeStatus{{Name: "a", Address: "10.0.0.1", OK: true, Raw: primary},
		{Name: "b", Address: "10.0.0.2", OK: true, Raw: replica}}, now)
	if out["primary"] != "10.0.0.1" || out["stanza"] != "main" {
		t.Fatalf("primary/stanza: %v %v", out["primary"], out["stanza"])
	}
	w := out["window"].(map[string]any)
	if s := w["span_s"].(float64); s < 7000 || s > 7200 {
		t.Fatalf("window span %v", s)
	}
	if d := w["data_loss_s"].(float64); d < 59 || d > 61 {
		t.Fatalf("data loss %v", d)
	}
	diffs := out["config_diff"]
	ds := strings.ToLower(strings.Join(strings.Fields(sprint(diffs)), " "))
	if !strings.Contains(ds, "repo1-retention-full") || strings.Contains(ds, "pg1-path") {
		t.Fatalf("config diff should list retention only (pg1-path is per node): %s", ds)
	}
}

func sprint(v any) string { b, _ := json.Marshal(v); return string(b) }

// a repository with no stanza yet: the page offers Create Stanza
func TestSummarizeNoStanza(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	repo := map[string]any{"ok": true, "installed": true, "stanza": "", "repo_host": true, "config": "[global]\nrepo1-path=/r\n",
		"config_files": []any{map[string]any{"path": "/etc/pgbackrest/pgbackrest.conf", "content": "[global]\nrepo1-path=/r\n"},
			map[string]any{"path": "/etc/pgbackrest/conf.d/jumbo.conf", "content": "[jumbo]\npg1-host=10.0.0.1\npg1-path=/d\n"}},
		"info": []any{}}
	db := map[string]any{"ok": true, "installed": true, "stanza": "jumbo", "pg": map[string]any{"role": "primary", "archive_mode": "on",
		"archive_command": "pgbackrest --stanza=jumbo archive-push %p", "archive_timeout": "60"},
		"cron": []any{map[string]any{"file": "systemd jumbosql-backup-full.timer", "line": "Sun 01:00 full", "ours": false}}}
	out := summarize([]BackupNodeStatus{{Name: "r", Address: "10.0.0.9", OK: true, Raw: repo},
		{Name: "a", Address: "10.0.0.1", OK: true, Raw: db}}, now)
	if out["runner"] != "10.0.0.9" || out["stanza"] != "jumbo" || out["can_create_stanza"] != true {
		t.Fatalf("runner %v stanza %v create %v", out["runner"], out["stanza"], out["can_create_stanza"])
	}
	is := sprint(out["issues"])
	if !strings.Contains(is, "Create Stanza") || strings.Contains(is, "no backup schedule") {
		t.Fatalf("issues: %s", is)
	}
	// a repository server and a database node have different configs on purpose: not compared
	if d := sprint(out["config_diff"]); d != "[]" {
		t.Fatalf("diff between different kinds: %s", d)
	}
}
