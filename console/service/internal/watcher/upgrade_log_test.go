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
