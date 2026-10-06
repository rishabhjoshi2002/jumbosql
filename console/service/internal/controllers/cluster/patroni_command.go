package cluster

// JumboSQL: POST /clusters/{id}/patroni - patronictl-equivalent commands through the Patroni REST API.
//
//   list         patronictl list                 GET   /cluster
//   history      patronictl history              GET   /history
//   show-config  patronictl show-config          GET   /config
//   edit-config  patronictl edit-config          PATCH /config      (partial config is merged)
//   pause        patronictl pause                PATCH /config      {"pause": true}
//   resume       patronictl resume               PATCH /config      {"pause": false}
//   switchover   patronictl switchover           POST  /switchover  (leader from /cluster, candidate optional)
//   failover     patronictl failover             POST  /failover    (candidate required; works without a leader)
//   restart      patronictl restart <cl> [m]     POST  /restart     on the member, or on every member in turn
//   reinit       patronictl reinit <cl> <m>      POST  /reinitialize on a replica
//   reload       patronictl reload <cl> [m]      POST  /reload      on the member, or on every member

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	acc "postgresql-cluster-console/internal/access"
	"postgresql-cluster-console/internal/controllers"
	"postgresql-cluster-console/internal/policy"
	"postgresql-cluster-console/internal/storage"
	"postgresql-cluster-console/internal/watcher"
	"postgresql-cluster-console/models"
	"postgresql-cluster-console/pkg/patroni"
	"postgresql-cluster-console/restapi/operations/cluster"

	"github.com/go-openapi/runtime/middleware"
	"github.com/rs/zerolog"
)

type patroniCommandHandler struct {
	*patroniHandlers
	access *acc.Service
}

// The route needs patroni.read; commands that change something also need patroni.manage on the cluster.
func NewPostClusterPatroniHandler(db storage.IStorage, log zerolog.Logger, actions patroni.IActions, cw watcher.ClusterWatcher, a *acc.Service) cluster.PostClustersIDPatroniHandler {
	return &patroniCommandHandler{newPatroniHandlers(db, log, actions, cw), a}
}

// mutating commands refresh the console's view of the cluster afterwards
var mutatingCommands = map[string]bool{
	"edit-config": true, "pause": true, "resume": true, "switchover": true, "failover": true,
	"restart": true, "reinit": true, "reload": true,
}

func (h *patroniCommandHandler) Handle(param cluster.PostClustersIDPatroniParams) middleware.Responder {
	ctx := param.HTTPRequest.Context()
	localLog := h.logger(ctx)
	command := ""
	if param.Body != nil && param.Body.Command != nil {
		command = *param.Body.Command
	}
	// list, history and show-config need patroni.read (checked for the route); the rest need patroni.manage
	if mutatingCommands[command] && h.access != nil {
		if d := h.access.Allows(param.HTTPRequest, policy.PatroniManage, param.ID); !d.Allowed {
			return h.fail(param, command, errors.New("you need patroni.manage on this cluster for "+command+" ("+d.Reason+")"))
		}
	}

	cl, err := h.db.GetCluster(ctx, param.ID)
	if err != nil || cl == nil {
		return h.fail(param, command, errors.New("cluster not found"))
	}
	servers, err := h.db.GetClusterServers(ctx, param.ID)
	if err != nil {
		return h.fail(param, command, err)
	}
	info, err := h.actions.GetCluster(ctx, clusterHosts(servers))
	if err != nil {
		return h.fail(param, command, err)
	}

	res, err := h.run(ctx, cl.Name, info, param.Body)
	if err != nil {
		return h.fail(param, command, err)
	}
	localLog.Info().Int64("cluster_id", param.ID).Str("command", res.Command).Msg("patroni command done")
	if mutatingCommands[command] {
		h.refresh(ctx, param.ID)
	}
	return cluster.NewPostClustersIDPatroniOK().WithPayload(res)
}

func (h *patroniCommandHandler) fail(param cluster.PostClustersIDPatroniParams, command string, err error) middleware.Responder {
	l := h.logger(param.HTTPRequest.Context())
	l.Warn().Err(err).Int64("cluster_id", param.ID).Str("command", command).Msg("patroni command failed")
	return cluster.NewPostClustersIDPatroniBadRequest().WithPayload(controllers.MakeErrorPayload(err, controllers.BaseError))
}

func memberHost(info *patroni.ClusterInfo, name string) (string, string, bool) {
	for _, m := range info.Members {
		if m.Name == name {
			return m.Host, m.Role, true
		}
	}
	return "", "", false
}

func (h *patroniCommandHandler) run(ctx context.Context, clusterName string, info *patroni.ClusterInfo, req *models.RequestPatroniCommand) (*models.ResponsePatroniCommand, error) {
	command, member, candidate := *req.Command, strings.TrimSpace(req.Member), strings.TrimSpace(req.Candidate)
	leaderName, leaderHost, hasLeader := leaderOf(info)
	anyHost := leaderHost
	if anyHost == "" && len(info.Members) > 0 {
		anyHost = info.Members[0].Host
	}
	res := &models.ResponsePatroniCommand{}
	cmd := func(format string, a ...interface{}) { res.Command = "patronictl " + fmt.Sprintf(format, a...) }

	switch command {
	case "list":
		cmd("list %s", clusterName)
		res.Data = info
		res.Message = fmt.Sprintf("%d members", len(info.Members))

	case "history", "show-config":
		path := map[string]string{"history": "/history", "show-config": "/config"}[command]
		cmd("%s %s", command, clusterName)
		data, err := h.actions.Raw(ctx, http.MethodGet, anyHost, path, nil)
		if err != nil {
			return nil, err
		}
		res.Data = data

	case "edit-config", "pause", "resume":
		var patch interface{}
		switch command {
		case "edit-config":
			if req.Config == nil {
				return nil, errors.New("edit-config needs the settings to change")
			}
			patch = req.Config
			cmd("edit-config %s", clusterName)
		case "pause":
			patch = map[string]bool{"pause": true}
			cmd("pause %s", clusterName)
		default:
			patch = map[string]bool{"pause": false}
			cmd("resume %s", clusterName)
		}
		data, err := h.actions.Raw(ctx, http.MethodPatch, anyHost, "/config", patch)
		if err != nil {
			return nil, err
		}
		res.Data = data
		res.Message = map[string]string{
			"edit-config": "configuration updated",
			"pause":       "maintenance mode on: Patroni will not fail over automatically",
			"resume":      "maintenance mode off: automatic failover is active again",
		}[command]

	case "switchover":
		if !hasLeader {
			return nil, errors.New("no leader right now; use failover")
		}
		if candidate != "" {
			if _, role, ok := memberHost(info, candidate); !ok {
				return nil, fmt.Errorf("%s is not a member", candidate)
			} else if role == "leader" {
				return nil, fmt.Errorf("%s is already the leader", candidate)
			}
			cmd("switchover %s --leader %s --candidate %s --force", clusterName, leaderName, candidate)
		} else {
			cmd("switchover %s --leader %s --force", clusterName, leaderName)
		}
		msg, err := h.actions.Switchover(ctx, leaderHost, leaderName, candidate)
		if err != nil {
			return nil, err
		}
		res.Message = msg

	case "failover":
		if candidate == "" {
			return nil, errors.New("failover needs a candidate")
		}
		host, _, ok := memberHost(info, candidate)
		if !ok {
			return nil, fmt.Errorf("%s is not a member", candidate)
		}
		cmd("failover %s --candidate %s --force", clusterName, candidate)
		msg, err := h.actions.Failover(ctx, host, candidate)
		if err != nil {
			return nil, err
		}
		res.Message = msg

	case "restart", "reload", "reinit":
		type target struct{ Name, Role, Host string }
		var targets []target
		for _, m := range info.Members {
			targets = append(targets, target{m.Name, m.Role, m.Host})
		}
		if member != "" {
			host, role, ok := memberHost(info, member)
			if !ok {
				return nil, fmt.Errorf("%s is not a member", member)
			}
			targets = []target{{member, role, host}}
			cmd("%s %s %s --force", command, clusterName, member)
		} else if command == "reinit" {
			return nil, errors.New("reinit needs a member")
		} else {
			cmd("%s %s --force", command, clusterName)
		}
		var done []string
		for _, m := range targets {
			var (
				msg string
				err error
			)
			switch command {
			case "restart":
				msg, err = h.actions.Restart(ctx, m.Host)
			case "reload":
				msg, err = h.actions.Reload(ctx, m.Host)
			default:
				if m.Role == "leader" {
					return nil, errors.New("the leader can't be reinitialized; switch over first")
				}
				msg, err = h.actions.Reinitialize(ctx, m.Host)
			}
			if err != nil {
				return nil, fmt.Errorf("%s: %w (done so far: %s)", m.Name, err, strings.Join(done, ", "))
			}
			done = append(done, m.Name+": "+msg)
		}
		res.Message = strings.Join(done, "; ")

	default:
		return nil, fmt.Errorf("unknown command %q", command)
	}
	return res, nil
}
