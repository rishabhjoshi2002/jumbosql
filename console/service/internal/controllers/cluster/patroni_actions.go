package cluster

// JumboSQL: Patroni panel actions - switchover, restart and reinitialize, sent to the Patroni REST API
// of the cluster's database nodes. After each action the cluster watcher refreshes the console's view.

import (
	"context"
	"errors"
	"fmt"

	"postgresql-cluster-console/internal/controllers"
	"postgresql-cluster-console/internal/storage"
	"postgresql-cluster-console/internal/watcher"
	"postgresql-cluster-console/models"
	"postgresql-cluster-console/pkg/patroni"
	"postgresql-cluster-console/pkg/tracer"
	"postgresql-cluster-console/restapi/operations/cluster"

	"github.com/go-openapi/runtime/middleware"
	"github.com/rs/zerolog"
)

type patroniHandlers struct {
	db             storage.IStorage
	log            zerolog.Logger
	actions        patroni.IActions
	clusterWatcher watcher.ClusterWatcher
}

func newPatroniHandlers(db storage.IStorage, log zerolog.Logger, actions patroni.IActions, cw watcher.ClusterWatcher) *patroniHandlers {
	return &patroniHandlers{db: db, log: log.With().Str("module", "patroni_actions").Logger(), actions: actions, clusterWatcher: cw}
}

func (h *patroniHandlers) logger(ctx context.Context) zerolog.Logger {
	cid, _ := ctx.Value(tracer.CtxCidKey{}).(string)
	return h.log.With().Str("cid", cid).Logger()
}

// refresh updates the console's view of the cluster right after an action (best effort).
func (h *patroniHandlers) refresh(ctx context.Context, clusterID int64) {
	cl, err := h.db.GetCluster(ctx, clusterID)
	if err != nil || cl == nil {
		return
	}
	h.clusterWatcher.HandleCluster(ctx, cl)
}

func clusterHosts(servers []storage.Server) []string {
	hosts := make([]string, 0, len(servers))
	for _, s := range servers {
		if s.IpAddress != nil {
			hosts = append(hosts, s.IpAddress.String())
		}
	}
	return hosts
}

func memberByHost(info *patroni.ClusterInfo, host string) (name, role string, ok bool) {
	for _, m := range info.Members {
		if m.Host == host {
			return m.Name, m.Role, true
		}
	}
	return "", "", false
}

func leaderOf(info *patroni.ClusterInfo) (name, host string, ok bool) {
	for _, m := range info.Members {
		if m.Role == "leader" || m.Role == "standby_leader" {
			return m.Name, m.Host, true
		}
	}
	return "", "", false
}

// ---- POST /clusters/{id}/switchover

type switchoverHandler struct{ *patroniHandlers }

func NewPostClusterSwitchoverHandler(db storage.IStorage, log zerolog.Logger, actions patroni.IActions, cw watcher.ClusterWatcher) cluster.PostClustersIDSwitchoverHandler {
	return &switchoverHandler{newPatroniHandlers(db, log, actions, cw)}
}

func (h *switchoverHandler) Handle(param cluster.PostClustersIDSwitchoverParams) middleware.Responder {
	ctx := param.HTTPRequest.Context()
	localLog := h.logger(ctx)
	fail := func(err error) middleware.Responder {
		localLog.Warn().Err(err).Int64("cluster_id", param.ID).Msg("switchover failed")
		return cluster.NewPostClustersIDSwitchoverBadRequest().WithPayload(controllers.MakeErrorPayload(err, controllers.BaseError))
	}

	servers, err := h.db.GetClusterServers(ctx, param.ID)
	if err != nil {
		return fail(err)
	}
	info, err := h.actions.GetCluster(ctx, clusterHosts(servers))
	if err != nil {
		return fail(err)
	}
	leaderName, leaderHost, ok := leaderOf(info)
	if !ok {
		return fail(errors.New("the cluster has no leader right now; switchover needs a running leader"))
	}

	candidate := ""
	if param.Body != nil && param.Body.CandidateServerID > 0 {
		srv, err := h.db.GetServer(ctx, param.Body.CandidateServerID)
		if err != nil {
			return fail(err)
		}
		if srv == nil || srv.ClusterID != param.ID || srv.IpAddress == nil {
			return fail(errors.New("candidate server does not belong to this cluster"))
		}
		name, role, found := memberByHost(info, srv.IpAddress.String())
		if !found {
			return fail(fmt.Errorf("%s is not a Patroni member of this cluster", srv.IpAddress))
		}
		if role == "leader" {
			return fail(fmt.Errorf("%s is already the leader", name))
		}
		candidate = name
	}

	msg, err := h.actions.Switchover(ctx, leaderHost, leaderName, candidate)
	if err != nil {
		return fail(err)
	}
	localLog.Info().Str("leader", leaderName).Str("candidate", candidate).Msg("switchover done")
	h.refresh(ctx, param.ID)

	return cluster.NewPostClustersIDSwitchoverOK().WithPayload(&models.ResponsePatroniAction{
		Action:  "switchover",
		Member:  candidate,
		Message: msg,
	})
}

// ---- POST /servers/{id}/restart and /servers/{id}/reinitialize

// serverMember resolves a console server to its host and Patroni member (name, role).
func (h *patroniHandlers) serverMember(ctx context.Context, serverID int64) (srv *storage.Server, host, name, role string, err error) {
	srv, err = h.db.GetServer(ctx, serverID)
	if err != nil {
		return nil, "", "", "", err
	}
	if srv == nil || srv.IpAddress == nil {
		return nil, "", "", "", errors.New("server not found")
	}
	host = srv.IpAddress.String()
	info, err := h.actions.GetCluster(ctx, []string{host})
	if err != nil {
		return srv, host, "", "", err
	}
	name, role, found := memberByHost(info, host)
	if !found {
		return srv, host, "", "", fmt.Errorf("%s is not a Patroni member", host)
	}
	return srv, host, name, role, nil
}

type restartHandler struct{ *patroniHandlers }

func NewPostServerRestartHandler(db storage.IStorage, log zerolog.Logger, actions patroni.IActions, cw watcher.ClusterWatcher) cluster.PostServersIDRestartHandler {
	return &restartHandler{newPatroniHandlers(db, log, actions, cw)}
}

func (h *restartHandler) Handle(param cluster.PostServersIDRestartParams) middleware.Responder {
	ctx := param.HTTPRequest.Context()
	fail := func(err error) middleware.Responder {
		l := h.logger(ctx)
		l.Warn().Err(err).Int64("server_id", param.ID).Msg("restart failed")
		return cluster.NewPostServersIDRestartBadRequest().WithPayload(controllers.MakeErrorPayload(err, controllers.BaseError))
	}
	srv, host, member, _, err := h.serverMember(ctx, param.ID)
	if err != nil {
		return fail(err)
	}
	msg, err := h.actions.Restart(ctx, host)
	if err != nil {
		return fail(err)
	}
	h.refresh(ctx, srv.ClusterID)
	return cluster.NewPostServersIDRestartOK().WithPayload(&models.ResponsePatroniAction{
		Action: "restart", Member: member, Message: msg,
	})
}

type reinitializeHandler struct{ *patroniHandlers }

func NewPostServerReinitializeHandler(db storage.IStorage, log zerolog.Logger, actions patroni.IActions, cw watcher.ClusterWatcher) cluster.PostServersIDReinitializeHandler {
	return &reinitializeHandler{newPatroniHandlers(db, log, actions, cw)}
}

func (h *reinitializeHandler) Handle(param cluster.PostServersIDReinitializeParams) middleware.Responder {
	ctx := param.HTTPRequest.Context()
	fail := func(err error) middleware.Responder {
		l := h.logger(ctx)
		l.Warn().Err(err).Int64("server_id", param.ID).Msg("reinitialize failed")
		return cluster.NewPostServersIDReinitializeBadRequest().WithPayload(controllers.MakeErrorPayload(err, controllers.BaseError))
	}
	srv, host, member, role, err := h.serverMember(ctx, param.ID)
	if err != nil {
		return fail(err)
	}
	if role == "leader" {
		return fail(errors.New("the leader can't be reinitialized; switch over first"))
	}
	msg, err := h.actions.Reinitialize(ctx, host)
	if err != nil {
		return fail(err)
	}
	h.refresh(ctx, srv.ClusterID)
	return cluster.NewPostServersIDReinitializeOK().WithPayload(&models.ResponsePatroniAction{
		Action: "reinitialize", Member: member, Message: msg,
	})
}
