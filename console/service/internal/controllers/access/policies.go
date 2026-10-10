// Package access - pg_genie access policy, simulation and audit endpoints.
package access

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"

	acc "postgresql-cluster-console/internal/access"
	"postgresql-cluster-console/internal/controllers"
	"postgresql-cluster-console/internal/policy"
	"postgresql-cluster-console/internal/storage"
	localmid "postgresql-cluster-console/middleware"
	"postgresql-cluster-console/models"
	ops "postgresql-cluster-console/restapi/operations/access"

	"github.com/go-openapi/runtime/middleware"
	"github.com/go-openapi/strfmt"
)

type Handlers struct {
	db  storage.IStorage
	acc *acc.Service
}

func New(db storage.IStorage, a *acc.Service) *Handlers { return &Handlers{db: db, acc: a} }

func toModel(p *storage.PolicyRow) *models.Policy {
	m := &models.Policy{ID: p.ID, Name: p.Name, Description: p.Description, Effect: p.Effect, Enabled: p.Enabled,
		Builtin: p.Builtin, Subjects: p.Subjects, Permissions: p.Permissions, Resources: p.Resources, Data: p.Data,
		Conditions: p.Conditions, CreatedAt: strfmt.DateTime(p.CreatedAt), UpdatedBy: p.UpdatedBy}
	if p.UpdatedAt != nil {
		t := strfmt.DateTime(*p.UpdatedAt)
		m.UpdatedAt = &t
	}
	return m
}

// fromModel converts the API body (loosely typed objects) into a validated policy.
func fromModel(m *models.Policy) (*policy.Policy, error) {
	if m == nil {
		return nil, errors.New("no policy in the request")
	}
	p := &policy.Policy{Name: m.Name, Description: m.Description, Effect: m.Effect, Enabled: m.Enabled, Permissions: m.Permissions}
	for _, x := range []struct {
		src  any
		dst  any
		name string
	}{{m.Subjects, &p.Subjects, "subjects"}, {m.Resources, &p.Resources, "resources"}, {m.Data, &p.Data, "data"},
		{m.Conditions, &p.Conditions, "conditions"}} {
		if x.src == nil {
			continue
		}
		b, err := json.Marshal(x.src)
		if err != nil {
			return nil, err
		}
		dec := json.NewDecoder(strings.NewReader(string(b)))
		dec.DisallowUnknownFields()
		if err := dec.Decode(x.dst); err != nil {
			return nil, fmt.Errorf("%s: %v", x.name, err)
		}
	}
	if err := p.Validate(); err != nil {
		return nil, err
	}
	return p, nil
}

func fail(err error) *models.ResponseError {
	return controllers.MakeErrorPayload(err, controllers.BaseError)
}

func principalName(p *localmid.Principal) string {
	if p == nil {
		return ""
	}
	return p.Username
}

func (h *Handlers) checkLockout(after []policy.Policy, users []storage.User) error {
	if acc.WouldLockOut(after, users) {
		return acc.ErrLockout
	}
	return nil
}

/* ---------------------------------------------------------------- handlers ---------------------------------------------------------------- */

type getPolicies struct{ *Handlers }
type postPolicies struct{ *Handlers }
type patchPolicy struct{ *Handlers }
type deletePolicy struct{ *Handlers }
type getPermissions struct{ *Handlers }

func (h *Handlers) GetPolicies() ops.GetPoliciesHandler               { return &getPolicies{h} }
func (h *Handlers) PostPolicies() ops.PostPoliciesHandler             { return &postPolicies{h} }
func (h *Handlers) PatchPolicy() ops.PatchPoliciesIDHandler           { return &patchPolicy{h} }
func (h *Handlers) DeletePolicy() ops.DeletePoliciesIDHandler         { return &deletePolicy{h} }
func (h *Handlers) GetPermissions() ops.GetPoliciesPermissionsHandler { return &getPermissions{h} }

func (h *getPolicies) Handle(param ops.GetPoliciesParams) middleware.Responder {
	rows, err := h.db.GetPolicies(param.HTTPRequest.Context())
	if err != nil {
		return middleware.Error(500, fail(err))
	}
	out := make([]*models.Policy, 0, len(rows))
	for i := range rows {
		out = append(out, toModel(&rows[i]))
	}
	return ops.NewGetPoliciesOK().WithPayload(out)
}

func (h *getPermissions) Handle(param ops.GetPoliciesPermissionsParams) middleware.Responder {
	out := make([]*models.PermissionInfo, 0, len(policy.Catalog))
	for _, p := range policy.Catalog {
		out = append(out, &models.PermissionInfo{Name: p.Name, Description: p.Description, ClusterScoped: p.ClusterScoped})
	}
	return ops.NewGetPoliciesPermissionsOK().WithPayload(out)
}

func (h *Handlers) snapshot(ctx context.Context) ([]policy.Policy, error) {
	rows, err := h.db.GetPolicies(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]policy.Policy, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.Policy)
	}
	return out, nil
}

func (h *postPolicies) Handle(param ops.PostPoliciesParams) middleware.Responder {
	ctx := param.HTTPRequest.Context()
	p, err := fromModel(param.Body)
	if err != nil {
		return ops.NewPostPoliciesBadRequest().WithPayload(fail(err))
	}
	row, err := h.db.CreatePolicy(ctx, p, principalName(localmid.PrincipalFrom(ctx)))
	if err != nil {
		if strings.Contains(err.Error(), "policies_name_uidx") {
			err = fmt.Errorf("a policy named %q already exists", p.Name)
		}
		return ops.NewPostPoliciesBadRequest().WithPayload(fail(err))
	}
	h.acc.Invalidate()
	return ops.NewPostPoliciesOK().WithPayload(toModel(row))
}

func (h *patchPolicy) Handle(param ops.PatchPoliciesIDParams) middleware.Responder {
	ctx := param.HTTPRequest.Context()
	p, err := fromModel(param.Body)
	if err != nil {
		return ops.NewPatchPoliciesIDBadRequest().WithPayload(fail(err))
	}
	cur, err := h.snapshot(ctx)
	if err != nil {
		return ops.NewPatchPoliciesIDBadRequest().WithPayload(fail(err))
	}
	found := false
	after := make([]policy.Policy, 0, len(cur))
	for _, c := range cur {
		if c.ID == param.ID {
			found = true
			np := *p
			np.ID = c.ID
			after = append(after, np)
		} else {
			after = append(after, c)
		}
	}
	if !found {
		return ops.NewPatchPoliciesIDBadRequest().WithPayload(fail(errors.New("policy not found")))
	}
	users, err := h.db.GetUsers(ctx)
	if err != nil {
		return ops.NewPatchPoliciesIDBadRequest().WithPayload(fail(err))
	}
	if err := h.checkLockout(after, users); err != nil {
		return ops.NewPatchPoliciesIDBadRequest().WithPayload(fail(err))
	}
	row, err := h.db.UpdatePolicy(ctx, param.ID, p, principalName(localmid.PrincipalFrom(ctx)))
	if err != nil {
		if strings.Contains(err.Error(), "policies_name_uidx") {
			err = fmt.Errorf("a policy named %q already exists", p.Name)
		}
		return ops.NewPatchPoliciesIDBadRequest().WithPayload(fail(err))
	}
	if row == nil {
		return ops.NewPatchPoliciesIDBadRequest().WithPayload(fail(errors.New("policy not found")))
	}
	h.acc.Invalidate()
	return ops.NewPatchPoliciesIDOK().WithPayload(toModel(row))
}

func (h *deletePolicy) Handle(param ops.DeletePoliciesIDParams) middleware.Responder {
	ctx := param.HTTPRequest.Context()
	cur, err := h.snapshot(ctx)
	if err != nil {
		return ops.NewDeletePoliciesIDBadRequest().WithPayload(fail(err))
	}
	var after []policy.Policy
	for _, c := range cur {
		if c.ID != param.ID {
			after = append(after, c)
		}
	}
	users, err := h.db.GetUsers(ctx)
	if err != nil {
		return ops.NewDeletePoliciesIDBadRequest().WithPayload(fail(err))
	}
	if err := h.checkLockout(after, users); err != nil {
		return ops.NewDeletePoliciesIDBadRequest().WithPayload(fail(err))
	}
	if err := h.db.DeletePolicy(ctx, param.ID); err != nil {
		return ops.NewDeletePoliciesIDBadRequest().WithPayload(fail(err))
	}
	h.acc.Invalidate()
	return ops.NewDeletePoliciesIDNoContent()
}

/* ---------------------------------------------------------------- simulate ---------------------------------------------------------------- */

type simulate struct{ *Handlers }

func (h *Handlers) Simulate() ops.PostPoliciesSimulateHandler { return &simulate{h} }

func (h *simulate) Handle(param ops.PostPoliciesSimulateParams) middleware.Responder {
	ctx := param.HTTPRequest.Context()
	b := param.Body
	if b == nil || b.Username == nil || strings.TrimSpace(*b.Username) == "" {
		return ops.NewPostPoliciesSimulateBadRequest().WithPayload(fail(errors.New("username is required")))
	}
	u, err := h.db.GetUserByName(ctx, strings.TrimSpace(*b.Username), "local")
	if err != nil {
		return ops.NewPostPoliciesSimulateBadRequest().WithPayload(fail(err))
	}
	if u == nil {
		return ops.NewPostPoliciesSimulateBadRequest().WithPayload(fail(fmt.Errorf("no user %q", *b.Username)))
	}
	sub := policy.Subject{UserID: u.ID, Username: u.Username, Attributes: u.Attributes}
	pctx := policy.Context{Now: time.Now()}
	if !time.Time(b.At).IsZero() {
		pctx.Now = time.Time(b.At)
	}
	if b.ClientIP != "" {
		pctx.IP = net.ParseIP(strings.TrimSpace(b.ClientIP))
		if pctx.IP == nil {
			return ops.NewPostPoliciesSimulateBadRequest().WithPayload(fail(fmt.Errorf("%q is not an IP address", b.ClientIP)))
		}
	}

	// optionally with a draft policy (new, or replacing the one with the same id) - "what if I save this?"
	set := h.acc.Set(ctx)
	if b.Policy != nil {
		draft, err := fromModel(b.Policy)
		if err != nil {
			return ops.NewPostPoliciesSimulateBadRequest().WithPayload(fail(fmt.Errorf("draft policy: %v", err)))
		}
		draft.ID = b.Policy.ID
		next := &policy.Set{}
		replaced := false
		for _, p := range set.Policies {
			if draft.ID != 0 && p.ID == draft.ID {
				next.Policies = append(next.Policies, *draft)
				replaced = true
			} else {
				next.Policies = append(next.Policies, p)
			}
		}
		if !replaced {
			next.Policies = append(next.Policies, *draft)
		}
		set = next
	}

	var cl *policy.Cluster
	if b.ClusterID > 0 {
		cl = h.acc.Cluster(ctx, b.ClusterID)
		if cl == nil {
			return ops.NewPostPoliciesSimulateBadRequest().WithPayload(fail(errors.New("unknown cluster")))
		}
	}
	decisions := map[string]policy.Decision{}
	for _, info := range policy.Catalog {
		var c *policy.Cluster
		if info.ClusterScoped {
			c = cl
		}
		decisions[info.Name] = set.Allowed(sub, info.Name, c, b.Database, pctx)
	}
	res := &models.ResponsePolicySimulate{Username: u.Username, Attributes: u.Attributes, Decisions: decisions,
		Policies: func() []any {
			out := []any{}
			for _, m := range set.Explain(sub, cl, pctx) {
				out = append(out, m)
			}
			return out
		}()}
	if cl != nil {
		res.SQL = set.SQL(sub, cl, b.Database, pctx)
	}
	return ops.NewPostPoliciesSimulateOK().WithPayload(res)
}
