package cluster

// JumboSQL: SQL editor endpoints.
//
//   POST /clusters/{id}/sql         run a script on the cluster and return every result set
//   POST /clusters/{id}/sql/cancel  cancel a running script (only the user who started it)
//
// Scripts run as the cluster's superuser through HAProxy's read-write port (connection_info from the deploy), so
// they always reach the current Patroni leader. Viewers can't run SQL: with arbitrary SQL a session can't be kept
// reliably read-only, so the middleware and this handler both refuse it.

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"postgresql-cluster-console/internal/controllers"
	"postgresql-cluster-console/internal/storage"
	"postgresql-cluster-console/internal/watcher"
	localmid "postgresql-cluster-console/middleware"
	"postgresql-cluster-console/models"
	"postgresql-cluster-console/pkg/sqlrun"
	"postgresql-cluster-console/pkg/tracer"
	"postgresql-cluster-console/restapi/operations/cluster"

	"github.com/go-openapi/runtime/middleware"
	"github.com/rs/zerolog"
)

type sqlHandlers struct {
	db      storage.IStorage
	log     zerolog.Logger
	runner  *sqlrun.Runner
	sslMode string
}

type sqlRunHandler struct{ *sqlHandlers }
type sqlCancelHandler struct{ *sqlHandlers }

// NewSQLHandlers returns the run and cancel handlers, sharing one runner (so cancel finds the running script).
func NewSQLHandlers(db storage.IStorage, log zerolog.Logger, sslMode string) (cluster.PostClustersIDSQLHandler, cluster.PostClustersIDSQLCancelHandler) {
	h := &sqlHandlers{db: db, log: log, runner: sqlrun.NewRunner(), sslMode: sslMode}
	return &sqlRunHandler{h}, &sqlCancelHandler{h}
}

func runKey(user, runID string) string { return user + "\x00" + runID }

func (h *sqlRunHandler) Handle(param cluster.PostClustersIDSQLParams) middleware.Responder {
	ctx := param.HTTPRequest.Context()
	cid, _ := ctx.Value(tracer.CtxCidKey{}).(string)
	localLog := h.log.With().Str("cid", cid).Int64("cluster_id", param.ID).Logger()
	fail := func(err error) middleware.Responder {
		return cluster.NewPostClustersIDSQLBadRequest().WithPayload(controllers.MakeErrorPayload(err, controllers.BaseError))
	}

	user := "api-token"
	if p := localmid.PrincipalFrom(ctx); p != nil {
		if p.Role == "viewer" {
			return fail(errors.New("your role (viewer) can't run SQL; ask an admin for the operator role"))
		}
		if p.Username != "" {
			user = p.Username
		}
	}
	if param.Body == nil || param.Body.SQL == nil || strings.TrimSpace(*param.Body.SQL) == "" {
		return fail(errors.New("no SQL to run"))
	}

	cl, err := h.db.GetCluster(ctx, param.ID)
	if err != nil {
		return fail(err)
	}
	host, port, dbUser, password, err := watcher.ConnectionTarget(cl.ConnectionInfo)
	if err != nil {
		return fail(fmt.Errorf("the cluster has no usable connection info yet (%v); it is written when the deployment finishes", err))
	}
	database := strings.TrimSpace(param.Body.Database)
	if database == "" {
		database = "postgres"
	}

	runID := ""
	if param.Body.RunID != "" {
		runID = runKey(user, param.Body.RunID)
	}
	res, err := h.runner.Run(ctx, sqlrun.Target{
		Host: host, Port: port, User: dbUser, Password: password, Database: database, SSLMode: h.sslMode,
		AppName: "JumboSQL SQL editor (" + user + ")",
	}, sqlrun.Request{
		SQL:     *param.Body.SQL,
		MaxRows: int(param.Body.MaxRows),
		Timeout: time.Duration(param.Body.TimeoutSeconds) * time.Second,
		RunID:   runID,
	})
	if err != nil {
		return fail(err)
	}

	ev := localLog.Info().Str("user", user).Str("database", database).Int("sql_length", len(*param.Body.SQL)).
		Int("result_sets", len(res.Results)).Float64("duration_ms", res.DurationMs)
	if res.Error != nil {
		ev = ev.Str("sqlstate", res.Error.SQLState)
	}
	ev.Msg("SQL editor run")

	payload := &models.ResponseSQLRun{}
	b, err := json.Marshal(res)
	if err == nil {
		err = json.Unmarshal(b, payload)
	}
	if err != nil {
		return fail(err)
	}
	payload.Database = database
	return cluster.NewPostClustersIDSQLOK().WithPayload(payload)
}

func (h *sqlCancelHandler) Handle(param cluster.PostClustersIDSQLCancelParams) middleware.Responder {
	ctx := param.HTTPRequest.Context()
	user := "api-token"
	if p := localmid.PrincipalFrom(ctx); p != nil && p.Username != "" {
		user = p.Username
	}
	ok := false
	if param.Body != nil && param.Body.RunID != nil && *param.Body.RunID != "" {
		ok = h.runner.Cancel(runKey(user, *param.Body.RunID))
	}
	return cluster.NewPostClustersIDSQLCancelOK().WithPayload(&models.ResponseSQLCancel{Cancelled: ok})
}
