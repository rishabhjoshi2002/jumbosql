package discover

// The inventory: a plain list of servers, or an Ansible inventory (INI or YAML, e.g. the one CPA / Autobase
// deploy from), whose groups tell what each machine is meant to be.

import (
	"errors"
	"fmt"
	"net"
	"sort"
	"strconv"
	"strings"

	"go.yaml.in/yaml/v3"
)

// InvHost is one machine of the inventory.
type InvHost struct {
	Address string            `json:"address"` // what we connect to (ansible_host, else the inventory name)
	Name    string            `json:"name,omitempty"`
	Groups  []string          `json:"groups,omitempty"`
	PGPort  int               `json:"pg_port"`
	SSHPort int               `json:"ssh_port,omitempty"`
	Vars    map[string]string `json:"-"`
}

// groups that mean "PostgreSQL runs here" in common inventories (CPA/Autobase, postgresql_cluster, others)
var dbGroups = map[string]bool{"master": true, "replica": true, "postgres_cluster": true, "postgresql": true,
	"postgres": true, "primary": true, "standby": true, "db": true, "database": true, "patroni": true}

func (h InvHost) DeclaredDB() bool {
	for _, g := range h.Groups {
		if dbGroups[strings.ToLower(g)] {
			return true
		}
	}
	return false
}

// ParseHosts reads an Ansible inventory (INI or YAML) or a plain list ("host", "host:port", "host port").
func ParseHosts(text string, defaultPGPort int) ([]InvHost, error) {
	if defaultPGPort == 0 {
		defaultPGPort = 5432
	}
	t := strings.TrimSpace(text)
	var hosts []InvHost
	var err error
	switch {
	case t == "":
		return nil, errors.New("the inventory is empty")
	case looksYAML(t):
		hosts, err = parseYAMLInventory(t)
	case strings.Contains(t, "[") && strings.Contains(t, "]") && iniHeader(t):
		hosts = parseINIInventory(t)
	default:
		var targets []Target
		targets, err = ParseInventory(t)
		for _, x := range targets {
			hosts = append(hosts, InvHost{Address: x.Host, PGPort: x.Port})
		}
	}
	if err != nil {
		return nil, err
	}
	// one entry per address; the PostgreSQL port from the inventory variables
	seen := map[string]int{}
	var out []InvHost
	for _, h := range hosts {
		if h.PGPort == 0 {
			h.PGPort = defaultPGPort
			for _, k := range []string{"postgresql_port", "pg_port", "postgres_port", "patroni_postgresql_port"} {
				if p, err := strconv.Atoi(h.Vars[k]); err == nil && p > 0 {
					h.PGPort = p
				}
			}
		}
		if p, err := strconv.Atoi(h.Vars["ansible_port"]); err == nil {
			h.SSHPort = p
		}
		if h.Name == "" {
			for _, k := range []string{"hostname", "patroni_name", "inventory_hostname"} {
				if v := h.Vars[k]; v != "" {
					h.Name = v
					break
				}
			}
		}
		if strings.ContainsAny(h.Address, "'\"\\ ") || h.Address == "" {
			return nil, fmt.Errorf("%q is not a host name or address", h.Address)
		}
		if i, ok := seen[h.Address]; ok {
			for _, g := range h.Groups {
				out[i].Groups = appendOnce(out[i].Groups, g)
			}
			continue
		}
		seen[h.Address] = len(out)
		out = append(out, h)
	}
	if len(out) == 0 {
		return nil, errors.New("no hosts found in the inventory")
	}
	if len(out) > 60 {
		return nil, errors.New("at most 60 machines at a time")
	}
	for i := range out {
		sort.Strings(out[i].Groups)
	}
	return out, nil
}

func looksYAML(t string) bool {
	for _, l := range strings.Split(t, "\n") {
		l = strings.TrimSpace(l)
		if l == "" || strings.HasPrefix(l, "#") || l == "---" {
			continue
		}
		return strings.HasSuffix(l, ":") || strings.HasPrefix(l, "all:")
	}
	return false
}

func iniHeader(t string) bool {
	for _, l := range strings.Split(t, "\n") {
		l = strings.TrimSpace(l)
		if strings.HasPrefix(l, "[") && strings.HasSuffix(l, "]") && !strings.Contains(l, ":") ||
			strings.HasPrefix(l, "[") && strings.HasSuffix(l, ":vars]") || strings.HasPrefix(l, "[") && strings.HasSuffix(l, ":children]") {
			return true
		}
	}
	return false
}

// INI: [group], [group:children], [group:vars]; host lines "name key=value ..."
func parseINIInventory(t string) []InvHost {
	byName := map[string]*InvHost{}
	var order []string
	children := map[string][]string{}
	groupHosts := map[string][]string{}
	section, kind := "ungrouped", "hosts"
	for _, raw := range strings.Split(t, "\n") {
		l := strings.TrimSpace(raw)
		if l == "" || strings.HasPrefix(l, "#") || strings.HasPrefix(l, ";") {
			continue
		}
		if strings.HasPrefix(l, "[") && strings.HasSuffix(l, "]") {
			name := strings.Trim(l, "[]")
			section, kind = name, "hosts"
			if i := strings.Index(name, ":"); i > 0 {
				section, kind = name[:i], name[i+1:]
			}
			continue
		}
		switch kind {
		case "children":
			children[section] = append(children[section], strings.Fields(l)[0])
		case "hosts":
			f := strings.Fields(l)
			name := f[0]
			h := byName[name]
			if h == nil {
				h = &InvHost{Address: name, Vars: map[string]string{}}
				byName[name] = h
				order = append(order, name)
			}
			for _, kv := range f[1:] {
				if k, v, ok := strings.Cut(kv, "="); ok {
					h.Vars[k] = strings.Trim(v, `"'`)
				}
			}
			if a := h.Vars["ansible_host"]; a != "" {
				h.Address = a
				if h.Name == "" && net.ParseIP(name) == nil {
					h.Name = name
				}
			}
			groupHosts[section] = append(groupHosts[section], name)
		}
	}
	// a host is in its groups and in every parent group (children)
	var addGroup func(group string, host string, depth int)
	addGroup = func(group, host string, depth int) {
		if depth > 10 {
			return
		}
		if group != "ungrouped" {
			byName[host].Groups = appendOnce(byName[host].Groups, group)
		}
		for parent, kids := range children {
			for _, k := range kids {
				if k == group {
					addGroup(parent, host, depth+1)
				}
			}
		}
	}
	for g, hs := range groupHosts {
		for _, h := range hs {
			addGroup(g, h, 0)
		}
	}
	out := make([]InvHost, 0, len(order))
	for _, n := range order {
		out = append(out, *byName[n])
	}
	return out
}

// YAML: all: {hosts: {...}, vars: {...}, children: {group: {hosts: {name: {vars}}, children: {...}}}}
func parseYAMLInventory(t string) ([]InvHost, error) {
	var root map[string]any
	if err := yaml.Unmarshal([]byte(t), &root); err != nil {
		return nil, fmt.Errorf("the inventory looks like YAML but cannot be read: %w", err)
	}
	byName := map[string]*InvHost{}
	var order []string
	var walk func(group string, node any, inherited map[string]string, parents []string, depth int)
	walk = func(group string, node any, inherited map[string]string, parents []string, depth int) {
		m, ok := node.(map[string]any)
		if !ok || depth > 10 {
			return
		}
		vars := map[string]string{}
		for k, v := range inherited {
			vars[k] = v
		}
		if gv, ok := m["vars"].(map[string]any); ok {
			for k, v := range gv {
				vars[k] = fmt.Sprint(v)
			}
		}
		groups := parents
		if group != "all" && group != "" {
			groups = append(append([]string{}, parents...), group)
		}
		if hs, ok := m["hosts"].(map[string]any); ok {
			for name, hv := range hs {
				h := byName[name]
				if h == nil {
					h = &InvHost{Address: name, Vars: map[string]string{}}
					byName[name] = h
					order = append(order, name)
				}
				for k, v := range vars {
					if _, set := h.Vars[k]; !set {
						h.Vars[k] = v
					}
				}
				if hm, ok := hv.(map[string]any); ok {
					for k, v := range hm {
						h.Vars[k] = fmt.Sprint(v)
					}
				}
				for _, g := range groups {
					h.Groups = appendOnce(h.Groups, g)
				}
				if a := h.Vars["ansible_host"]; a != "" {
					h.Address = a
					if h.Name == "" && net.ParseIP(name) == nil {
						h.Name = name
					}
				}
			}
		}
		if ch, ok := m["children"].(map[string]any); ok {
			for g, sub := range ch {
				walk(g, sub, vars, groups, depth+1)
			}
		}
	}
	for g, node := range root {
		walk(g, node, nil, nil, 0)
	}
	sort.Strings(order) // map order is random; keep a stable order
	out := make([]InvHost, 0, len(order))
	for _, n := range order {
		out = append(out, *byName[n])
	}
	return out, nil
}
