package discover

import "testing"

func TestParseInventory(t *testing.T) {
	got, err := ParseInventory("# demo\n10.0.0.1\n10.0.0.2:5433\ndb3 6432\n[::1]:5432, \n10.0.0.1:5432 # again\n")
	if err != nil {
		t.Fatal(err)
	}
	want := []Target{{"10.0.0.1", 5432}, {"10.0.0.2", 5433}, {"db3", 6432}, {"::1", 5432}}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%d: got %v want %v", i, got[i], want[i])
		}
	}
	for _, bad := range []string{"", "# nothing", "h:99999", "h x", "a'b"} {
		if _, err := ParseInventory(bad); err == nil {
			t.Fatalf("%q should fail", bad)
		}
	}
}

func TestConninfo(t *testing.T) {
	ci := "user=replicator password='se cr\\'et' channel_binding=prefer host=10.0.0.5 port=5433 dbname=shop application_name='pg standby'"
	h, p, ok := conninfoHost(ci)
	if !ok || h != "10.0.0.5" || p != 5433 || conninfoDB(ci) != "shop" {
		t.Fatalf("got %s %d %v", h, p, ok)
	}
	if m := maskConninfo(ci); m != "application_name=pg standby dbname=shop host=10.0.0.5 password=******** port=5433 user=replicator" {
		t.Fatalf("masked: %s", m)
	}
	if h, p, ok := conninfoHost("postgresql://rep@db1.example:6000/app"); !ok || h != "db1.example" || p != 6000 {
		t.Fatalf("uri: %s %d", h, p)
	}
	if _, _, ok := conninfoHost("host=/var/run/postgresql"); ok {
		t.Fatal("a socket directory is not a host")
	}
	if h, p, _ := conninfoHost("host=a,b port=5432,5433"); h != "a" || p != 0 && p != 5432 {
		t.Fatalf("multi-host: %s %d", h, p)
	}
}
