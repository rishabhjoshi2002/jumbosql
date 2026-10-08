package cluster

// pg_genin: PostgreSQL logs viewer.
//
//   GET /clusters/{id}/logs?server_id=N               log files of the node (newest first) and the current one
//   GET /clusters/{id}/logs/{file}?server_id=N&tail_kb=&since=   end of a file, or new text since a byte offset
//
// The console connects as the cluster superuser directly to the node (its address from the console, its
// PostgreSQL port from Patroni) and reads log_directory with pg_ls_logdir / pg_read_binary_file.
// Needs logs.view on the cluster (checked for the route); every read is in the audit log.

import (
	"context"
	"errors"
	"fmt"

	"postgresql-cluster-console/internal/controllers"
	"postgresql-cluster-console/internal/storage"
	"postgresql-cluster-console/internal/watcher"
	"postgresql-cluster-console/models"
	"postgresql-cluster-console/pkg/patroni"
	"postgresql-cluster-console/pkg/pglogs"
	"postgresql-cluster-console/pkg/sqlrun"
	"postgresql-cluster-console/restapi/operations/cluster"

	"github.com/go-openapi/runtime/middleware"
	"github.com/go-openapi/strfmt"
)

type logsHandlers struct {
	db      storage.IStorage
	actions patroni.IActions
	sslMode string
}

type logsListHandler struct{ *logsHandlers }
type logsReadHandler struct{ *logsHandlers }

func NewLogsHandlers(db storage.IStorage, actions patroni.IActions, sslMode string) (cluster.GetClustersIDLogsHandler, cluster.GetClustersIDLogsFileHandler) {
	h := &logsHandlers{db: db, actions: actions, sslMode: sslMode}
	return &logsListHandler{h}, &logsReadHandler{h}
}

// node returns the superuser connection to one server of the cluster, and its name.
func (h *logsHandlers) node(ctx context.Context, clusterID, serverID int64) (sqlrun.Target, string, error) {
	cl, err := h.db.GetCluster(ctx, clusterID)
	if err != nil || cl == nil {
		return sqlrun.Target{}, "", errors.New("cluster not found")
	}
	servers, err := h.db.GetClusterServers(ctx, clusterID)
	if err != nil {
		return sqlrun.Target{}, "", err
	}
	var srv *storage.Server
	for i := range servers {
		if servers[i].ID == serverID {
			srv = &servers[i]
			break
		}
	}
	if srv == nil || srv.IpAddress == nil {
		return sqlrun.Target{}, "", errors.New("server not found in this cluster")
	}
	_, _, user, password, err := watcher.ConnectionTarget(cl.ConnectionInfo)
	if err != nil {
		return sqlrun.Target{}, "", fmt.Errorf("the cluster has no connection info yet (%v)", err)
	}
	ip := srv.IpAddress.String()
	port := 5432
	if info, err := h.actions.GetCluster(ctx, clusterHosts(servers)); err == nil && info != nil {
		for _, m := range info.Members {
			if m.Host == ip && m.Port > 0 {
				port = m.Port
			}
		}
	}
	return sqlrun.Target{Host: ip, Port: port, User: user, Password: password, Database: "postgres", SSLMode: h.sslMode,
		AppName: "pg_genin logs viewer"}, srv.Name, nil
}

func (h *logsListHandler) Handle(param cluster.GetClustersIDLogsParams) middleware.Responder {
	ctx := param.HTTPRequest.Context()
	node, name, err := h.node(ctx, param.ID, param.ServerID)
	if err != nil {
		return cluster.NewGetClustersIDLogsBadRequest().WithPayload(controllers.MakeErrorPayload(err, controllers.BaseError))
	}
	l, err := pglogs.List(ctx, node)
	if err != nil {
		return cluster.NewGetClustersIDLogsBadRequest().WithPayload(controllers.MakeErrorPayload(
			fmt.Errorf("read the log directory on %s (%s:%d): %w", name, node.Host, node.Port, err), controllers.BaseError))
	}
	out := &models.ResponseLogFiles{Server: name, LogDirectory: l.LogDirectory, Current: l.Current}
	for _, f := range l.Files {
		out.Files = append(out.Files, &models.ResponseLogFilesFilesItems0{Name: f.Name, Size: f.Size, Modified: strfmt.DateTime(f.Modified)})
	}
	return cluster.NewGetClustersIDLogsOK().WithPayload(out)
}

func (h *logsReadHandler) Handle(param cluster.GetClustersIDLogsFileParams) middleware.Responder {
	ctx := param.HTTPRequest.Context()
	node, _, err := h.node(ctx, param.ID, param.ServerID)
	if err != nil {
		return cluster.NewGetClustersIDLogsFileBadRequest().WithPayload(controllers.MakeErrorPayload(err, controllers.BaseError))
	}
	tail, since := 0, int64(-1)
	if param.TailKb != nil {
		tail = int(*param.TailKb)
	}
	if param.Since != nil {
		since = *param.Since
	}
	c, err := pglogs.Read(ctx, node, param.File, tail, since)
	if err != nil {
		return cluster.NewGetClustersIDLogsFileBadRequest().WithPayload(controllers.MakeErrorPayload(err, controllers.BaseError))
	}
	return cluster.NewGetClustersIDLogsFileOK().WithPayload(&models.ResponseLogChunk{File: c.File, Size: c.Size, Offset: c.Offset,
		Next: c.Next, Text: c.Text, Truncated: c.Truncated})
}
