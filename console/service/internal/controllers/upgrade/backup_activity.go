package upgrade

// Running backups. A backup started by a schedule (cron or a systemd timer), by hand, or by the console is shown to
// everyone signed in who may run backups on that cluster: a popup that opens its live view on the Backup & Restore
// page. The nodes are only asked while someone has the console open (the page asks every 30 s, the nodes are asked
// at most every 45 s), over SSH with the cluster's stored secret, or - for a setup found by Discover - with the
// login last used on its Backup & Restore page. That login is kept in memory only: never written anywhere, gone
// after 12 hours or when the console restarts.

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	acc "postgresql-cluster-console/internal/access"
	"postgresql-cluster-console/internal/discover"
	"postgresql-cluster-console/internal/policy"
	"postgresql-cluster-console/internal/storage"
	localmid "postgresql-cluster-console/middleware"
	ops "postgresql-cluster-console/restapi/operations/backup"

	"github.com/go-openapi/runtime/middleware"
)

// ActivityItem: one backup running on one node
type ActivityItem struct {
	Key       string    `json:"key"` // stable while it runs: kind/id/address/pid/start
	Kind      string    `json:"kind"`
	ID        int64     `json:"id"`
	Cluster   string    `json:"cluster"`
	Node      string    `json:"node"`
	Address   string    `json:"address"`
	Stanza    string    `json:"stanza"`
	Type      string    `json:"type"`
	Repo      string    `json:"repo,omitempty"`
	By        string    `json:"by"`  // schedule | manual | console | other
	How       string    `json:"how"` // cron, timer <name> ...
	User      string    `json:"user,omitempty"`
	Started   time.Time `json:"started"`
	Size      float64   `json:"size,omitempty"`
	Done      float64   `json:"done,omitempty"`
	clusterID int64
}

type savedLogin struct {
	auth  discover.SSHAuth
	until time.Time
}

type activity struct {
	mu      sync.Mutex
	items   []ActivityItem
	checked time.Time
	busy    bool
	targets int
	logins  map[int64]savedLogin // discovery id -> the login last used on its page (memory only)
}

const (
	activityEvery = 45 * time.Second
	loginKeep     = 12 * time.Hour
)

func newActivity() *activity { return &activity{logins: map[int64]savedLogin{}} }

// remember the login a user gave for a setup found by Discover (memory only), so its running backups can be seen
func (a *activity) remember(discoveryID int64, auth *discover.SSHAuth) {
	if a == nil || auth == nil || discoveryID == 0 {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.logins[discoveryID] = savedLogin{auth: *auth, until: time.Now().Add(loginKeep)}
}

// SetAccess gives the handlers the access policies (to show each user only the clusters they may back up)
func (h *Handlers) SetAccess(a *acc.Service) { h.access = a }

// refresh asks every node that can be reached what is running now
func (h *Handlers) refreshActivity(ctx context.Context) {
	a := h.act
	type job struct {
		kind  string
		id    int64
		cid   int64
		bt    *backupTarget
		auth  *discover.SSHAuth
		cname string
	}
	var jobs []job
	limit := int64(1000)
	if cl, _, err := h.db.GetClusters(ctx, &storage.GetClustersReq{Limit: &limit}); err == nil {
		for _, c := range cl {
			bt, err := h.backupTarget(ctx, "clusters", c.ID)
			if err != nil || bt.secretID == nil {
				continue
			}
			auth, err := h.sshLogin(ctx, bt, "", "", "", 0)
			if err != nil {
				continue
			}
			jobs = append(jobs, job{"clusters", c.ID, c.ID, bt, auth, c.Name})
		}
	}
	a.mu.Lock()
	now := time.Now()
	logins := map[int64]discover.SSHAuth{}
	for id, l := range a.logins {
		if now.After(l.until) {
			delete(a.logins, id)
			continue
		}
		logins[id] = l.auth
	}
	a.mu.Unlock()
	for id, auth := range logins {
		bt, err := h.backupTarget(ctx, "discoveries", id)
		if err != nil {
			continue
		}
		au := auth
		jobs = append(jobs, job{"discoveries", id, 0, bt, &au, bt.name})
	}

	var mu sync.Mutex
	var items []ActivityItem
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	for _, j := range jobs {
		for _, n := range j.bt.nodes {
			wg.Add(1)
			go func(j job, n backupNode) {
				defer wg.Done()
				sem <- struct{}{}
				defer func() { <-sem }()
				port := j.auth.Port
				if p, ok := n.Vars["ansible_port"].(float64); ok && port == 0 {
					port = int(p)
				}
				out, err := discover.RunScript(ctx, n.Address, port, j.auth, helperScript("activity", map[string]any{}, j.auth.Password),
					statusMarker, 40*time.Second)
				if err != nil {
					return
				}
				m := lastJSON(out[strings.Index(out, statusMarker):])
				if m == nil {
					return
				}
				for _, r := range anySlice(m["running"]) {
					rm := mapOf(r)
					started := time.Unix(int64(num(rm["started"])), 0)
					it := ActivityItem{Kind: j.kind, ID: j.id, Cluster: j.cname, Node: n.Name, Address: n.Address,
						Stanza: str(rm["stanza"]), Type: str(rm["type"]), Repo: str(rm["repo"]), By: str(rm["by"]),
						How: str(rm["how"]), User: str(rm["user"]), Started: started, Size: num(rm["size"]),
						Done: num(rm["done"]), clusterID: j.cid}
					it.Key = fmt.Sprintf("%s/%d/%s/%v/%d", j.kind, j.id, n.Address, rm["pid"], started.Unix())
					mu.Lock()
					items = append(items, it)
					mu.Unlock()
				}
			}(j, n)
		}
	}
	wg.Wait()
	sort.Slice(items, func(i, k int) bool { return items[i].Started.Before(items[k].Started) })
	// one backup is one entry, even when two nodes report the same process (nodes sharing a process view)
	seen := map[string]bool{}
	uniq := items[:0]
	for _, it := range items {
		k := fmt.Sprintf("%s/%d/%s/%d", it.Kind, it.ID, it.Key[strings.LastIndex(it.Key[:strings.LastIndex(it.Key, "/")], "/")+1:], it.Started.Unix())
		if !seen[k] {
			seen[k] = true
			uniq = append(uniq, it)
		}
	}
	items = uniq
	a.mu.Lock()
	a.items, a.checked, a.busy, a.targets = items, time.Now(), false, len(jobs)
	a.mu.Unlock()
}

type bkActivity struct{ *Handlers }

func (h *Handlers) BackupActivity() ops.GetBackupsActivityHandler { return bkActivity{h} }

func (h bkActivity) Handle(p ops.GetBackupsActivityParams) middleware.Responder {
	r := p.HTTPRequest
	ctx := r.Context()
	a := h.act
	fresh := p.Fresh != nil && *p.Fresh
	a.mu.Lock()
	age := time.Since(a.checked)
	start := !a.busy && (age > activityEvery || (fresh && age > 5*time.Second))
	if start {
		a.busy = true
	}
	a.mu.Unlock()
	if start {
		done := make(chan struct{})
		go func() {
			defer close(done)
			bg, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			h.refreshActivity(bg)
		}()
		if fresh {
			select { // a fresh answer is worth a short wait
			case <-done:
			case <-time.After(20 * time.Second):
			}
		}
	}
	a.mu.Lock()
	items := append([]ActivityItem(nil), a.items...)
	checked, targets := a.checked, a.targets
	a.mu.Unlock()

	out := []ActivityItem{}
	if h.access != nil {
		sub := acc.Subject(localmid.PrincipalFrom(ctx))
		pctx := acc.RequestContext(r)
		for _, it := range items {
			if h.access.Can(ctx, sub, policy.BackupRun, it.clusterID, pctx).Allowed {
				out = append(out, it)
			}
		}
	} else {
		out = items
	}
	return ops.NewGetBackupsActivityOK().WithPayload(map[string]any{"items": out, "checked_at": checked, "targets": targets})
}
