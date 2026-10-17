// Package upgrade: the Upgrades panel's API - plan (dry run), run and roll back package upgrades of the components
// of a setup (PostgreSQL minor, Patroni, etcd, HAProxy, PgBouncer, ...). The setup is a cluster in the console
// (its inventory) or any setup found by Discover (the machines and components it found). Each action runs the
// upgrade runner container (automation-ha/upgrade: plain Ansible); the playbook does one node at a time and keeps
// the installed versions so a rollback can put them back.
package upgrade

import (
	acc "postgresql-cluster-console/internal/access"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"postgresql-cluster-console/internal/configuration"
	"postgresql-cluster-console/internal/controllers"
	clusterctl "postgresql-cluster-console/internal/controllers/cluster"
	"postgresql-cluster-console/internal/storage"
	"postgresql-cluster-console/internal/xdocker"
	localmid "postgresql-cluster-console/middleware"
	"postgresql-cluster-console/models"
	"postgresql-cluster-console/pkg/tracer"
	ops "postgresql-cluster-console/restapi/operations/upgrade"

	"github.com/go-openapi/runtime/middleware"
)

// Component is what the panel offers (mirrors automation-ha/upgrade/components.yml).
type Component struct {
	Name    string   `json:"name"`
	Label   string   `json:"label"`
	Groups  []string `json:"groups"`
	Order   string   `json:"order"` // one_by_one | replicas_first
	Restart string   `json:"restart"`
	Notes   []string `json:"notes"`
}

var Components = []Component{
	{"postgres", "PostgreSQL (minor version)", []string{"patroni_cluster"}, "replicas_first", "PostgreSQL restarted through Patroni",
		[]string{"Only minor versions (same major): a major upgrade needs pg_upgrade.", "Standbys first, then a switchover, then the old primary.", "Each node is restarted once: its connections are cut for a few seconds."}},
	{"patroni", "Patroni", []string{"patroni_cluster"}, "replicas_first", "Patroni service (cluster paused, PostgreSQL keeps running)",
		[]string{"Patroni is paused while each node restarts, so no failover can happen.", "Installed by pip on some setups: the version comes from the package index."}},
	{"etcd", "etcd", []string{"etcd_cluster"}, "one_by_one", "etcd service, then 'endpoint health'",
		[]string{"One member at a time; the cluster keeps its quorum.", "Plain binaries (CPA / Autobase): give the target version; the file is downloaded on the node (or from your mirror)."}},
	{"haproxy", "HAProxy", []string{"haproxy_cluster"}, "one_by_one", "haproxy service", []string{"With more than one balancer and a VIP, clients move to the other one."}},
	{"keepalived", "keepalived", []string{"haproxy_cluster"}, "one_by_one", "keepalived service", []string{"The VIP may move while a node restarts."}},
	{"pgbouncer", "PgBouncer", []string{"pgbouncer_cluster"}, "one_by_one", "pgbouncer service", []string{"Client connections through this PgBouncer are cut when it restarts."}},
	{"pgbackrest", "pgBackRest", []string{"backrest_cluster", "patroni_cluster"}, "one_by_one", "nothing to restart", []string{"Do not run while a backup is running."}},
	{"vip-manager", "vip-manager", []string{"patroni_cluster"}, "one_by_one", "vip-manager service", nil},
	{"node_exporter", "node_exporter", []string{"all"}, "one_by_one", "exporter service", nil},
	{"postgres_exporter", "postgres_exporter", []string{"patroni_cluster"}, "one_by_one", "exporter service", nil},
	{"prometheus", "Prometheus", []string{"prometheus_cluster"}, "one_by_one", "prometheus service", nil},
	{"alertmanager", "Alertmanager", []string{"alertmanager_cluster"}, "one_by_one", "alertmanager service", nil},
	{"grafana", "Grafana", []string{"grafana_cluster"}, "one_by_one", "grafana service", nil},
}

func component(name string) *Component {
	for i := range Components {
		if Components[i].Name == name {
			return &Components[i]
		}
	}
	return nil
}

// view: an upgrade as the API returns it (with its log when withLog)
func view(u *storage.Upgrade, withLog bool) map[string]any {
	var opts, res any
	_ = json.Unmarshal(u.Options, &opts)
	_ = json.Unmarshal(u.Result, &res)
	out := map[string]any{"id": u.ID, "cluster_id": u.ClusterID, "discovery_id": u.DiscoveryID, "component": u.Component,
		"action": u.Action, "status": u.Status, "parent_id": u.ParentID, "options": opts, "result": res,
		"created_by": u.CreatedBy, "created_at": u.CreatedAt, "finished_at": u.FinishedAt}
	if withLog {
		out["log"] = u.Log
	}
	return out
}

func badPayload(err error) *ops.GetClustersIDUpgradesBadRequest {
	return ops.NewGetClustersIDUpgradesBadRequest().WithPayload(controllers.MakeErrorPayload(err, controllers.BaseError))
}

/* ------------------------------------------------------------ GET /upgrade/components */

type componentsHandler struct{}

func NewGetUpgradeComponentsHandler() ops.GetUpgradeComponentsHandler { return componentsHandler{} }

func (componentsHandler) Handle(ops.GetUpgradeComponentsParams) middleware.Responder {
	out := make([]any, 0, len(Components))
	for _, c := range Components {
		out = append(out, c)
	}
	return ops.NewGetUpgradeComponentsOK().WithPayload(out)
}

/* ------------------------------------------------------------ lists and one upgrade */

type Handlers struct {
	db     storage.IStorage
	docker xdocker.IManager
	cfg    *configuration.Config
	access *acc.Service
	act    *activity
}

func New(db storage.IStorage, docker xdocker.IManager, cfg *configuration.Config) *Handlers {
	return &Handlers{db: db, docker: docker, cfg: cfg, act: newActivity()}
}

func (h *Handlers) list(ctx context.Context, clusterID, discoveryID int64) ([]any, error) {
	list, err := h.db.ListUpgrades(ctx, clusterID, discoveryID, 100)
	if err != nil {
		return nil, err
	}
	out := make([]any, 0, len(list))
	for i := range list {
		out = append(out, view(&list[i], false))
	}
	return out, nil
}

func (h *Handlers) one(ctx context.Context, uid, clusterID, discoveryID int64) (map[string]any, error) {
	u, err := h.db.GetUpgrade(ctx, uid)
	if err != nil {
		return nil, err
	}
	if u == nil || (clusterID != 0 && (u.ClusterID == nil || *u.ClusterID != clusterID)) ||
		(discoveryID != 0 && (u.DiscoveryID == nil || *u.DiscoveryID != discoveryID)) {
		return nil, errors.New("not found")
	}
	return view(u, true), nil
}

type fn func(ctx context.Context) (any, error)

func respond(ctx context.Context, f fn, ok func(any) middleware.Responder) middleware.Responder {
	v, err := f(ctx)
	if err != nil {
		return badPayload(err)
	}
	return ok(v)
}

// cluster endpoints
type clusterList struct{ *Handlers }
type clusterOne struct{ *Handlers }
type clusterStart struct{ *Handlers }

func (h *Handlers) ClusterList() ops.GetClustersIDUpgradesHandler   { return clusterList{h} }
func (h *Handlers) ClusterOne() ops.GetClustersIDUpgradesUIDHandler { return clusterOne{h} }
func (h *Handlers) ClusterStart() ops.PostClustersIDUpgradesHandler { return clusterStart{h} }

func (h clusterList) Handle(p ops.GetClustersIDUpgradesParams) middleware.Responder {
	return respond(p.HTTPRequest.Context(), func(ctx context.Context) (any, error) { return h.list(ctx, p.ID, 0) },
		func(v any) middleware.Responder { return ops.NewGetClustersIDUpgradesOK().WithPayload(v.([]any)) })
}

func (h clusterOne) Handle(p ops.GetClustersIDUpgradesUIDParams) middleware.Responder {
	return respond(p.HTTPRequest.Context(), func(ctx context.Context) (any, error) { return h.one(ctx, p.UID, p.ID, 0) },
		func(v any) middleware.Responder { return ops.NewGetClustersIDUpgradesUIDOK().WithPayload(v) })
}

func (h clusterStart) Handle(p ops.PostClustersIDUpgradesParams) middleware.Responder {
	ctx := p.HTTPRequest.Context()
	t, err := h.clusterTarget(ctx, p.ID)
	if err != nil {
		return badPayload(err)
	}
	return respond(ctx, func(ctx context.Context) (any, error) { return h.start(ctx, t, p.Body) },
		func(v any) middleware.Responder { return ops.NewPostClustersIDUpgradesOK().WithPayload(v) })
}

// discovery endpoints
type discoveryList struct{ *Handlers }
type discoveryOne struct{ *Handlers }
type discoveryStart struct{ *Handlers }

func (h *Handlers) DiscoveryList() ops.GetDiscoveriesIDUpgradesHandler   { return discoveryList{h} }
func (h *Handlers) DiscoveryOne() ops.GetDiscoveriesIDUpgradesUIDHandler { return discoveryOne{h} }
func (h *Handlers) DiscoveryStart() ops.PostDiscoveriesIDUpgradesHandler { return discoveryStart{h} }

func (h discoveryList) Handle(p ops.GetDiscoveriesIDUpgradesParams) middleware.Responder {
	return respond(p.HTTPRequest.Context(), func(ctx context.Context) (any, error) { return h.list(ctx, 0, p.ID) },
		func(v any) middleware.Responder { return ops.NewGetDiscoveriesIDUpgradesOK().WithPayload(v.([]any)) })
}

func (h discoveryOne) Handle(p ops.GetDiscoveriesIDUpgradesUIDParams) middleware.Responder {
	return respond(p.HTTPRequest.Context(), func(ctx context.Context) (any, error) { return h.one(ctx, p.UID, 0, p.ID) },
		func(v any) middleware.Responder { return ops.NewGetDiscoveriesIDUpgradesUIDOK().WithPayload(v) })
}

func (h discoveryStart) Handle(p ops.PostDiscoveriesIDUpgradesParams) middleware.Responder {
	ctx := p.HTTPRequest.Context()
	t, err := h.discoveryTarget(ctx, p.ID)
	if err != nil {
		return badPayload(err)
	}
	return respond(ctx, func(ctx context.Context) (any, error) { return h.start(ctx, t, p.Body) },
		func(v any) middleware.Responder { return ops.NewPostDiscoveriesIDUpgradesOK().WithPayload(v) })
}

/* ------------------------------------------------------------ targets */

// target: what an upgrade runs on - an inventory, and maybe a stored SSH secret
type target struct {
	clusterID, discoveryID int64
	projectID              int64
	secretID               *int64
	inventory              []byte
}

func (h *Handlers) clusterTarget(ctx context.Context, id int64) (*target, error) {
	cl, err := h.db.GetCluster(ctx, id)
	if err != nil || cl == nil {
		return nil, fmt.Errorf("cluster %d not found", id)
	}
	if len(cl.Inventory) == 0 || string(cl.Inventory) == "null" {
		return nil, errors.New("this cluster has no inventory in the console: run Discover on it and upgrade from the saved discovery")
	}
	return &target{clusterID: id, projectID: cl.ProjectID, secretID: cl.SecretID, inventory: cl.Inventory}, nil
}

// discoveryTarget: the inventory of a setup found by Discover - one group pgm_<component> per component, with the
// machines where it was found (any setup, whoever built it).
func (h *Handlers) discoveryTarget(ctx context.Context, id int64) (*target, error) {
	d, err := h.db.GetDiscovery(ctx, id)
	if err != nil || d == nil {
		return nil, fmt.Errorf("saved discovery %d not found", id)
	}
	inv, err := InventoryFromDiscovery(d.Result)
	if err != nil {
		return nil, err
	}
	return &target{discoveryID: id, inventory: inv}, nil
}

// InventoryFromDiscovery turns a Discover result into an Ansible inventory (JSON), with the components the built-in
// upgrades know.
func InventoryFromDiscovery(result []byte) ([]byte, error) {
	return inventoryFromDiscovery(result, false)
}

// inventoryFromDiscovery: every component (anyKind) or only those the built-in upgrades know; every machine is in all.
func inventoryFromDiscovery(result []byte, anyKind bool) ([]byte, error) {
	var r struct {
		Infra *struct {
			Hosts []struct {
				Address    string `json:"address"`
				Name       string `json:"name"`
				Components []struct {
					Kind    string   `json:"kind"`
					Sources []string `json:"sources"`
				} `json:"components"`
			} `json:"hosts"`
		} `json:"infra"`
	}
	if err := json.Unmarshal(result, &r); err != nil {
		return nil, err
	}
	if r.Infra == nil || len(r.Infra.Hosts) == 0 {
		return nil, errors.New("this discovery has no machines: run Discover again (with SSH) and save it")
	}
	children := map[string]map[string]any{}
	all := map[string]any{}
	for _, h := range r.Infra.Hosts {
		all[h.Address] = map[string]any{}
		for _, c := range h.Components {
			if c.Kind == "docker" || c.Kind == "podman" || (!anyKind && component(c.Kind) == nil) {
				continue
			}
			g := "pgm_" + strings.ReplaceAll(c.Kind, "-", "_")
			if children[g] == nil {
				children[g] = map[string]any{"hosts": map[string]any{}}
			}
			hv := map[string]any{}
			if h.Name != "" && h.Name != h.Address {
				hv["hostname"] = h.Name
			}
			children[g]["hosts"].(map[string]any)[h.Address] = hv
		}
	}
	if len(children) == 0 && !anyKind {
		return nil, errors.New("Discover found no upgradable component in this setup")
	}
	inv := map[string]any{"children": children}
	if anyKind {
		inv["hosts"] = all
	}
	return json.Marshal(map[string]any{"all": inv})
}

/* ------------------------------------------------------------ start */

// options: what the playbook gets (and what is stored - never the SSH secrets)
type options struct {
	Target        string   `json:"target,omitempty"`
	AllowUnsaved  bool     `json:"allow_unsaved,omitempty"`
	RestoreConfig bool     `json:"restore_config,omitempty"`
	BinaryURL     string   `json:"binary_url,omitempty"`
	Hosts         []string `json:"hosts,omitempty"`
	Repo          *repo    `json:"repo,omitempty"`
}

type repo struct {
	URL      string `json:"url"`
	Only     bool   `json:"only,omitempty"`
	GPGCheck bool   `json:"gpgcheck,omitempty"`
	GPGKey   string `json:"gpgkey,omitempty"`
}

func (h *Handlers) start(ctx context.Context, t *target, b *models.RequestUpgrade) (any, error) {
	if b == nil || b.Component == nil || b.Action == nil {
		return nil, errors.New("component and action are required")
	}
	compName, action := *b.Component, *b.Action
	if component(compName) == nil {
		return nil, fmt.Errorf("unknown component %q", compName)
	}
	switch action {
	case "plan", "run", "rollback":
	default:
		return nil, errors.New("action must be plan, run or rollback")
	}
	list, err := h.db.ListUpgrades(ctx, t.clusterID, t.discoveryID, 20)
	if err != nil {
		return nil, err
	}
	for _, u := range list {
		if u.Status == "running" {
			return nil, fmt.Errorf("upgrade #%d (%s %s) is still running on this setup", u.ID, u.Action, u.Component)
		}
	}

	opt := options{Target: strings.TrimSpace(b.Target), AllowUnsaved: b.AllowUnsaved, RestoreConfig: b.RestoreConfig,
		BinaryURL: strings.TrimSpace(b.BinaryURL), Hosts: b.Hosts}
	if u := strings.TrimSpace(b.RepoURL); u != "" {
		opt.Repo = &repo{URL: u, Only: b.RepoOnly, GPGCheck: b.RepoGpgcheck, GPGKey: strings.TrimSpace(b.RepoGpgkey)}
	}
	var parentID *int64
	runID := int64(0)
	if action != "plan" {
		if b.ParentID == 0 {
			return nil, errors.New("parent_id is required: a run follows a plan, a rollback follows a run")
		}
		parent, err := h.db.GetUpgrade(ctx, b.ParentID)
		same := parent != nil && parent.Component == compName &&
			(t.clusterID != 0 && parent.ClusterID != nil && *parent.ClusterID == t.clusterID ||
				t.discoveryID != 0 && parent.DiscoveryID != nil && *parent.DiscoveryID == t.discoveryID)
		if err != nil || !same {
			return nil, errors.New("parent upgrade not found for this setup and component")
		}
		want := map[string]string{"run": "plan", "rollback": "run"}[action]
		if parent.Action != want {
			return nil, fmt.Errorf("a %s follows a %s (#%d is a %s)", action, want, parent.ID, parent.Action)
		}
		if action == "run" && parent.Status != "success" {
			return nil, errors.New("the dry run did not finish successfully: run it again")
		}
		var po options
		_ = json.Unmarshal(parent.Options, &po)
		if opt.Target == "" {
			opt.Target = po.Target
		}
		if opt.BinaryURL == "" {
			opt.BinaryURL = po.BinaryURL
		}
		if len(opt.Hosts) == 0 {
			opt.Hosts = po.Hosts
		}
		if opt.Repo == nil {
			opt.Repo = po.Repo // the same packages as in the dry run
		}
		if action == "rollback" {
			runID = parent.ID
		}
		parentID = &parent.ID
	}
	for _, u := range []string{opt.BinaryURL, func() string {
		if opt.Repo != nil && !strings.HasPrefix(opt.Repo.URL, "deb ") {
			return opt.Repo.URL
		}
		return ""
	}()} {
		if u != "" && !strings.HasPrefix(u, "https://") && !strings.HasPrefix(u, "http://") && !strings.HasPrefix(u, "file://") {
			return nil, fmt.Errorf("%q: an address must start with http://, https:// or file://", u)
		}
	}

	// SSH: the login given now, else the cluster's stored secret
	envs := []string{}
	extra := map[string]any{}
	if u := strings.TrimSpace(b.SSHUser); u != "" {
		extra["ansible_user"] = u
		if b.SSHPort > 0 {
			extra["ansible_port"] = b.SSHPort
		}
		if b.SSHKey != "" {
			envs = append(envs, "SSH_PRIVATE_KEY_CONTENT="+base64.StdEncoding.EncodeToString([]byte(strings.TrimSpace(b.SSHKey)+"\n")))
		}
		if b.SSHPassword != "" {
			extra["ansible_ssh_pass"] = b.SSHPassword
			extra["ansible_become_pass"] = b.SSHPassword
		}
	} else if t.secretID != nil {
		senv, asExtra, err := clusterctl.SecretEnvs(ctx, h.db, *t.secretID, h.cfg.EncryptionKey, t.projectID)
		if err != nil {
			return nil, fmt.Errorf("the cluster's SSH secret: %w", err)
		}
		for _, kv := range senv {
			if k, v, ok := strings.Cut(kv, "="); ok && asExtra {
				extra[k] = v
			} else if !asExtra {
				envs = append(envs, kv)
			}
		}
	} else {
		return nil, errors.New("give the SSH user and password or key (used for this run only)")
	}

	by := ""
	if pr := localmid.PrincipalFrom(ctx); pr != nil {
		by = pr.Username
	}
	optJSON, _ := json.Marshal(opt)
	nz := func(v int64) *int64 {
		if v == 0 {
			return nil
		}
		return &v
	}
	up, err := h.db.CreateUpgrade(ctx, &storage.Upgrade{ClusterID: nz(t.clusterID), DiscoveryID: nz(t.discoveryID),
		Component: compName, Action: action, ParentID: parentID, Options: optJSON, CreatedBy: by})
	if err != nil {
		return nil, err
	}
	if runID == 0 {
		runID = up.ID
	}
	failed := func(err error) (any, error) {
		_ = h.db.FinishUpgrade(ctx, up.ID, "failed", []byte(fmt.Sprintf(`[{"error": %q}]`, err.Error())))
		return nil, err
	}

	extra["pgm"] = map[string]any{"id": up.ID, "action": action, "component": compName, "run_id": runID, "target": opt.Target,
		"allow_unsaved": opt.AllowUnsaved, "restore_config": opt.RestoreConfig, "binary_url": opt.BinaryURL, "hosts": opt.Hosts,
		"repo": opt.Repo}
	extraJSON, _ := json.Marshal(extra)
	envs = append(envs,
		"ANSIBLE_INVENTORY_JSON="+base64.StdEncoding.EncodeToString(t.inventory),
		fmt.Sprintf("ANSIBLE_JSON_LOG_FILE=%s/upgrade-%d.json", ansibleLogDir, up.ID), "ANSIBLE_NOCOLOR=1", "ANSIBLE_FORCE_COLOR=0",
		"ANSIBLE_HOST_PATTERN_MISMATCH=ignore", "ANSIBLE_LOCALHOST_WARNING=False")
	dockerID, err := h.docker.ManageCluster(ctx, &xdocker.ManageClusterConfig{Image: h.cfg.Docker.UpgradeImage, Envs: envs,
		ExtraVars: string(extraJSON), Mounts: []xdocker.Mount{{DockerPath: ansibleLogDir, HostPath: h.cfg.Docker.LogDir}}})
	if err != nil {
		return failed(fmt.Errorf("could not start the upgrade runner (%s - built by ./build.sh console): %w", h.cfg.Docker.UpgradeImage, err))
	}
	_ = h.db.SetUpgradeDocker(ctx, up.ID, string(dockerID))

	// the runner's output, line by line, into the upgrade's log (the watcher finishes the upgrade)
	cid, _ := ctx.Value(tracer.CtxCidKey{}).(string)
	lctx := context.WithValue(context.Background(), tracer.CtxCidKey{}, cid)
	go h.docker.StoreContainerLogs(lctx, dockerID, func(line string) { _ = h.db.AppendUpgradeLog(lctx, up.ID, line) })
	return view(up, false), nil
}

const ansibleLogDir = "/tmp/ansible"
