package upgrade

// Backups (pgBackRest) of any cluster - created by pg_MANTRA or found by Discover:
//   status   live, over SSH, on every node with pgBackRest: its config, `pgbackrest info`, PostgreSQL and WAL
//            archiving, Patroni, the backup schedule - summed up as the recovery window (how far back, and up to
//            when, the data can be restored), the backups, config differences between nodes, and issues
//   jobs     backup, check, stanza-create, config (written on every node, checked, undone on failure),
//            schedule (cron), restore (latest / PITR / a backup set) - run by the runner container
//            (automation-ha/upgrade/pgm-backup.yml), kept with their log like upgrades (component "backup")

import (
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"postgresql-cluster-console/internal/controllers"
	clusterctl "postgresql-cluster-console/internal/controllers/cluster"
	"postgresql-cluster-console/internal/discover"
	"postgresql-cluster-console/internal/storage"
	"postgresql-cluster-console/internal/xdocker"
	localmid "postgresql-cluster-console/middleware"
	"postgresql-cluster-console/models"
	"postgresql-cluster-console/pkg/tracer"
	ops "postgresql-cluster-console/restapi/operations/backup"

	"github.com/go-openapi/runtime/middleware"
)

// the node helper the runner uses too (kept identical: see TestBackupHelperInSync)
//
//go:embed assets/pgm_backup.py
var backupHelper string

/* ------------------------------------------------------------ nodes and login */

type backupNode struct {
	Name    string         `json:"name"`    // inventory name
	Address string         `json:"address"` // where SSH goes
	Vars    map[string]any `json:"-"`
}

// backupTarget: the nodes with pgBackRest, the name to confirm a restore with, and how to log in
type backupTarget struct {
	*target
	name  string
	nodes []backupNode
}

var backupGroups = []string{"pgbackrest", "backrest_cluster", "pgbackrest_cluster", "patroni_cluster", "postgres_cluster",
	"master", "replica"}

func (h *Handlers) backupTarget(ctx context.Context, kind string, id int64) (*backupTarget, error) {
	if kind == "discoveries" {
		d, err := h.db.GetDiscovery(ctx, id)
		if err != nil || d == nil {
			return nil, fmt.Errorf("saved discovery %d not found", id)
		}
		var r struct {
			Infra *struct {
				Hosts []struct {
					Address    string `json:"address"`
					Name       string `json:"name"`
					Components []struct {
						Kind string `json:"kind"`
					} `json:"components"`
				} `json:"hosts"`
			} `json:"infra"`
		}
		_ = json.Unmarshal(d.Result, &r)
		bt := &backupTarget{target: &target{discoveryID: id}, name: d.Name}
		if r.Infra != nil {
			for _, hst := range r.Infra.Hosts {
				for _, c := range hst.Components {
					if c.Kind == "pgbackrest" {
						bt.nodes = append(bt.nodes, backupNode{Name: hst.Address, Address: hst.Address})
						break
					}
				}
			}
		}
		if len(bt.nodes) == 0 {
			return nil, errors.New("Discover found no pgBackRest in this setup (run Discover again with SSH, or install pgBackRest)")
		}
		return bt, nil
	}
	t, err := h.clusterTarget(ctx, id)
	if err != nil {
		return nil, err
	}
	cl, _ := h.db.GetCluster(ctx, id)
	bt := &backupTarget{target: t, name: cl.Name}
	bt.nodes = inventoryNodes(t.inventory, backupGroups)
	if len(bt.nodes) == 0 {
		return nil, errors.New("no PostgreSQL / pgBackRest node in this cluster's inventory")
	}
	return bt, nil
}

// inventoryNodes: the hosts of the given groups (with their vars) in a JSON inventory (maybe stored as a string).
func inventoryNodes(inv []byte, groups []string) []backupNode {
	var raw any
	if json.Unmarshal(inv, &raw) != nil {
		return nil
	}
	if s, ok := raw.(string); ok {
		if json.Unmarshal([]byte(s), &raw) != nil {
			return nil
		}
	}
	all, _ := raw.(map[string]any)["all"].(map[string]any)
	children, _ := all["children"].(map[string]any)
	seen := map[string]bool{}
	var out []backupNode
	var walk func(g map[string]any, take bool)
	walk = func(g map[string]any, take bool) {
		if hs, ok := g["hosts"].(map[string]any); ok && take {
			names := make([]string, 0, len(hs))
			for n := range hs {
				names = append(names, n)
			}
			sort.Strings(names)
			for _, n := range names {
				if seen[n] {
					continue
				}
				seen[n] = true
				vars, _ := hs[n].(map[string]any)
				addr := n
				if a, ok := vars["ansible_host"].(string); ok && a != "" {
					addr = a
				}
				out = append(out, backupNode{Name: n, Address: addr, Vars: vars})
			}
		}
		if ch, ok := g["children"].(map[string]any); ok {
			for _, c := range ch {
				if cm, ok := c.(map[string]any); ok {
					walk(cm, take)
				}
			}
		}
	}
	for _, name := range groups {
		if g, ok := children[name].(map[string]any); ok {
			walk(g, true)
		}
	}
	return out
}

func inventoryUser(inv []byte) string {
	var raw any
	if json.Unmarshal(inv, &raw) != nil {
		return ""
	}
	if s, ok := raw.(string); ok {
		_ = json.Unmarshal([]byte(s), &raw)
	}
	all, _ := raw.(map[string]any)["all"].(map[string]any)
	vars, _ := all["vars"].(map[string]any)
	u, _ := vars["ansible_user"].(string)
	return u
}

var errNoLogin = errors.New("give the SSH user and password or key (used for this call only, never saved)")

// sshLogin: the login given now, else the cluster's stored secret
func (h *Handlers) sshLogin(ctx context.Context, bt *backupTarget, user, password, key string, port int64) (*discover.SSHAuth, error) {
	if u := strings.TrimSpace(user); u != "" {
		return &discover.SSHAuth{User: u, Password: password, Key: strings.TrimSpace(key), Port: int(port)}, nil
	}
	if bt.secretID == nil {
		return nil, errNoLogin
	}
	envs, asExtra, err := clusterctl.SecretEnvs(ctx, h.db, *bt.secretID, h.cfg.EncryptionKey, bt.projectID)
	if err != nil {
		return nil, fmt.Errorf("the cluster's SSH secret: %w", err)
	}
	a := &discover.SSHAuth{Port: int(port)}
	for _, kv := range envs {
		k, v, _ := strings.Cut(kv, "=")
		switch {
		case asExtra && k == "ansible_user":
			a.User = v
		case asExtra && k == "ansible_ssh_pass":
			a.Password = v
		case k == "SSH_PRIVATE_KEY_CONTENT":
			if b, err := base64.StdEncoding.DecodeString(v); err == nil && strings.Contains(string(b), "PRIVATE KEY") {
				v = string(b)
			}
			a.Key = v
		}
	}
	if a.User == "" {
		a.User = inventoryUser(bt.inventory)
	}
	if a.User == "" {
		a.User = "root"
	}
	return a, nil
}

/* ------------------------------------------------------------ status */

// BackupNodeStatus: what pgm_backup.py status says about one node (plus how the call went)
type BackupNodeStatus struct {
	Name    string         `json:"name"`
	Address string         `json:"address"`
	OK      bool           `json:"ok"`
	Error   string         `json:"error,omitempty"`
	Raw     map[string]any `json:"status,omitempty"`
}

const statusMarker = "@@pgm-backup"

func shQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'"'"'`) + "'" }

// helperScript: the shell that runs pgm_backup.py <action> on a node as root (directly, sudo -n, or sudo with the
// SSH password given through stdin of sudo only).
func helperScript(action string, spec map[string]any, password string) string {
	b, _ := json.Marshal(spec)
	arg := base64.StdEncoding.EncodeToString(b)
	return fmt.Sprintf(`PGM_PW=%s
T=$(mktemp /tmp/pgm_backup.XXXXXX) || exit 1
cat > "$T" <<'PGM_PY_EOF'
%s
PGM_PY_EOF
echo %s
if ! command -v python3 >/dev/null 2>&1; then echo '{"ok": false, "error": "python3 is not installed on this node"}'
elif [ "$(id -u)" = 0 ]; then python3 "$T" %s %s
elif sudo -n true 2>/dev/null; then sudo -n python3 "$T" %s %s
elif [ -n "$PGM_PW" ]; then printf '%%s\n' "$PGM_PW" | sudo -S -p '' python3 "$T" %s %s
else echo '{"ok": false, "error": "this login is not root and cannot use sudo"}'; fi
rm -f "$T"
`, shQuote(password), backupHelper, statusMarker, action, arg, action, arg, action, arg)
}

func lastJSON(out string) map[string]any {
	lines := strings.Split(strings.TrimSpace(out), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		l := strings.TrimSpace(lines[i])
		if strings.HasPrefix(l, "{") {
			var m map[string]any
			if json.Unmarshal([]byte(l), &m) == nil {
				return m
			}
		}
	}
	return nil
}

func (h *Handlers) backupStatus(ctx context.Context, bt *backupTarget, auth *discover.SSHAuth, stanza string) map[string]any {
	nodes := make([]BackupNodeStatus, len(bt.nodes))
	var wg sync.WaitGroup
	for i, n := range bt.nodes {
		wg.Add(1)
		go func(i int, n backupNode) {
			defer wg.Done()
			port := auth.Port
			if p, ok := n.Vars["ansible_port"].(float64); ok && port == 0 {
				port = int(p)
			}
			ns := BackupNodeStatus{Name: n.Name, Address: n.Address}
			out, err := discover.RunScript(ctx, n.Address, port, auth, helperScript("status", map[string]any{"stanza": stanza}, auth.Password),
				statusMarker, 3*time.Minute)
			if err != nil {
				ns.Error = err.Error()
			} else if m := lastJSON(out[strings.Index(out, statusMarker):]); m == nil {
				ns.Error = "no answer from the node: " + lastLines(out, 3)
			} else {
				ns.Raw, ns.OK = m, m["ok"] == true
				if e, _ := m["error"].(string); e != "" {
					ns.Error = e
				}
			}
			nodes[i] = ns
		}(i, n)
	}
	wg.Wait()
	return summarize(nodes, time.Now())
}

func lastLines(s string, n int) string {
	l := strings.Split(strings.TrimSpace(s), "\n")
	if len(l) > n {
		l = l[len(l)-n:]
	}
	return strings.Join(l, " | ")
}

/* ------------------------------------------------------------ summary */

// localKey: settings that are naturally different on each node (kept when a config is applied to all)
var localKey = regexp.MustCompile(`^pg\d+-(path|port|socket-path|host|host-user|host-config|host-config-path|host-port|database|user)$`)

func parseINI(text string) map[string]map[string]string {
	out := map[string]map[string]string{}
	sec := ""
	for _, line := range strings.Split(text, "\n") {
		l := strings.TrimSpace(line)
		switch {
		case l == "" || strings.HasPrefix(l, "#") || strings.HasPrefix(l, ";"):
		case strings.HasPrefix(l, "[") && strings.HasSuffix(l, "]"):
			sec = strings.TrimSpace(l[1 : len(l)-1])
			if out[sec] == nil {
				out[sec] = map[string]string{}
			}
		default:
			k, v, ok := strings.Cut(l, "=")
			if ok && sec != "" {
				out[sec][strings.TrimSpace(k)] = strings.TrimSpace(v)
			}
		}
	}
	return out
}

func secretKey(k string) bool {
	return strings.Contains(k, "cipher-pass") || strings.Contains(k, "-key") || strings.Contains(k, "secret") ||
		strings.Contains(k, "password") || strings.Contains(k, "token")
}

func num(v any) float64 {
	f, _ := v.(float64)
	return f
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

func mapOf(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func parsePGTime(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, false
	}
	for _, f := range []string{"2006-01-02 15:04:05.999999-07", "2006-01-02 15:04:05.999999-07:00", "2006-01-02 15:04:05-07",
		"2006-01-02 15:04:05-07:00"} {
		if t, err := time.Parse(f, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// summarize turns the nodes' answers into what the Backups page shows.
func summarize(nodes []BackupNodeStatus, now time.Time) map[string]any {
	type issue struct {
		Severity string `json:"severity"`
		Text     string `json:"text"`
	}
	var issues []issue
	add := func(sev, f string, a ...any) { issues = append(issues, issue{sev, fmt.Sprintf(f, a...)}) }

	var primary, runner *BackupNodeStatus
	var stanza string
	for i := range nodes {
		n := &nodes[i]
		if !n.OK {
			add("warning", "%s: %s", n.Address, n.Error)
			continue
		}
		if n.Raw["installed"] != true {
			add("warning", "%s: pgBackRest is not installed", n.Address)
		}
		for _, w := range anySlice(n.Raw["warnings"]) {
			add("info", "%s: %s", n.Address, str(w))
		}
		pg := mapOf(n.Raw["pg"])
		if n.Raw["repo_host"] == true && runner == nil {
			runner = n
		}
		if str(pg["role"]) == "primary" && primary == nil {
			primary = n
		}
	}
	if runner == nil {
		runner = primary
	}
	if runner == nil {
		for i := range nodes {
			if nodes[i].OK && len(anySlice(nodes[i].Raw["info"])) > 0 {
				runner = &nodes[i]
				break
			}
		}
	}
	if runner != nil {
		stanza = str(runner.Raw["stanza"])
	}
	for i := range nodes {
		if stanza == "" && nodes[i].OK {
			stanza = str(nodes[i].Raw["stanza"])
		}
	}

	// the backups, from the repository the runner sees
	var backups []map[string]any
	var stanzaStatus map[string]any
	var info map[string]any
	usable := map[string]bool{}
	if runner != nil {
		for _, s := range anySlice(runner.Raw["info"]) {
			if m := mapOf(s); m != nil && (stanza == "" || str(m["name"]) == stanza) {
				info = m
				break
			}
		}
		for _, l := range anySlice(runner.Raw["usable_sets"]) {
			usable[str(l)] = true
		}
	}
	var oldest, newest time.Time
	var totalRepo float64
	if info != nil {
		stanzaStatus = mapOf(info["status"])
		for _, b := range anySlice(info["backup"]) {
			bm := mapOf(b)
			ts, inf, lsn, arch := mapOf(bm["timestamp"]), mapOf(bm["info"]), mapOf(bm["lsn"]), mapOf(bm["archive"])
			repo := mapOf(inf["repository"])
			start, stop := time.Unix(int64(num(ts["start"])), 0), time.Unix(int64(num(ts["stop"])), 0)
			ok := len(usable) == 0 || usable[str(bm["label"])]
			if ok && (oldest.IsZero() || stop.Before(oldest)) {
				oldest = stop // the window starts at the oldest backup that can still be restored
			}
			if stop.After(newest) {
				newest = stop
			}
			totalRepo += num(repo["delta"])
			backups = append(backups, map[string]any{"label": bm["label"], "type": bm["type"], "start": start, "stop": stop,
				"duration_s": stop.Sub(start).Seconds(), "size": inf["size"], "delta": inf["delta"], "repo_size": repo["size"],
				"repo_delta": repo["delta"], "lsn_start": lsn["start"], "lsn_stop": lsn["stop"], "wal_start": arch["start"],
				"wal_stop": arch["stop"], "prior": bm["prior"], "usable": ok,
				"error": bm["error"]})
		}
	}
	// the recovery window: from the end of the oldest backup to the last archived WAL
	window := map[string]any{}
	if !oldest.IsZero() {
		window["from"] = oldest
		latest := newest
		if primary != nil {
			if t, ok := parsePGTime(str(mapOf(primary.Raw["pg"])["last_archived_time"])); ok && t.After(latest) {
				latest = t
			}
		}
		window["wal_time_known"] = false
		if primary != nil {
			_, known := parsePGTime(str(mapOf(primary.Raw["pg"])["last_archived_time"]))
			window["wal_time_known"] = known
		}
		window["to"] = latest
		window["span_s"] = latest.Sub(oldest).Seconds()
		window["data_loss_s"] = now.Sub(latest).Seconds() // time since the last WAL reached the repository
		if primary != nil {
			// what a crash now would lose: WAL written on the primary but not archived yet (RPO, in bytes)
			if v, ok := mapOf(primary.Raw["pg"])["pending_wal_bytes"].(float64); ok {
				window["pending_wal_bytes"] = v
			}
		}
		window["last_backup_age_s"] = now.Sub(newest).Seconds()
	}

	// checks
	canCreate := false
	if stanza == "" && len(nodes) > 0 {
		add("error", "no stanza found on any node (not in pgbackrest.conf or conf.d, not in the repository): "+
			"give its name in Stanza, or add a [stanza] section with pg1-path in Configuration, then Create Stanza")
	}
	if runner == nil && len(nodes) > 0 {
		add("error", "no node answered with a running primary or a repository server")
	}
	if info != nil {
		if code := num(stanzaStatus["code"]); code != 0 {
			add("error", "stanza %s: %s", stanza, str(stanzaStatus["message"]))
		}
		if len(backups) == 0 {
			add("error", "no backup yet: nothing can be restored")
		} else if age := now.Sub(newest); age > 26*time.Hour {
			add("warning", "the last backup is %s old", humanAge(age))
		}
		// missing stanza path / data: the stanza can be created
		if code := num(stanzaStatus["code"]); code == 1 || code == 3 {
			canCreate = stanza != ""
		}
	} else if runner != nil {
		if e := str(runner.Raw["info_error"]); e != "" {
			add("error", "pgbackrest info: %s", e)
		} else if stanza != "" {
			add("error", "stanza %s is not in the repository yet: create it (Create Stanza)", stanza)
		}
		canCreate = stanza != ""
	}
	if primary != nil {
		pg := mapOf(primary.Raw["pg"])
		if str(pg["archive_mode"]) != "on" && str(pg["archive_mode"]) != "always" {
			add("error", "WAL archiving is off on the primary: point-in-time restore is not possible")
		} else if t := str(pg["archive_timeout"]); t == "0" || t == "" {
			add("info", "archive_timeout is off: on a quiet database the last changes can wait long before they are archived (60s is usual)")
		}
		if am := str(pg["archive_mode"]); (am == "on" || am == "always") && !strings.Contains(str(pg["archive_command"]), "pgbackrest") {
			add("warning", "archive_command does not use pgBackRest: %s", str(pg["archive_command"]))
		}
		if lf, ok := parsePGTime(str(pg["last_failed_time"])); ok {
			if la, ok2 := parsePGTime(str(pg["last_archived_time"])); !ok2 || lf.After(la) {
				add("error", "WAL archiving is failing (last failure %s, WAL %s)", lf.Format(time.RFC3339), str(pg["last_failed_wal"]))
			}
		}
	}
	// the config on each node, and where they differ (beyond each node's own pg*-path / port / host ...)
	type diff struct {
		Section string            `json:"section"`
		Key     string            `json:"key"`
		Kind    string            `json:"kind"`
		Values  map[string]string `json:"values"`
	}
	var diffs []diff
	// compared between nodes of the same kind only: database nodes, and repository servers
	for _, kind := range []string{"db", "repo"} {
		confs := map[string]map[string]map[string]string{}
		keys := map[[2]string]bool{}
		for _, n := range nodes {
			if !n.OK || (n.Raw["repo_host"] == true) != (kind == "repo") {
				continue
			}
			text := str(n.Raw["config"])
			if files := anySlice(n.Raw["config_files"]); len(files) > 0 {
				var b strings.Builder
				for _, f := range files {
					b.WriteString(str(mapOf(f)["content"]) + "\n")
				}
				text = b.String()
			}
			c := parseINI(text)
			confs[n.Address] = c
			for sec, kv := range c {
				for k := range kv {
					if !localKey.MatchString(k) {
						keys[[2]string{sec, k}] = true
					}
				}
			}
		}
		if len(confs) < 2 {
			continue
		}
		ordered := make([][2]string, 0, len(keys))
		for k := range keys {
			ordered = append(ordered, k)
		}
		sort.Slice(ordered, func(i, j int) bool {
			return ordered[i][0]+ordered[i][1] < ordered[j][0]+ordered[j][1]
		})
		for _, k := range ordered {
			vals := map[string]string{}
			distinct := map[string]bool{}
			for addr, c := range confs {
				v, ok := c[k[0]][k[1]]
				if !ok {
					v = "(not set)"
				}
				if secretKey(k[1]) && ok {
					v = "•••• (" + fmt.Sprint(len(v)) + " chars)"
				}
				vals[addr] = v
				distinct[v] = true
			}
			if len(distinct) > 1 {
				diffs = append(diffs, diff{k[0], k[1], kind, vals})
			}
		}
	}
	if len(diffs) > 0 {
		add("warning", "the pgBackRest config differs between nodes of the same kind (%d settings)", len(diffs))
	}
	// the schedule
	hasCron := false
	for _, n := range nodes {
		if n.OK && len(anySlice(n.Raw["cron"])) > 0 {
			hasCron = true
		}
	}
	if !hasCron && len(backups) > 0 {
		add("warning", "no backup schedule (cron or systemd timer) on any node")
	}
	run := ""
	if runner != nil {
		run = runner.Address
	}
	prim := ""
	if primary != nil {
		prim = primary.Address
	}
	if issues == nil {
		issues = []issue{}
	}
	if backups == nil {
		backups = []map[string]any{}
	}
	if diffs == nil {
		diffs = []diff{}
	}
	return map[string]any{"nodes": nodes, "primary": prim, "runner": run, "stanza": stanza, "stanza_status": stanzaStatus,
		"backups": backups, "window": window, "repo_bytes": totalRepo, "issues": issues, "config_diff": diffs,
		"can_create_stanza": canCreate, "checked_at": now}
}

// humanAge: "28 hours", "3 days"
func humanAge(d time.Duration) string {
	h := int(d.Hours() + 0.5)
	if h < 48 {
		return fmt.Sprintf("%d hours", h)
	}
	return fmt.Sprintf("%d days", int(d.Hours()/24+0.5))
}

func anySlice(v any) []any {
	s, _ := v.([]any)
	return s
}

/* ------------------------------------------------------------ jobs */

var backupActions = map[string]bool{"backup": true, "check": true, "stanza-create": true, "config": true, "schedule": true,
	"restore": true}

type backupOpts struct {
	Stanza      string           `json:"stanza,omitempty"`
	Type        string           `json:"type,omitempty"`
	TargetTime  string           `json:"target_time,omitempty"`
	Set         string           `json:"set,omitempty"`
	RestoreHost string           `json:"restore_host,omitempty"`
	PreBackup   bool             `json:"pre_backup,omitempty"`
	PostBackup  bool             `json:"post_backup,omitempty"`
	KeepLocal   bool             `json:"keep_local,omitempty"`
	Verify      bool             `json:"verify,omitempty"`
	ConfigBytes int              `json:"config_bytes,omitempty"`
	File        string           `json:"file,omitempty"`
	ConfigKind  string           `json:"config_kind,omitempty"`
	Entries     []map[string]any `json:"entries,omitempty"`
	Remove      bool             `json:"remove,omitempty"`
	SSHUser     string           `json:"ssh_user,omitempty"`
}

var labelRe = regexp.MustCompile(`^\d{8}-\d{6}[FDI](_\d{8}-\d{6}[DI])?$`)

func boolOr(p *bool, def bool) bool {
	if p == nil {
		return def
	}
	return *p
}

func (h *Handlers) startBackupJob(ctx context.Context, bt *backupTarget, b *models.RequestBackupJob) (any, error) {
	if b == nil || b.Action == nil || !backupActions[*b.Action] {
		return nil, errors.New("action must be backup, check, stanza-create, config, schedule or restore")
	}
	action := *b.Action
	list, err := h.db.ListUpgrades(ctx, bt.clusterID, bt.discoveryID, 30)
	if err != nil {
		return nil, err
	}
	for _, u := range list {
		if u.Status == "running" {
			return nil, fmt.Errorf("#%d (%s %s) is still running on this cluster", u.ID, u.Component, u.Action)
		}
	}
	o := backupOpts{Stanza: strings.TrimSpace(b.Stanza), Type: b.Type, SSHUser: strings.TrimSpace(b.SSHUser)}
	pgm := map[string]any{"action": action, "stanza": o.Stanza}
	switch action {
	case "backup":
		if o.Type == "" {
			o.Type = "incr"
		}
		if o.Type != "full" && o.Type != "diff" && o.Type != "incr" {
			return nil, errors.New("backup type must be full, diff or incr")
		}
		pgm["type"] = o.Type
	case "config":
		if strings.TrimSpace(b.Config) == "" || !strings.Contains(b.Config, "[") {
			return nil, errors.New("give the new pgbackrest.conf")
		}
		o.KeepLocal, o.Verify, o.ConfigBytes = boolOr(b.KeepLocal, true), boolOr(b.Verify, true), len(b.Config)
		pgm["content_b64"] = base64.StdEncoding.EncodeToString([]byte(b.Config))
		pgm["keep_local"], pgm["verify"] = o.KeepLocal, o.Verify
		if f := strings.TrimSpace(b.File); f != "" {
			if !regexp.MustCompile(`^[A-Za-z0-9_./-]+\.conf$`).MatchString(f) {
				return nil, errors.New("not a pgBackRest config file")
			}
			pgm["file"], o.File = f, f
		}
		switch b.ConfigKind {
		case "", "db", "repo":
			pgm["config_kind"], o.ConfigKind = b.ConfigKind, b.ConfigKind
		default:
			return nil, errors.New("config_kind must be db or repo")
		}
	case "schedule":
		for _, e := range b.Entries {
			m, _ := e.(map[string]any)
			if m == nil {
				return nil, errors.New("a schedule entry is not valid")
			}
			o.Entries = append(o.Entries, m)
		}
		o.Remove = b.Remove || len(o.Entries) == 0
		pgm["entries"], pgm["remove"] = o.Entries, o.Remove
	case "restore":
		if strings.TrimSpace(b.Confirm) != bt.name {
			return nil, fmt.Errorf("type the cluster name (%s) to confirm the restore", bt.name)
		}
		switch b.Type {
		case "", "latest":
			o.Type = "latest"
		case "time":
			o.Type, o.TargetTime = "time", strings.TrimSpace(b.TargetTime)
			if o.TargetTime == "" {
				return nil, errors.New("give the time to restore to")
			}
		case "set":
			o.Type, o.Set = "latest", strings.TrimSpace(b.Set)
			if !labelRe.MatchString(o.Set) {
				return nil, errors.New("choose the backup to restore")
			}
		default:
			return nil, errors.New("restore type must be latest, time or set")
		}
		if b.Type == "set" {
			// restore that backup exactly as it was taken (no WAL replay beyond it)
			o.Type = "immediate"
		}
		o.RestoreHost, o.PreBackup, o.PostBackup = strings.TrimSpace(b.RestoreHost), b.PreBackup, boolOr(b.PostBackup, true)
		if o.RestoreHost != "" {
			found := false
			for _, n := range bt.nodes {
				found = found || n.Name == o.RestoreHost || n.Address == o.RestoreHost
			}
			if !found {
				return nil, fmt.Errorf("%s is not a node of this cluster", o.RestoreHost)
			}
		}
		pgm["type"], pgm["target_time"], pgm["set"] = o.Type, o.TargetTime, o.Set
		pgm["restore_host"], pgm["pre_backup"], pgm["post_backup"] = o.RestoreHost, o.PreBackup, o.PostBackup
	}

	// the login: given now, else the cluster's stored secret
	auth, err := h.sshLogin(ctx, bt, b.SSHUser, b.SSHPassword, b.SSHKey, b.SSHPort)
	if err != nil {
		return nil, err
	}
	extra := map[string]any{"ansible_user": auth.User}
	envs := []string{}
	if auth.Port > 0 {
		extra["ansible_port"] = auth.Port
	}
	if auth.Password != "" {
		extra["ansible_ssh_pass"], extra["ansible_become_pass"] = auth.Password, auth.Password
	}
	if auth.Key != "" {
		envs = append(envs, "SSH_PRIVATE_KEY_CONTENT="+base64.StdEncoding.EncodeToString([]byte(strings.TrimSpace(auth.Key)+"\n")))
	}
	// the inventory: one group with every pgBackRest node (their own vars kept)
	hosts := map[string]any{}
	for _, n := range bt.nodes {
		vars := map[string]any{}
		for k, v := range n.Vars {
			if !strings.HasPrefix(k, "ansible_ssh_pass") && !strings.HasPrefix(k, "ansible_become_pass") {
				vars[k] = v
			}
		}
		if n.Address != n.Name {
			vars["ansible_host"] = n.Address
		}
		hosts[n.Name] = vars
	}
	inv, _ := json.Marshal(map[string]any{"all": map[string]any{"children": map[string]any{"pgm_backup": map[string]any{"hosts": hosts}}}})

	by := ""
	if pr := localmid.PrincipalFrom(ctx); pr != nil {
		by = pr.Username
	}
	optJSON, _ := json.Marshal(o)
	nz := func(v int64) *int64 {
		if v == 0 {
			return nil
		}
		return &v
	}
	up, err := h.db.CreateUpgrade(ctx, &storage.Upgrade{ClusterID: nz(bt.clusterID), DiscoveryID: nz(bt.discoveryID),
		Component: "backup", Action: action, Options: optJSON, CreatedBy: by})
	if err != nil {
		return nil, err
	}
	pgm["id"], pgm["run_id"] = up.ID, up.ID
	extra["pgm"] = pgm
	extraJSON, _ := json.Marshal(extra)
	envs = append(envs, "PGM_MODE=backup",
		"ANSIBLE_INVENTORY_JSON="+base64.StdEncoding.EncodeToString(inv),
		fmt.Sprintf("ANSIBLE_JSON_LOG_FILE=%s/upgrade-%d.json", ansibleLogDir, up.ID), "ANSIBLE_NOCOLOR=1", "ANSIBLE_FORCE_COLOR=0",
		"ANSIBLE_HOST_PATTERN_MISMATCH=ignore", "ANSIBLE_LOCALHOST_WARNING=False")
	dockerID, err := h.docker.ManageCluster(ctx, &xdocker.ManageClusterConfig{Image: h.cfg.Docker.UpgradeImage, Envs: envs,
		ExtraVars: string(extraJSON), Mounts: []xdocker.Mount{{DockerPath: ansibleLogDir, HostPath: h.cfg.Docker.LogDir}}})
	if err != nil {
		_ = h.db.FinishUpgrade(ctx, up.ID, "failed", []byte(fmt.Sprintf(`[{"error": %q}]`, err.Error())))
		return nil, fmt.Errorf("could not start the runner (%s - built by ./build.sh console): %w", h.cfg.Docker.UpgradeImage, err)
	}
	_ = h.db.SetUpgradeDocker(ctx, up.ID, string(dockerID))
	cid, _ := ctx.Value(tracer.CtxCidKey{}).(string)
	lctx := context.WithValue(context.Background(), tracer.CtxCidKey{}, cid)
	go h.docker.StoreContainerLogs(lctx, dockerID, func(line string) { _ = h.db.AppendUpgradeLog(lctx, up.ID, line) })
	return view(up, false), nil
}

func (h *Handlers) backupJobs(ctx context.Context, bt *backupTarget) ([]any, error) {
	list, err := h.db.ListUpgrades(ctx, bt.clusterID, bt.discoveryID, 200)
	if err != nil {
		return nil, err
	}
	out := []any{}
	for i := range list {
		if list[i].Component == "backup" {
			out = append(out, view(&list[i], false))
		}
	}
	return out, nil
}

func (h *Handlers) backupJob(ctx context.Context, bt *backupTarget, uid int64) (any, error) {
	u, err := h.db.GetUpgrade(ctx, uid)
	if err != nil || u == nil || u.Component != "backup" ||
		(bt.clusterID != 0 && (u.ClusterID == nil || *u.ClusterID != bt.clusterID)) ||
		(bt.discoveryID != 0 && (u.DiscoveryID == nil || *u.DiscoveryID != bt.discoveryID)) {
		return nil, errors.New("job not found")
	}
	return view(u, true), nil
}

/* ------------------------------------------------------------ handlers */

func bkBad(err error) middleware.Responder {
	return ops.NewPostBackupsDiscoveriesIDStatusBadRequest().WithPayload(controllers.MakeErrorPayload(err, controllers.BaseError))
}

type bkStatusD struct{ *Handlers }
type bkStatusC struct{ *Handlers }
type bkJobsD struct{ *Handlers }
type bkJobsC struct{ *Handlers }
type bkStartD struct{ *Handlers }
type bkStartC struct{ *Handlers }
type bkJobD struct{ *Handlers }
type bkJobC struct{ *Handlers }

func (h *Handlers) BackupStatusDiscovery() ops.PostBackupsDiscoveriesIDStatusHandler {
	return bkStatusD{h}
}
func (h *Handlers) BackupStatusCluster() ops.PostBackupsClustersIDStatusHandler   { return bkStatusC{h} }
func (h *Handlers) BackupJobsDiscovery() ops.GetBackupsDiscoveriesIDJobsHandler   { return bkJobsD{h} }
func (h *Handlers) BackupJobsCluster() ops.GetBackupsClustersIDJobsHandler        { return bkJobsC{h} }
func (h *Handlers) BackupStartDiscovery() ops.PostBackupsDiscoveriesIDJobsHandler { return bkStartD{h} }
func (h *Handlers) BackupStartCluster() ops.PostBackupsClustersIDJobsHandler      { return bkStartC{h} }
func (h *Handlers) BackupJobDiscovery() ops.GetBackupsDiscoveriesIDJobsUIDHandler { return bkJobD{h} }
func (h *Handlers) BackupJobCluster() ops.GetBackupsClustersIDJobsUIDHandler      { return bkJobC{h} }

func (h *Handlers) statusFor(ctx context.Context, kind string, id int64, b *models.RequestBackupStatus) (any, error) {
	bt, err := h.backupTarget(ctx, kind, id)
	if err != nil {
		return nil, err
	}
	if b == nil {
		b = &models.RequestBackupStatus{}
	}
	auth, err := h.sshLogin(ctx, bt, b.SSHUser, b.SSHPassword, b.SSHKey, b.SSHPort)
	if errors.Is(err, errNoLogin) {
		// not an error: the page asks for the login
		return map[string]any{"need_login": true, "name": bt.name}, nil
	}
	if err != nil {
		return nil, err
	}
	out := h.backupStatus(ctx, bt, auth, strings.TrimSpace(b.Stanza))
	out["name"] = bt.name
	return out, nil
}

func (h bkStatusD) Handle(p ops.PostBackupsDiscoveriesIDStatusParams) middleware.Responder {
	v, err := h.statusFor(p.HTTPRequest.Context(), "discoveries", p.ID, p.Body)
	if err != nil {
		return bkBad(err)
	}
	return ops.NewPostBackupsDiscoveriesIDStatusOK().WithPayload(v)
}

func (h bkStatusC) Handle(p ops.PostBackupsClustersIDStatusParams) middleware.Responder {
	v, err := h.statusFor(p.HTTPRequest.Context(), "clusters", p.ID, p.Body)
	if err != nil {
		return bkBad(err)
	}
	return ops.NewPostBackupsClustersIDStatusOK().WithPayload(v)
}

func (h *Handlers) withTarget(ctx context.Context, kind string, id int64, f func(*backupTarget) (any, error)) (any, error) {
	bt, err := h.backupTarget(ctx, kind, id)
	if err != nil {
		return nil, err
	}
	return f(bt)
}

func (h bkJobsD) Handle(p ops.GetBackupsDiscoveriesIDJobsParams) middleware.Responder {
	ctx := p.HTTPRequest.Context()
	v, err := h.withTarget(ctx, "discoveries", p.ID, func(bt *backupTarget) (any, error) { return h.backupJobs(ctx, bt) })
	if err != nil {
		return bkBad(err)
	}
	return ops.NewGetBackupsDiscoveriesIDJobsOK().WithPayload(v.([]any))
}

func (h bkJobsC) Handle(p ops.GetBackupsClustersIDJobsParams) middleware.Responder {
	ctx := p.HTTPRequest.Context()
	v, err := h.withTarget(ctx, "clusters", p.ID, func(bt *backupTarget) (any, error) { return h.backupJobs(ctx, bt) })
	if err != nil {
		return bkBad(err)
	}
	return ops.NewGetBackupsClustersIDJobsOK().WithPayload(v.([]any))
}

func (h bkStartD) Handle(p ops.PostBackupsDiscoveriesIDJobsParams) middleware.Responder {
	ctx := p.HTTPRequest.Context()
	v, err := h.withTarget(ctx, "discoveries", p.ID, func(bt *backupTarget) (any, error) { return h.startBackupJob(ctx, bt, p.Body) })
	if err != nil {
		return bkBad(err)
	}
	return ops.NewPostBackupsDiscoveriesIDJobsOK().WithPayload(v)
}

func (h bkStartC) Handle(p ops.PostBackupsClustersIDJobsParams) middleware.Responder {
	ctx := p.HTTPRequest.Context()
	v, err := h.withTarget(ctx, "clusters", p.ID, func(bt *backupTarget) (any, error) { return h.startBackupJob(ctx, bt, p.Body) })
	if err != nil {
		return bkBad(err)
	}
	return ops.NewPostBackupsClustersIDJobsOK().WithPayload(v)
}

func (h bkJobD) Handle(p ops.GetBackupsDiscoveriesIDJobsUIDParams) middleware.Responder {
	ctx := p.HTTPRequest.Context()
	v, err := h.withTarget(ctx, "discoveries", p.ID, func(bt *backupTarget) (any, error) { return h.backupJob(ctx, bt, p.UID) })
	if err != nil {
		return bkBad(err)
	}
	return ops.NewGetBackupsDiscoveriesIDJobsUIDOK().WithPayload(v)
}

func (h bkJobC) Handle(p ops.GetBackupsClustersIDJobsUIDParams) middleware.Responder {
	ctx := p.HTTPRequest.Context()
	v, err := h.withTarget(ctx, "clusters", p.ID, func(bt *backupTarget) (any, error) { return h.backupJob(ctx, bt, p.UID) })
	if err != nil {
		return bkBad(err)
	}
	return ops.NewGetBackupsClustersIDJobsUIDOK().WithPayload(v)
}
