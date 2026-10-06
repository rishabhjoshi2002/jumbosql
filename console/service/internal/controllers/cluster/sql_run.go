package cluster

// JumboSQL: SQL editor endpoints.
//
//   GET  /clusters/{id}/sql/access  what the signed-in user may do in the SQL editor here (level, databases, scope)
//   POST /clusters/{id}/sql         run a script on the cluster and return every result set
//   POST /clusters/{id}/sql/cancel  cancel a running script (only the user who started it)
//
// Scripts go through HAProxy's read-write port (connection_info from the deploy), so always to the current
// Patroni leader. Who may do what comes from the access policies: the user's SQL profile for the cluster and
// database decides the PostgreSQL role the script runs as - the cluster superuser only for sql.admin without any
// data scope, otherwise a console-managed role whose privileges are exactly the profile's (pkg/sqlroles), so
// hidden columns and tables outside the scope are refused by PostgreSQL itself.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"strings"
	"time"

	acc "postgresql-cluster-console/internal/access"
	"postgresql-cluster-console/internal/controllers"
	"postgresql-cluster-console/internal/policy"
	"postgresql-cluster-console/internal/storage"
	"postgresql-cluster-console/internal/watcher"
	localmid "postgresql-cluster-console/middleware"
	"postgresql-cluster-console/models"
	"postgresql-cluster-console/pkg/sqlroles"
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
	roles   *sqlroles.Manager
	access  *acc.Service
	sslMode string
}

type sqlRunHandler struct{ *sqlHandlers }
type sqlCancelHandler struct{ *sqlHandlers }
type sqlAccessHandler struct{ *sqlHandlers }

// NewSQLHandlers returns the run, cancel and access handlers, sharing one runner (so cancel finds the running script).
func NewSQLHandlers(db storage.IStorage, log zerolog.Logger, sslMode string, a *acc.Service, roles *sqlroles.Manager) (
	cluster.PostClustersIDSQLHandler, cluster.PostClustersIDSQLCancelHandler, cluster.GetClustersIDSQLAccessHandler) {
	h := &sqlHandlers{db: db, log: log, runner: sqlrun.NewRunner(), roles: roles, access: a, sslMode: sslMode}
	return &sqlRunHandler{h}, &sqlCancelHandler{h}, &sqlAccessHandler{h}
}

func runKey(user, runID string) string { return user + "\x00" + runID }

func userName(p *localmid.Principal) string {
	if p == nil || p.Username == "" {
		return "api-token"
	}
	return p.Username
}

// DatabaseAllowed: the database matches one of the profile's patterns (none = all).
func DatabaseAllowed(prof policy.SQLProfile, db string) bool {
	if len(prof.Databases) == 0 {
		return true
	}
	for _, p := range prof.Databases {
		if ok, _ := path.Match(p, db); ok {
			return true
		}
	}
	return false
}

func (h *sqlAccessHandler) Handle(param cluster.GetClustersIDSQLAccessParams) middleware.Responder {
	r := param.HTTPRequest
	sub := acc.Subject(localmid.PrincipalFrom(r.Context()))
	db := ""
	if param.Database != nil {
		db = strings.TrimSpace(*param.Database)
	}
	prof := h.access.SQLProfile(r.Context(), sub, param.ID, db, acc.RequestContext(r))
	if db == "" && prof.Level != policy.LevelNone {
		// level and database patterns over all databases; scope details need a database
		prof.Schemas, prof.Tables = nil, nil
	}
	return cluster.NewGetClustersIDSQLAccessOK().WithPayload(prof)
}

func (h *sqlRunHandler) Handle(param cluster.PostClustersIDSQLParams) middleware.Responder {
	r := param.HTTPRequest
	ctx := r.Context()
	cid, _ := ctx.Value(tracer.CtxCidKey{}).(string)
	localLog := h.log.With().Str("cid", cid).Int64("cluster_id", param.ID).Logger()
	p := localmid.PrincipalFrom(ctx)
	user := userName(p)
	started := time.Now()

	sqlText := ""
	if param.Body != nil && param.Body.SQL != nil {
		sqlText = *param.Body.SQL
	}
	database := "postgres"
	if param.Body != nil && strings.TrimSpace(param.Body.Database) != "" {
		database = strings.TrimSpace(param.Body.Database)
	}
	audit := func(outcome string, details map[string]any) {
		sum := sha256.Sum256([]byte(sqlText))
		d := map[string]any{"database": database, "sql": truncate(sqlText, 10000), "sql_sha256": hex.EncodeToString(sum[:8]),
			"duration_ms": time.Since(started).Milliseconds()}
		for k, v := range details {
			d[k] = v
		}
		status := 200
		if outcome == "denied" {
			status = 403
		}
		h.access.Audit(ctx, acc.AuditEventFor(r, p, "sql.run", outcome, status, param.ID, d))
	}
	fail := func(outcome string, err error, details map[string]any) middleware.Responder {
		audit(outcome, mergeDetails(details, map[string]any{"error": err.Error()}))
		return cluster.NewPostClustersIDSQLBadRequest().WithPayload(controllers.MakeErrorPayload(err, controllers.BaseError))
	}

	if strings.TrimSpace(sqlText) == "" {
		return cluster.NewPostClustersIDSQLBadRequest().WithPayload(controllers.MakeErrorPayload(errors.New("no SQL to run"), controllers.BaseError))
	}

	sub := acc.Subject(p)
	prof := h.access.SQLProfile(ctx, sub, param.ID, database, acc.RequestContext(r))
	if prof.Level == policy.LevelNone {
		return fail("denied", fmt.Errorf("your access policies don't allow SQL on database %q of this cluster", database), nil)
	}
	if !DatabaseAllowed(prof, database) {
		return fail("denied", fmt.Errorf("your access policies don't allow database %q", database), nil)
	}

	cl, err := h.db.GetCluster(ctx, param.ID)
	if err != nil {
		return fail("error", err, nil)
	}
	host, port, dbUser, password, err := watcher.ConnectionTarget(cl.ConnectionInfo)
	if err != nil {
		return fail("error", fmt.Errorf("the cluster has no usable connection info yet (%v); it is written when the deployment finishes", err), nil)
	}
	admin := sqlrun.Target{Host: host, Port: port, User: dbUser, Password: password, Database: database, SSLMode: h.sslMode,
		AppName: "JumboSQL SQL editor (" + user + ")"}
	target, role, err := h.roles.Target(ctx, param.ID, admin, prof, database)
	if err != nil {
		return fail("error", fmt.Errorf("could not prepare your database role: %w", err), map[string]any{"level": prof.Level})
	}
	target.AppName = admin.AppName

	maxRows := int(param.Body.MaxRows)
	if prof.MaxRows > 0 && (maxRows <= 0 || maxRows > prof.MaxRows) {
		maxRows = prof.MaxRows
	}
	timeout := time.Duration(param.Body.TimeoutSeconds) * time.Second
	if prof.TimeoutSeconds > 0 {
		limit := time.Duration(prof.TimeoutSeconds) * time.Second
		if timeout <= 0 || timeout > limit {
			timeout = limit
		}
	}
	runID := ""
	if param.Body.RunID != "" {
		runID = runKey(user, param.Body.RunID)
	}
	res, err := h.runner.Run(ctx, target, sqlrun.Request{SQL: sqlText, MaxRows: maxRows, Timeout: timeout, RunID: runID})
	if err != nil {
		return fail("error", err, map[string]any{"role": role})
	}
	if res.Error != nil && res.Error.SQLState == "28P01" || res.Error != nil && res.Error.SQLState == "28000" {
		res.Error.Hint = strings.TrimSpace(res.Error.Hint + " The cluster's pg_hba.conf must allow role " + role +
			" (password authentication) from the HAProxy node; it is the database role JumboSQL created for your access policy.")
	}

	outcome, details := "ok", map[string]any{"role": role, "level": prof.Level, "result_sets": len(res.Results)}
	var rows int64
	for _, rs := range res.Results {
		rows += rs.RowCount
	}
	details["rows"] = rows
	if res.Error != nil {
		outcome = "error"
		details["error"] = res.Error.Message
		details["sqlstate"] = res.Error.SQLState
		if res.Error.SQLState == "42501" || res.Error.SQLState == "25006" {
			outcome = "denied" // permission denied by PostgreSQL / read-only transaction
		}
	}
	audit(outcome, details)
	localLog.Info().Str("user", user).Str("database", database).Str("role", role).Int("sql_length", len(sqlText)).
		Int("result_sets", len(res.Results)).Float64("duration_ms", res.DurationMs).Msg("SQL editor run")

	payload := &models.ResponseSQLRun{}
	b, err := json.Marshal(res)
	if err == nil {
		err = json.Unmarshal(b, payload)
	}
	if err != nil {
		return cluster.NewPostClustersIDSQLBadRequest().WithPayload(controllers.MakeErrorPayload(err, controllers.BaseError))
	}
	payload.Database = database
	return cluster.NewPostClustersIDSQLOK().WithPayload(payload)
}

func (h *sqlCancelHandler) Handle(param cluster.PostClustersIDSQLCancelParams) middleware.Responder {
	user := userName(localmid.PrincipalFrom(param.HTTPRequest.Context()))
	ok := false
	if param.Body != nil && param.Body.RunID != nil && *param.Body.RunID != "" {
		ok = h.runner.Cancel(runKey(user, *param.Body.RunID))
	}
	return cluster.NewPostClustersIDSQLCancelOK().WithPayload(&models.ResponseSQLCancel{Cancelled: ok})
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func mergeDetails(a, b map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range a {
		out[k] = v
	}
	for k, v := range b {
		out[k] = v
	}
	return out
}
