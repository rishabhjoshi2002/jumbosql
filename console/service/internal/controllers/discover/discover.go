// Package discover: the Discover panel's API - map any PostgreSQL servers the console can reach.
package discover

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	acc "postgresql-cluster-console/internal/access"
	"postgresql-cluster-console/internal/controllers"
	disc "postgresql-cluster-console/internal/discover"
	"postgresql-cluster-console/internal/storage"
	localmid "postgresql-cluster-console/middleware"
	ops "postgresql-cluster-console/restapi/operations/discover"

	"github.com/go-openapi/runtime/middleware"
)

func fail(err error) *ops.PostDiscoverBadRequest {
	return ops.NewPostDiscoverBadRequest().WithPayload(controllers.MakeErrorPayload(err, controllers.BaseError))
}

type runHandler struct{ db storage.IStorage }

func NewPostDiscoverHandler(db storage.IStorage) ops.PostDiscoverHandler { return &runHandler{db: db} }

// saved is what POST /discover and GET /discoveries/{id} return.
type saved struct {
	ID        int64       `json:"id,omitempty"`
	Name      string      `json:"name"`
	CreatedBy string      `json:"created_by,omitempty"`
	CreatedAt time.Time   `json:"created_at"`
	Inventory string      `json:"inventory"`
	Username  string      `json:"username"`
	Result    interface{} `json:"result"`
}

func (h *runHandler) Handle(param ops.PostDiscoverParams) middleware.Responder {
	b := param.Body
	if b == nil || b.Inventory == nil || b.Username == nil || strings.TrimSpace(*b.Username) == "" {
		return fail(errors.New("inventory and username are required"))
	}
	pgPort := int(b.PgPort)
	if pgPort < 0 || pgPort > 65535 {
		return fail(errors.New("bad PostgreSQL port"))
	}
	hosts, err := disc.ParseHosts(*b.Inventory, pgPort)
	if err != nil {
		return fail(err)
	}
	if b.PrometheusURL != "" && !strings.HasPrefix(b.PrometheusURL, "http://") && !strings.HasPrefix(b.PrometheusURL, "https://") {
		return fail(errors.New("the Prometheus address must start with http:// or https://"))
	}
	switch b.Sslmode {
	case "", "disable", "allow", "prefer", "require":
	default:
		return fail(errors.New("sslmode must be disable, allow, prefer or require"))
	}
	req := disc.Request{Hosts: hosts, User: strings.TrimSpace(*b.Username), Password: b.Password,
		Database: strings.TrimSpace(b.Database), SSLMode: b.Sslmode, PromURL: strings.TrimSpace(b.PrometheusURL),
		Days: int(b.Days), Horizon: int(b.Horizon)}
	if u := strings.TrimSpace(b.SSHUser); u != "" {
		if strings.ContainsAny(u, " '\"\\@;|&$`") || strings.HasPrefix(u, "-") {
			return fail(errors.New("bad SSH user name"))
		}
		req.SSH = &disc.SSHAuth{User: u, Port: int(b.SSHPort), Password: b.SSHPassword, Key: b.SSHKey}
	}
	// the SSH secrets live in a temporary folder for this run only
	cleanup, err := disc.PrepareSSH(&req)
	defer cleanup()
	if err != nil {
		return fail(err)
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(param.HTTPRequest.Context()), 170*time.Second)
	defer cancel()
	res := disc.Run(ctx, req)

	out := &saved{Name: strings.TrimSpace(b.Name), CreatedAt: res.At, Inventory: *b.Inventory, Username: *b.Username, Result: res}
	if out.Name == "" {
		out.Name = res.Architecture
	}
	if b.Save {
		js, err := json.Marshal(res)
		if err != nil {
			return fail(err)
		}
		by := ""
		if p := localmid.PrincipalFrom(param.HTTPRequest.Context()); p != nil {
			by = p.Username
		}
		out.CreatedBy = by
		id, err := h.db.SaveDiscovery(ctx, &storage.Discovery{Name: out.Name, CreatedBy: by, Inventory: out.Inventory,
			Username: out.Username, Result: js})
		if err != nil {
			return fail(err)
		}
		out.ID = id
	}
	return ops.NewPostDiscoverOK().WithPayload(out)
}

type listHandler struct{ db storage.IStorage }

func NewGetDiscoveriesHandler(db storage.IStorage) ops.GetDiscoveriesHandler {
	return &listHandler{db: db}
}

func (h *listHandler) Handle(param ops.GetDiscoveriesParams) middleware.Responder {
	list, arch, err := h.db.ListDiscoveries(param.HTTPRequest.Context(), 200)
	if err != nil {
		return ops.NewGetDiscoveriesBadRequest().WithPayload(controllers.MakeErrorPayload(err, controllers.BaseError))
	}
	out := make([]any, 0, len(list))
	for i, d := range list {
		out = append(out, map[string]any{"id": d.ID, "name": d.Name, "created_by": d.CreatedBy, "created_at": d.CreatedAt,
			"inventory": d.Inventory, "username": d.Username, "architecture": arch[i]})
	}
	return ops.NewGetDiscoveriesOK().WithPayload(out)
}

type getHandler struct{ db storage.IStorage }

func NewGetDiscoveriesIDHandler(db storage.IStorage) ops.GetDiscoveriesIDHandler {
	return &getHandler{db: db}
}

func (h *getHandler) Handle(param ops.GetDiscoveriesIDParams) middleware.Responder {
	bad := func(err error) middleware.Responder {
		return ops.NewGetDiscoveriesIDBadRequest().WithPayload(controllers.MakeErrorPayload(err, controllers.BaseError))
	}
	d, err := h.db.GetDiscovery(param.HTTPRequest.Context(), param.ID)
	if err != nil {
		return bad(err)
	}
	if d == nil {
		return bad(errors.New("not found"))
	}
	var res any
	if err := json.Unmarshal(d.Result, &res); err != nil {
		return bad(err)
	}
	return ops.NewGetDiscoveriesIDOK().WithPayload(&saved{ID: d.ID, Name: d.Name, CreatedBy: d.CreatedBy,
		CreatedAt: d.CreatedAt, Inventory: d.Inventory, Username: d.Username, Result: res})
}

type deleteHandler struct{ db storage.IStorage }

func NewDeleteDiscoveriesIDHandler(db storage.IStorage) ops.DeleteDiscoveriesIDHandler {
	return &deleteHandler{db: db}
}

func (h *deleteHandler) Handle(param ops.DeleteDiscoveriesIDParams) middleware.Responder {
	if err := h.db.DeleteDiscovery(param.HTTPRequest.Context(), param.ID); err != nil {
		return ops.NewDeleteDiscoveriesIDBadRequest().WithPayload(controllers.MakeErrorPayload(err, controllers.BaseError))
	}
	return ops.NewDeleteDiscoveriesIDNoContent()
}

/* ------------------------------------------------------------ read-only queries ------------------------------------------------------------ */

type queryHandler struct{ access *acc.Service }

func NewPostDiscoverQueryHandler(a *acc.Service) ops.PostDiscoverQueryHandler {
	return &queryHandler{access: a}
}

func (h *queryHandler) Handle(param ops.PostDiscoverQueryParams) middleware.Responder {
	r := param.HTTPRequest
	ctx := r.Context()
	b := param.Body
	bad := func(err error) middleware.Responder {
		return ops.NewPostDiscoverQueryBadRequest().WithPayload(controllers.MakeErrorPayload(err, controllers.BaseError))
	}
	if b == nil || b.Host == nil || b.Port == nil || b.Username == nil || b.SQL == nil {
		return bad(errors.New("host, port, username and sql are required"))
	}
	audit := func(outcome string, status int, extra map[string]any) {
		d := map[string]any{"server": fmt.Sprintf("%s:%d", *b.Host, *b.Port), "database": b.Database, "user": *b.Username, "sql": *b.SQL}
		for k, v := range extra {
			d[k] = v
		}
		h.access.Audit(ctx, acc.AuditEventFor(r, localmid.PrincipalFrom(ctx), "discover.query", outcome, status, 0, d))
	}
	if _, err := disc.CheckReadOnly(*b.SQL); err != nil {
		audit("denied", 400, map[string]any{"reason": err.Error()})
		return bad(err)
	}
	qctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 45*time.Second)
	defer cancel()
	res, err := disc.RunQuery(qctx, disc.QueryRequest{Target: disc.Target{Host: strings.TrimSpace(*b.Host), Port: int(*b.Port)},
		User: *b.Username, Password: b.Password, Database: b.Database, SSLMode: b.Sslmode, SQL: *b.SQL, MaxRows: int(b.MaxRows)})
	if err != nil {
		audit("error", 400, map[string]any{"error": err.Error()})
		return bad(err)
	}
	if res.Error != "" {
		audit("error", 200, map[string]any{"error": res.Error})
	} else {
		audit("ok", 200, map[string]any{"rows": res.RowCount})
	}
	return ops.NewPostDiscoverQueryOK().WithPayload(res)
}
