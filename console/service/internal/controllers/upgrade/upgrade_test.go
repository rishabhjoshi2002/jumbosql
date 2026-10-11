package upgrade

import (
	"encoding/json"
	"testing"
)

func TestInventoryFromDiscovery(t *testing.T) {
	res := []byte(`{"infra": {"hosts": [
		{"address": "10.0.0.24", "name": "pg1", "components": [{"kind": "postgres"}, {"kind": "patroni"}, {"kind": "docker"}]},
		{"address": "10.0.0.27", "name": "lb", "components": [{"kind": "haproxy"}, {"kind": "vip-manager"}]},
		{"address": "10.0.0.20", "components": [{"kind": "etcd"}]}]}}`)
	b, err := InventoryFromDiscovery(res)
	if err != nil {
		t.Fatal(err)
	}
	var inv struct {
		All struct {
			Children map[string]struct {
				Hosts map[string]map[string]string `json:"hosts"`
			} `json:"children"`
		} `json:"all"`
	}
	if err := json.Unmarshal(b, &inv); err != nil {
		t.Fatal(err)
	}
	c := inv.All.Children
	if len(c) != 5 || c["pgm_postgres"].Hosts["10.0.0.24"]["hostname"] != "pg1" || c["pgm_vip_manager"].Hosts["10.0.0.27"] == nil ||
		c["pgm_etcd"].Hosts["10.0.0.20"] == nil || c["pgm_docker"].Hosts != nil {
		t.Errorf("%s", b)
	}
	if _, err := InventoryFromDiscovery([]byte(`{"nodes": []}`)); err == nil {
		t.Error("a discovery without machines must be refused")
	}
}
