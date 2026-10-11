// Package upgrade: the Upgrades panel's API - plan (dry run), run and roll back package upgrades of a cluster's
// components (PostgreSQL minor, Patroni, etcd, HAProxy, PgBouncer, ...). Each action runs the automation
// container with the cluster's inventory; the playbook (automation-ha/upgrade) does one node at a time and keeps
// the installed versions so a rollback can put them back.
package upgrade

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"postgresql-cluster-console/internal/configuration"
	"postgresql-cluster-console/internal/controllers"
	clusterctl "postgresql-cluster-console/internal/controllers/cluster"
	"postgresql-cluster-console/internal/storage"
	"postgresql-cluster-console/internal/watcher"
	"postgresql-cluster-console/internal/xdocker"
	localmid "postgresql-cluster-console/middleware"
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

// view: an upgrade as the API returns it
func view(u *storage.Upgrade) map[string]any {
	var opts, res any
	_ = json.Unmarshal(u.Options, &opts)
	_ = json.Unmarshal(u.Result, &res)
	return map[string]any{"id": u.ID, "cluster_id": u.ClusterID, "component": u.Component, "action": u.Action, "status": u.Status,
		"parent_id": u.ParentID, "operation_id": u.OperationID, "options": opts, "result": res, "created_by": u.CreatedBy,
		"created_at": u.CreatedAt, "finished_at": u.FinishedAt}
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

/* ------------------------------------------------------------ GET /clusters/{id}/upgrades[/{uid}] */

type listHandler struct{ db storage.IStorage }

func NewGetClustersIDUpgradesHandler(db storage.IStorage) ops.GetClustersIDUpgradesHandler {
	return &listHandler{db: db}
}

func (h *listHandler) Handle(p ops.GetClustersIDUpgradesParams) middleware.Responder {
	list, err := h.db.ListUpgrades(p.HTTPRequest.Context(), p.ID, 100)
	if err != nil {
		return ops.NewGetClustersIDUpgradesBadRequest().WithPayload(controllers.MakeErrorPayload(err, controllers.BaseError))
	}
	out := make([]any, 0, len(list))
	for i := range list {
		out = append(out, view(&list[i]))
	}
	return ops.NewGetClustersIDUpgradesOK().WithPayload(out)
}

type getHandler struct{ db storage.IStorage }

func NewGetClustersIDUpgradesUIDHandler(db storage.IStorage) ops.GetClustersIDUpgradesUIDHandler {
	return &getHandler{db: db}
}

func (h *getHandler) Handle(p ops.GetClustersIDUpgradesUIDParams) middleware.Responder {
	u, err := h.db.GetUpgrade(p.HTTPRequest.Context(), p.UID)
	if err == nil && (u == nil || u.ClusterID != p.ID) {
		err = errors.New("not found")
	}
	if err != nil {
		return ops.NewGetClustersIDUpgradesUIDBadRequest().WithPayload(controllers.MakeErrorPayload(err, controllers.BaseError))
	}
	return ops.NewGetClustersIDUpgradesUIDOK().WithPayload(view(u))
}

/* ------------------------------------------------------------ POST /clusters/{id}/upgrades */

type startHandler struct {
	db     storage.IStorage
	docker xdocker.IManager
	logs   watcher.LogCollector
	cfg    *configuration.Config
}

func NewPostClustersIDUpgradesHandler(db storage.IStorage, docker xdocker.IManager, logs watcher.LogCollector, cfg *configuration.Config) ops.PostClustersIDUpgradesHandler {
	return &startHandler{db: db, docker: docker, logs: logs, cfg: cfg}
}

// options: what the playbook gets (and what is stored - never the SSH secrets)
type options struct {
	Target        string   `json:"target,omitempty"`
	AllowUnsaved  bool     `json:"allow_unsaved,omitempty"`
	RestoreConfig bool     `json:"restore_config,omitempty"`
	BinaryURL     string   `json:"binary_url,omitempty"`
	Hosts         []string `json:"hosts,omitempty"`
}

func (h *startHandler) Handle(p ops.PostClustersIDUpgradesParams) middleware.Responder {
	ctx := p.HTTPRequest.Context()
	bad := func(err error) middleware.Responder {
		return ops.NewPostClustersIDUpgradesBadRequest().WithPayload(controllers.MakeErrorPayload(err, controllers.BaseError))
	}
	b := p.Body
	if b == nil {
		return bad(errors.New("body required"))
	}
	compName, action := "", ""
	if b.Component != nil {
		compName = *b.Component
	}
	if b.Action != nil {
		action = *b.Action
	}
	if component(compName) == nil {
		return bad(fmt.Errorf("unknown component %q", compName))
	}
	switch action {
	case "plan", "run", "rollback":
	default:
		return bad(errors.New("action must be plan, run or rollback"))
	}
	cl, err := h.db.GetCluster(ctx, p.ID)
	if err != nil || cl == nil {
		return bad(fmt.Errorf("cluster %d not found", p.ID))
	}
	if len(cl.Inventory) == 0 || string(cl.Inventory) == "null" {
		return bad(errors.New("this cluster has no inventory in the console (deploy or import it with one first)"))
	}
	list, err := h.db.ListUpgrades(ctx, p.ID, 20)
	if err != nil {
		return bad(err)
	}
	for _, u := range list {
		if u.Status == "running" {
			return bad(fmt.Errorf("upgrade #%d (%s %s) is still running on this cluster", u.ID, u.Action, u.Component))
		}
	}

	opt := options{Target: strings.TrimSpace(b.Target), AllowUnsaved: b.AllowUnsaved, RestoreConfig: b.RestoreConfig,
		BinaryURL: strings.TrimSpace(b.BinaryURL), Hosts: b.Hosts}
	var parentID *int64
	runID := int64(0)
	if action != "plan" {
		if b.ParentID == 0 {
			return bad(errors.New("parent_id is required: a run follows a plan, a rollback follows a run"))
		}
		parent, err := h.db.GetUpgrade(ctx, b.ParentID)
		if err != nil || parent == nil || parent.ClusterID != p.ID || parent.Component != compName {
			return bad(errors.New("parent upgrade not found for this cluster and component"))
		}
		want := map[string]string{"run": "plan", "rollback": "run"}[action]
		if parent.Action != want {
			return bad(fmt.Errorf("a %s follows a %s (#%d is a %s)", action, want, parent.ID, parent.Action))
		}
		if action == "run" && parent.Status != "success" {
			return bad(errors.New("the plan did not finish successfully: run the dry run again"))
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
		if action == "rollback" {
			runID = parent.ID
		}
		parentID = &parent.ID
	}
	if opt.BinaryURL != "" && !strings.HasPrefix(opt.BinaryURL, "https://") && !strings.HasPrefix(opt.BinaryURL, "http://") {
		return bad(errors.New("the download address must start with http:// or https://"))
	}

	// SSH: the login given now, else the cluster's stored secret
	envs := []string{}
	extra := map[string]any{}
	if u := strings.TrimSpace(b.SSHUser); u != "" {
		extra["ansible_user"] = u
		if b.SSHKey != "" {
			envs = append(envs, "SSH_PRIVATE_KEY_CONTENT="+base64.StdEncoding.EncodeToString([]byte(strings.TrimSpace(b.SSHKey)+"\n")))
		}
		if b.SSHPassword != "" {
			extra["ansible_ssh_pass"] = b.SSHPassword
			extra["ansible_sudo_pass"] = b.SSHPassword
		}
	} else if cl.SecretID != nil {
		senv, asExtra, err := clusterctl.SecretEnvs(ctx, h.db, *cl.SecretID, h.cfg.EncryptionKey, cl.ProjectID)
		if err != nil {
			return bad(fmt.Errorf("the cluster's SSH secret: %w", err))
		}
		for _, kv := range senv {
			if asExtra {
				if k, v, ok := strings.Cut(kv, "="); ok {
					extra[k] = v
				}
			} else {
				envs = append(envs, kv)
			}
		}
	} else {
		return bad(errors.New("no SSH login: this cluster has no stored secret, so give the SSH user and password or key"))
	}

	by := ""
	if pr := localmid.PrincipalFrom(ctx); pr != nil {
		by = pr.Username
	}
	optJSON, _ := json.Marshal(opt)
	up, err := h.db.CreateUpgrade(ctx, &storage.Upgrade{ClusterID: p.ID, Component: compName, Action: action,
		ParentID: parentID, Options: optJSON, CreatedBy: by})
	if err != nil {
		return bad(err)
	}
	if runID == 0 {
		runID = up.ID
	}
	fail := func(err error) middleware.Responder {
		_ = h.db.FinishUpgrade(ctx, up.ID, "failed", []byte(fmt.Sprintf(`[{"error": %q}]`, err.Error())))
		return bad(err)
	}

	pgm := map[string]any{"id": up.ID, "action": action, "component": compName, "run_id": runID, "target": opt.Target,
		"allow_unsaved": opt.AllowUnsaved, "restore_config": opt.RestoreConfig, "binary_url": opt.BinaryURL, "hosts": opt.Hosts}
	extra["pgm"] = pgm
	extraJSON, _ := json.Marshal(extra)
	envs = append(envs,
		"ANSIBLE_INVENTORY_JSON="+base64.StdEncoding.EncodeToString(cl.Inventory),
		fmt.Sprintf("ANSIBLE_JSON_LOG_FILE=%s/upgrade-%d.json", ansibleLogDir, up.ID))

	dockerID, err := h.docker.ManageCluster(ctx, &xdocker.ManageClusterConfig{Envs: envs, ExtraVars: string(extraJSON),
		Mounts: []xdocker.Mount{{DockerPath: ansibleLogDir, HostPath: h.cfg.Docker.LogDir}}})
	if err != nil {
		return fail(fmt.Errorf("could not start the automation container: %w", err))
	}
	cid, _ := ctx.Value(tracer.CtxCidKey{}).(string)
	op, err := h.db.CreateOperation(ctx, &storage.CreateOperationReq{ProjectID: cl.ProjectID, ClusterID: cl.ID,
		DockerCode: string(dockerID), Type: storage.OperationTypeUpgrade, Cid: cid})
	if err != nil {
		return fail(err)
	}
	_ = h.db.SetUpgradeOperation(ctx, up.ID, op.ID)
	up.OperationID = &op.ID
	h.logs.StoreInDb(op.ID, dockerID, cid)
	return ops.NewPostClustersIDUpgradesOK().WithPayload(view(up))
}

const ansibleLogDir = "/tmp/ansible"
