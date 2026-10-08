// Package discover: the Discover panel's API - map any PostgreSQL servers the console can reach.
package discover

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

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
	targets, err := disc.ParseInventory(*b.Inventory)
	if err != nil {
		return fail(err)
	}
	switch b.Sslmode {
	case "", "disable", "allow", "prefer", "require":
	default:
		return fail(errors.New("sslmode must be disable, allow, prefer or require"))
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(param.HTTPRequest.Context()), 90*time.Second)
	defer cancel()
	res := disc.Run(ctx, disc.Request{Targets: targets, User: strings.TrimSpace(*b.Username), Password: b.Password,
		Database: strings.TrimSpace(b.Database), SSLMode: b.Sslmode})

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
