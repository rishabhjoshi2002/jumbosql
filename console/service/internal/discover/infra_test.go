package discover

import (
	"strings"
	"testing"
)

func TestParseHostsINI(t *testing.T) {
	inv := `
[etcd_cluster]
10.0.0.1
10.0.0.2

[balancers]
lb1 ansible_host=10.0.0.9

[master]
10.0.0.1 hostname=pgnode01 postgresql_exists=false

[replica]
10.0.0.2 hostname=pgnode02

[postgres_cluster:children]
master
replica

[all:vars]
ansible_user=root
`
	hs, err := ParseHosts(inv, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(hs) != 3 {
		t.Fatalf("want 3 hosts, got %d: %+v", len(hs), hs)
	}
	byAddr := map[string]InvHost{}
	for _, h := range hs {
		byAddr[h.Address] = h
	}
	if h := byAddr["10.0.0.1"]; !h.DeclaredDB() || h.Name != "pgnode01" || h.PGPort != 5432 ||
		strings.Join(h.Groups, ",") != "etcd_cluster,master,postgres_cluster" {
		t.Errorf("10.0.0.1: %+v", h)
	}
	if h := byAddr["10.0.0.9"]; h.DeclaredDB() || h.Name != "lb1" {
		t.Errorf("lb1: %+v", h)
	}
}

func TestParseHostsYAML(t *testing.T) {
	inv := `all:
  vars:
    postgresql_port: 5433
  children:
    master:
      hosts:
        db1:
          ansible_host: 192.168.1.10
    replica:
      hosts:
        db2:
          ansible_host: 192.168.1.11
    balancers:
      hosts:
        192.168.1.20:
`
	hs, err := ParseHosts(inv, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(hs) != 3 || hs[0].Address != "192.168.1.20" || hs[1].Address != "192.168.1.10" || hs[1].PGPort != 5433 || hs[1].Name != "db1" {
		t.Fatalf("%+v", hs)
	}
}

func TestParseHostsPlain(t *testing.T) {
	hs, err := ParseHosts("10.1.1.1\n10.1.1.2:5433\n", 0)
	if err != nil || len(hs) != 2 || hs[1].PGPort != 5433 || hs[0].PGPort != 5432 {
		t.Fatalf("%v %+v", err, hs)
	}
}

func TestParseRoutes(t *testing.T) {
	h := &HostInfo{Address: "10.0.0.9", raw: map[string]string{
		"haproxy": `listen stats
    mode http
    bind *:7000
listen master
    bind 10.0.0.9:5000
    mode tcp
    server pgnode01 10.0.0.1:6432 check port 8008
    server pgnode02 10.0.0.2:6432 check port 8008
frontend replicas
    bind *:5001
    default_backend r
backend r
    server pgnode02 10.0.0.2:6432 check`,
		"nginx": `stream {
    upstream pg_primary {
        server 10.0.0.1:5432;
        server 10.0.0.2:5432;
    }
    server {
        listen 5432;
        proxy_pass pg_primary;
    }
}`}}
	rs := parseRoutes(h)
	if len(rs) != 3 {
		t.Fatalf("want 3 routes, got %+v", rs)
	}
	if rs[0].Port != 5000 || len(rs[0].Targets) != 2 || rs[0].Mode != "tcp" {
		t.Errorf("%+v", rs[0])
	}
	if rs[1].Port != 5001 || rs[1].Targets[0] != "10.0.0.2:6432" {
		t.Errorf("%+v", rs[1])
	}
	if rs[2].Kind != "nginx" || rs[2].Port != 5432 || len(rs[2].Targets) != 2 {
		t.Errorf("%+v", rs[2])
	}
}

func TestTune(t *testing.T) {
	n := newNode("10.0.0.1", 5432)
	n.Reachable, n.Role, n.MaxConnections = true, "primary", 100
	for _, s := range []Setting{{"shared_buffers", "16384", "8kB"}, {"work_mem", "4096", "kB"}, {"random_page_cost", "4", ""},
		{"max_worker_processes", "8", ""}, {"wal_compression", "off", ""}} {
		n.Settings = append(n.Settings, s)
		n.settingsByName[s.Name] = s.Value
	}
	tu := tune(n, Size{CPUs: 4, MemBytes: 16 * gib})
	got := map[string]string{}
	for _, c := range tu.Changes {
		got[c.Name] = c.Current + " -> " + c.Recommended
	}
	if got["shared_buffers"] != "128MB -> 4GB" || got["random_page_cost"] != "4 -> 1.1" || got["wal_compression"] != "off -> on" {
		t.Errorf("%v", got)
	}
	if _, ok := got["max_worker_processes"]; ok {
		t.Errorf("8 workers for 4 CPUs is fine: %v", got)
	}
	if !strings.Contains(tu.Script, "ALTER SYSTEM SET shared_buffers = '4GB';") {
		t.Errorf("%s", tu.Script)
	}
}

func TestPkgMatches(t *testing.T) {
	for name, kind := range map[string]string{"haproxy": "haproxy", "haproxy28": "haproxy", "postgresql17-server": "postgres",
		"postgresql-17": "postgres", "etcd": "etcd", "prometheus-node-exporter": "node_exporter", "pgbouncer": "pgbouncer"} {
		found := ""
		if d := matchPkg(name); d != nil {
			found = d.kind
		}
		if found != kind {
			t.Errorf("%s: want %s, got %s", name, kind, found)
		}
	}
	for _, name := range []string{"postgresql17-libs", "postgresql-client-17", "libpq5"} {
		for _, d := range catalog {
			if pkgMatches(name, d) {
				t.Errorf("%s should not match %s", name, d.kind)
			}
		}
	}
}

func TestParseProbe(t *testing.T) {
	out := "@@host\nhostname=lb1.example\nos=Rocky Linux 9.4 (Blue Onyx)\ncpus=2\nmem_kb=4000000\nswap_kb=0\nsudo=yes\n" +
		"@@disk\n/dev/vda1 xfs 21474836480 5368709120 16106127360 25% /\n" +
		"@@listen\nLISTEN 0 4096 10.0.0.100:5000 0.0.0.0:* users:((\"haproxy\",pid=812,fd=7))\n" +
		"LISTEN 0 4096 0.0.0.0:7000 0.0.0.0:* users:((\"haproxy\",pid=812,fd=5))\n" +
		"@@services\nhaproxy.service\nkeepalived.service\n" +
		"@@packages\nhaproxy\t2.8.3-1.el9\nkeepalived\t2.2.8-3.el9\n" +
		"@@versions\nhaproxy\t/usr/sbin/haproxy\tHAProxy version 2.8.3-86e043a 2023/09/07\n" +
		"@@keepalived\nvrrp_instance VI_1 {\n  state BACKUP\n  interface eth0\n  virtual_ipaddress {\n    10.0.0.100/24\n  }\n}\n" +
		"@@end\n"
	h := &HostInfo{Address: "10.0.0.9", raw: map[string]string{}, Components: []*Component{}}
	parseProbe(h, out)
	finish(h)
	if h.Name != "lb1.example" || h.CPUs != 2 || len(h.Disks) != 1 || len(h.VIPs) != 1 || h.VIPs[0] != "10.0.0.100" {
		t.Fatalf("%+v", h)
	}
	hp := h.comp("haproxy")
	if hp.Version != "2.8.3" || hp.Package != "haproxy 2.8.3-1.el9" || !hp.Running || len(hp.Ports) != 2 {
		t.Errorf("haproxy: %+v", hp)
	}
	if k := h.comp("keepalived"); k.Details["state"] != "BACKUP" || !k.Running {
		t.Errorf("keepalived: %+v", k)
	}
	if strings.Join(h.Roles, ",") != "entry,balancer" {
		t.Errorf("roles %v", h.Roles)
	}
}
