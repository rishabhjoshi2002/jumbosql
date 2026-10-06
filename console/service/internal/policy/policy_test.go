package policy

import (
	"net"
	"strings"
	"testing"
	"time"
)

var (
	alice   = Subject{UserID: 1, Username: "alice", Attributes: map[string]string{"group": "operator", "team": "payments"}}
	bob     = Subject{UserID: 2, Username: "bob", Attributes: map[string]string{"group": "viewer", "team": "analytics"}}
	carol   = Subject{UserID: 3, Username: "carol", Attributes: map[string]string{"group": "admin"}}
	nobody  = Subject{UserID: 4, Username: "nobody"}
	prod    = &Cluster{ID: 1, Name: "pay-prod", Environment: "production", Project: "default"}
	staging = &Cluster{ID: 2, Name: "pay-stg", Environment: "staging", Project: "default"}
	officeT = Context{IP: net.ParseIP("10.1.2.3"), Now: time.Date(2026, 10, 6, 10, 0, 0, 0, time.UTC)} // Tuesday 10:00
)

func builtins() []Policy {
	return []Policy{
		{Name: "Administrators", Effect: "allow", Enabled: true, Subjects: Subjects{Attributes: map[string][]string{"group": {"admin"}}},
			Permissions: []string{ClustersView, ClustersManage, PatroniManage, PatroniRead, SQLRead, SQLWrite, SQLAdmin, SQLStats, UsersManage, PoliciesManage, AuditView}},
		{Name: "Operators", Effect: "allow", Enabled: true, Subjects: Subjects{Attributes: map[string][]string{"group": {"operator"}}},
			Permissions: []string{ClustersView, ClustersManage, PatroniRead, PatroniManage, SQLRead, SQLWrite, LogsView}},
		{Name: "Viewers", Effect: "allow", Enabled: true, Subjects: Subjects{Attributes: map[string][]string{"group": {"viewer"}}},
			Permissions: []string{ClustersView, PatroniRead, SQLRead}},
	}
}

func TestBuiltinsBehaveLikeTheOldRoles(t *testing.T) {
	set := &Set{Policies: builtins()}
	cases := []struct {
		s    Subject
		perm string
		want bool
	}{
		{carol, UsersManage, true}, {carol, SQLAdmin, true},
		{alice, PatroniManage, true}, {alice, UsersManage, false}, {alice, SQLAdmin, false},
		{bob, ClustersView, true}, {bob, PatroniManage, false}, {bob, SQLRead, true}, {bob, SQLWrite, false},
		{nobody, ClustersView, false},
	}
	for _, c := range cases {
		if got := set.Allowed(c.s, c.perm, prod, "", officeT).Allowed; got != c.want {
			t.Errorf("%s %s: got %v want %v", c.s.Username, c.perm, got, c.want)
		}
	}
	if !set.Allowed(Subject{System: true}, PoliciesManage, nil, "", officeT).Allowed {
		t.Error("API token must be allowed everything")
	}
}

func TestDenyWinsAndClusterScope(t *testing.T) {
	ps := append(builtins(), Policy{
		Name: "No Patroni actions on production", Effect: "deny", Enabled: true,
		Subjects: Subjects{Attributes: map[string][]string{"group": {"operator"}}}, Permissions: []string{PatroniManage, SQLWrite},
		Resources: Resources{Environments: []string{"production"}},
	})
	set := &Set{Policies: ps}
	d := set.Allowed(alice, PatroniManage, prod, "", officeT)
	if d.Allowed || d.Policy != "No Patroni actions on production" {
		t.Fatalf("prod: %+v", d)
	}
	if !set.Allowed(alice, PatroniManage, staging, "", officeT).Allowed {
		t.Fatal("staging should stay allowed")
	}
	// "on any cluster" (lists, create): a deny limited to some clusters doesn't take it away everywhere
	if !set.Allowed(alice, PatroniManage, nil, "", officeT).Allowed {
		t.Fatal("any-cluster check should be allowed")
	}
	// SQL write is gone on prod, read stays
	prof := set.SQL(alice, prod, "app", officeT)
	if prof.Level != LevelRead {
		t.Fatalf("prod sql level %s", prof.Level)
	}
	if set.SQL(alice, staging, "app", officeT).Level != LevelWrite {
		t.Fatal("staging sql level should be write")
	}
}

func TestSubjectsByUserAndAttributes(t *testing.T) {
	set := &Set{Policies: []Policy{
		{Name: "payments team", Effect: "allow", Enabled: true,
			Subjects: Subjects{Attributes: map[string][]string{"team": {"Payments", "core"}, "group": {"operator"}}}, Permissions: []string{LogsView}},
		{Name: "bob by name", Effect: "allow", Enabled: true, Subjects: Subjects{Users: []string{"BOB"}}, Permissions: []string{AuditView}},
		{Name: "everyone", Effect: "allow", Enabled: true, Subjects: Subjects{Everyone: true}, Permissions: []string{ClustersView}},
		{Name: "disabled", Effect: "allow", Enabled: false, Subjects: Subjects{Everyone: true}, Permissions: []string{UsersManage}},
	}}
	if !set.Allowed(alice, LogsView, prod, "", officeT).Allowed || set.Allowed(bob, LogsView, prod, "", officeT).Allowed {
		t.Fatal("attribute match (all keys, any value, case-insensitive)")
	}
	if !set.Allowed(bob, AuditView, nil, "", officeT).Allowed {
		t.Fatal("user name match is case-insensitive")
	}
	if !set.Allowed(nobody, ClustersView, prod, "", officeT).Allowed || set.Allowed(nobody, UsersManage, nil, "", officeT).Allowed {
		t.Fatal("everyone / disabled")
	}
}

func TestConditions(t *testing.T) {
	set := &Set{Policies: []Policy{{
		Name: "office hours", Effect: "allow", Enabled: true, Subjects: Subjects{Everyone: true}, Permissions: []string{SQLRead},
		Conditions: Conditions{IPRanges: []string{"10.0.0.0/8", "192.168.1.5"}, Weekdays: []int{1, 2, 3, 4, 5}, Hours: "08:00-20:00", Timezone: "Asia/Kolkata"},
	}}}
	at := func(ip string, tm time.Time) Context { return Context{IP: net.ParseIP(ip), Now: tm} }
	tue := time.Date(2026, 10, 6, 5, 0, 0, 0, time.UTC) // 10:30 in Kolkata, Tuesday
	if !set.Allowed(bob, SQLRead, prod, "", at("10.9.9.9", tue)).Allowed {
		t.Fatal("inside")
	}
	if !set.Allowed(bob, SQLRead, prod, "", at("192.168.1.5", tue)).Allowed {
		t.Fatal("single address")
	}
	if set.Allowed(bob, SQLRead, prod, "", at("172.16.0.1", tue)).Allowed {
		t.Fatal("outside IP range")
	}
	if set.Allowed(bob, SQLRead, prod, "", at("10.9.9.9", time.Date(2026, 10, 6, 16, 0, 0, 0, time.UTC))).Allowed {
		t.Fatal("21:30 Kolkata is outside the hours")
	}
	if set.Allowed(bob, SQLRead, prod, "", at("10.9.9.9", time.Date(2026, 10, 4, 5, 0, 0, 0, time.UTC))).Allowed {
		t.Fatal("Sunday")
	}
	night := &Set{Policies: []Policy{{Name: "night", Effect: "allow", Enabled: true, Subjects: Subjects{Everyone: true},
		Permissions: []string{PatroniManage}, Conditions: Conditions{Hours: "22:00-06:00"}}}}
	if !night.Allowed(bob, PatroniManage, prod, "", at("", time.Date(2026, 10, 6, 23, 30, 0, 0, time.UTC))).Allowed ||
		!night.Allowed(bob, PatroniManage, prod, "", at("", time.Date(2026, 10, 6, 2, 0, 0, 0, time.UTC))).Allowed ||
		night.Allowed(bob, PatroniManage, prod, "", at("", time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC))).Allowed {
		t.Fatal("hours wrapping midnight")
	}
}

func TestSQLProfileMerge(t *testing.T) {
	set := &Set{Policies: append(builtins(),
		Policy{Name: "analysts", Effect: "allow", Enabled: true, Subjects: Subjects{Attributes: map[string][]string{"team": {"analytics"}}},
			Permissions: []string{SQLRead}, Data: Data{Databases: []string{"shop"}, Schemas: []string{"sales"}, Tables: []string{"sales.orders", "sales.items"},
				HiddenColumns: []string{"sales.orders.card_no"}, MaxRows: 500, TimeoutSeconds: 30}},
		Policy{Name: "Hide PII", Effect: "deny", Enabled: true, Subjects: Subjects{Everyone: true},
			Data: Data{HiddenColumns: []string{"*.*.email"}}},
	)}
	// bob is a viewer (sql.read everywhere, no scope) + analyst: the unrestricted Viewers policy lifts the table scope
	p := set.SQL(bob, prod, "shop", officeT)
	if p.Level != LevelRead || len(p.Tables) != 0 || len(p.Schemas) != 0 {
		t.Fatalf("viewer+analyst: %+v", p)
	}
	if strings.Join(p.HiddenColumns, ",") != "*.*.email,sales.orders.card_no" || p.MaxRows != 500 || p.TimeoutSeconds != 30 {
		t.Fatalf("hidden/limits: %+v", p)
	}
	// an analyst without the viewer group only gets the scoped policy, and only on database shop
	dave := Subject{Username: "dave", Attributes: map[string]string{"team": "analytics"}}
	p = set.SQL(dave, prod, "shop", officeT)
	if p.Level != LevelRead || strings.Join(p.Tables, ",") != "sales.items,sales.orders" || strings.Join(p.Schemas, ",") != "sales" {
		t.Fatalf("analyst on shop: %+v", p)
	}
	if set.SQL(dave, prod, "postgres", officeT).Level != LevelNone {
		t.Fatal("analyst may not open database postgres")
	}
	if p := set.SQL(dave, prod, "", officeT); p.Level != LevelRead || strings.Join(p.Databases, ",") != "shop" {
		t.Fatalf("database list for the UI: %+v", p)
	}
	// the admin is downgraded from superuser because the PII policy hides columns for everyone
	p = set.SQL(carol, prod, "shop", officeT)
	if p.Level != LevelWrite || p.Note == "" || !p.Stats {
		t.Fatalf("admin with hidden columns: %+v", p)
	}
	// profiles with the same scope share a role
	if set.SQL(alice, prod, "shop", officeT).Key() != set.SQL(alice, staging, "other", officeT).Key() {
		t.Fatal("same scope, same key")
	}
}

func TestValidate(t *testing.T) {
	ok := Policy{Name: " x ", Subjects: Subjects{Users: []string{" a ", "a"}}, Permissions: []string{SQLRead, SQLRead}}
	if err := ok.Validate(); err != nil || ok.Name != "x" || ok.Effect != "allow" || len(ok.Permissions) != 1 || len(ok.Subjects.Users) != 1 {
		t.Fatalf("normalize: %v %+v", err, ok)
	}
	bad := []Policy{
		{Name: "", Subjects: Subjects{Everyone: true}, Permissions: []string{SQLRead}},
		{Name: "n", Subjects: Subjects{Everyone: true}, Permissions: []string{"sql.everything"}},
		{Name: "n", Permissions: []string{SQLRead}},
		{Name: "n", Effect: "maybe", Subjects: Subjects{Everyone: true}, Permissions: []string{SQLRead}},
		{Name: "n", Subjects: Subjects{Everyone: true}},
		{Name: "n", Subjects: Subjects{Everyone: true}, Permissions: []string{SQLRead}, Conditions: Conditions{IPRanges: []string{"10.0.0.0/33"}}},
		{Name: "n", Subjects: Subjects{Everyone: true}, Permissions: []string{SQLRead}, Conditions: Conditions{Hours: "8-20"}},
		{Name: "n", Subjects: Subjects{Everyone: true}, Permissions: []string{SQLRead}, Conditions: Conditions{Weekdays: []int{0}}},
		{Name: "n", Subjects: Subjects{Everyone: true}, Permissions: []string{SQLRead}, Data: Data{HiddenColumns: []string{"a.b.c.d"}}},
		{Name: "n", Subjects: Subjects{Everyone: true}, Permissions: []string{SQLRead}, Data: Data{Tables: []string{"["}}},
	}
	for i, p := range bad {
		if err := p.Validate(); err == nil {
			t.Errorf("bad[%d] accepted", i)
		}
	}
	deny := Policy{Name: "hide", Effect: "deny", Subjects: Subjects{Everyone: true}, Data: Data{HiddenColumns: []string{"email"}}}
	if err := deny.Validate(); err != nil {
		t.Fatalf("hide-only deny policy: %v", err)
	}
}

func TestExplain(t *testing.T) {
	set := &Set{Policies: append(builtins(), Policy{Name: "prod only", Effect: "allow", Enabled: true,
		Subjects: Subjects{Everyone: true}, Permissions: []string{LogsView}, Resources: Resources{Clusters: []string{"*-prod"}}})}
	got := map[string]string{}
	for _, m := range set.Explain(alice, staging, officeT) {
		got[m.Policy] = m.Why
	}
	if got["Operators"] != "applies" || got["Viewers"] != "not for this user" || got["prod only"] != "not for this cluster" {
		t.Fatalf("%v", got)
	}
}
