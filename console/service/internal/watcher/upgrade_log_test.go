package watcher

import "testing"

func TestReadUpgradeLog(t *testing.T) {
	st, res := ReadUpgradeLog("testdata/upgrade-2.json")
	if st != "success" || len(res) != 1 {
		t.Fatalf("%s %v", st, res)
	}
	m := res[0].(map[string]any)
	if m["status"] != "success" || m["host"] != "127.0.0.31" {
		t.Errorf("%v", m)
	}
	st, res = ReadUpgradeLog("testdata/upgrade-4.json")
	if st != "failed" || len(res) != 1 || res[0].(map[string]any)["status"] != "failed" {
		t.Errorf("%s %v", st, res)
	}
	if st, _ := ReadUpgradeLog("testdata/none.json"); st != "failed" {
		t.Errorf("missing file: %s", st)
	}
}

func TestReadPlaybookLog(t *testing.T) {
	st, res := ReadPlaybookLog("testdata/playbook-1.json")
	if st != "failed" || len(res) != 2 {
		t.Fatalf("%s %v", st, res)
	}
	a, b := res[0].(map[string]any), res[1].(map[string]any)
	if a["host"] != "10.0.0.31" || a["status"] != "success" || len(a["changed"].([]string)) != 1 || a["error"] != nil {
		t.Errorf("%v", a)
	}
	if b["status"] != "failed" || b["task"] != "Install pgbouncer" {
		t.Errorf("%v", b)
	}
}
