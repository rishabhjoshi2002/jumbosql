package user

// JumboSQL: user management - GET/POST /users, PATCH/DELETE /users/{id} (users.manage).
//
// What a user may do is decided by access policies matching the user's name or attributes (group, team, ...).
// "role" in requests is accepted as a shortcut for the attribute "group" (admin / operator / viewer match the
// built-in policies). No change may leave nobody able to manage users and policies.

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"

	acc "postgresql-cluster-console/internal/access"
	"postgresql-cluster-console/internal/auth"
	"postgresql-cluster-console/internal/controllers"
	authctl "postgresql-cluster-console/internal/controllers/auth"
	"postgresql-cluster-console/internal/policy"
	"postgresql-cluster-console/internal/storage"
	localmid "postgresql-cluster-console/middleware"
	"postgresql-cluster-console/models"
	userops "postgresql-cluster-console/restapi/operations/user"

	"github.com/go-openapi/runtime/middleware"
)

var (
	usernameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._@-]{1,62}$`)
	attrKeyRe  = regexp.MustCompile(`^[a-z][a-z0-9_.-]{0,39}$`)
)

const maxAttributes = 30

func errPayload(err error) *models.ResponseError {
	return controllers.MakeErrorPayload(err, controllers.BaseError)
}

// cleanAttributes validates and normalizes attributes; role (legacy) sets "group".
func cleanAttributes(in map[string]string, role string) (map[string]string, error) {
	out := map[string]string{}
	for k, v := range in {
		k = strings.ToLower(strings.TrimSpace(k))
		v = strings.TrimSpace(v)
		if !attrKeyRe.MatchString(k) {
			return nil, fmt.Errorf("attribute name %q: lowercase letters, digits and _ . -, starting with a letter", k)
		}
		if v == "" {
			continue // an empty value removes the attribute
		}
		if len(v) > 200 {
			return nil, fmt.Errorf("attribute %q: value too long", k)
		}
		out[k] = v
	}
	if role = strings.TrimSpace(role); role != "" {
		out["group"] = role
	}
	if len(out) > maxAttributes {
		return nil, fmt.Errorf("at most %d attributes", maxAttributes)
	}
	return out, nil
}

type handlers struct {
	db  storage.IStorage
	acc *acc.Service
}

// lockout: would the users list (with one user changed or removed) leave nobody able to manage users and policies?
func (h *handlers) lockout(ctx context.Context, changed *storage.User, removedID int64) error {
	users, err := h.db.GetUsers(ctx)
	if err != nil {
		return err
	}
	var after []storage.User
	for _, u := range users {
		switch {
		case u.ID == removedID:
		case changed != nil && u.ID == changed.ID:
			after = append(after, *changed)
		default:
			after = append(after, u)
		}
	}
	set := h.acc.Set(ctx)
	if acc.WouldLockOut(set.Policies, after) {
		return acc.ErrLockout
	}
	return nil
}

type getUsersHandler struct{ db storage.IStorage }

func NewGetUsersHandler(db storage.IStorage) userops.GetUsersHandler { return &getUsersHandler{db: db} }

func (h *getUsersHandler) Handle(param userops.GetUsersParams) middleware.Responder {
	users, err := h.db.GetUsers(param.HTTPRequest.Context())
	if err != nil {
		return middleware.Error(500, errPayload(err))
	}
	out := make([]*models.User, 0, len(users))
	for i := range users {
		out = append(out, authctl.ToModel(&users[i]))
	}
	return userops.NewGetUsersOK().WithPayload(out)
}

type postUserHandler struct{ *handlers }

func NewPostUserHandler(db storage.IStorage, a *acc.Service) userops.PostUsersHandler {
	return &postUserHandler{&handlers{db: db, acc: a}}
}

func (h *postUserHandler) Handle(param userops.PostUsersParams) middleware.Responder {
	ctx := param.HTTPRequest.Context()
	bad := func(err error) middleware.Responder {
		return userops.NewPostUsersBadRequest().WithPayload(errPayload(err))
	}

	username := strings.TrimSpace(deref(param.Body.Username))
	if !usernameRe.MatchString(username) {
		return bad(errors.New("username: 2-63 characters, letters, digits and . _ @ -"))
	}
	attrs, err := cleanAttributes(param.Body.Attributes, param.Body.Role)
	if err != nil {
		return bad(err)
	}
	if existing, err := h.db.GetUserByName(ctx, username, auth.ProviderLocal); err != nil {
		return bad(err)
	} else if existing != nil {
		return bad(errors.New("user " + username + " already exists"))
	}
	hash, err := auth.HashPassword(deref(param.Body.Password))
	if err != nil {
		return bad(err)
	}
	var display *string
	if d := strings.TrimSpace(param.Body.DisplayName); d != "" {
		display = &d
	}
	u, err := h.db.CreateUser(ctx, &storage.CreateUserReq{
		Username: username, DisplayName: display, PasswordHash: &hash, Role: attrs["group"], AuthProvider: auth.ProviderLocal,
		Attributes: attrs,
	})
	if err != nil {
		return bad(err)
	}
	return userops.NewPostUsersOK().WithPayload(authctl.ToModel(u))
}

type patchUserHandler struct{ *handlers }

func NewPatchUserHandler(db storage.IStorage, a *acc.Service) userops.PatchUsersIDHandler {
	return &patchUserHandler{&handlers{db: db, acc: a}}
}

func (h *patchUserHandler) Handle(param userops.PatchUsersIDParams) middleware.Responder {
	ctx := param.HTTPRequest.Context()
	bad := func(err error) middleware.Responder {
		return userops.NewPatchUsersIDBadRequest().WithPayload(errPayload(err))
	}
	u, err := h.db.GetUser(ctx, param.ID)
	if err != nil || u == nil {
		return bad(errors.New("user not found"))
	}
	req := &storage.UpdateUserReq{ID: u.ID}
	if d := strings.TrimSpace(param.Body.DisplayName); d != "" {
		req.DisplayName = &d
	}
	if param.Body.Attributes != nil || param.Body.Role != "" {
		base := param.Body.Attributes
		if base == nil { // only the legacy role: keep the other attributes
			base = map[string]string{}
			for k, v := range u.Attributes {
				base[k] = v
			}
		}
		attrs, err := cleanAttributes(base, param.Body.Role)
		if err != nil {
			return bad(err)
		}
		changed := *u
		changed.Attributes = attrs
		if err := h.lockout(ctx, &changed, 0); err != nil {
			return bad(err)
		}
		req.Attributes = attrs
		group := attrs["group"]
		req.Role = &group
	}
	if pw := param.Body.Password; pw != "" {
		if u.AuthProvider != auth.ProviderLocal {
			return bad(errors.New("this user's password is managed by " + u.AuthProvider))
		}
		hash, err := auth.HashPassword(pw)
		if err != nil {
			return bad(err)
		}
		req.PasswordHash = &hash
	}
	updated, err := h.db.UpdateUser(ctx, req)
	if err != nil {
		return bad(err)
	}
	if req.PasswordHash != nil {
		_ = h.db.DeleteUserSessions(ctx, u.ID) // new password: sign the user in again
	}
	return userops.NewPatchUsersIDOK().WithPayload(authctl.ToModel(updated))
}

type deleteUserHandler struct{ *handlers }

func NewDeleteUserHandler(db storage.IStorage, a *acc.Service) userops.DeleteUsersIDHandler {
	return &deleteUserHandler{&handlers{db: db, acc: a}}
}

func (h *deleteUserHandler) Handle(param userops.DeleteUsersIDParams) middleware.Responder {
	ctx := param.HTTPRequest.Context()
	bad := func(err error) middleware.Responder {
		return userops.NewDeleteUsersIDBadRequest().WithPayload(errPayload(err))
	}
	if p := localmid.PrincipalFrom(ctx); p != nil && p.UserID == param.ID {
		return bad(errors.New("you can't remove yourself"))
	}
	u, err := h.db.GetUser(ctx, param.ID)
	if err != nil || u == nil {
		return bad(errors.New("user not found"))
	}
	if err := h.lockout(ctx, nil, u.ID); err != nil {
		return bad(err)
	}
	if err = h.db.DeleteUser(ctx, u.ID); err != nil {
		return bad(err)
	}
	return userops.NewDeleteUsersIDNoContent()
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

var _ = policy.UsersManage
