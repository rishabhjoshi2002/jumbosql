package user

// JumboSQL: user management for admins - GET/POST /users, PATCH/DELETE /users/{id}

import (
	"errors"
	"regexp"
	"strings"

	"postgresql-cluster-console/internal/auth"
	"postgresql-cluster-console/internal/controllers"
	authctl "postgresql-cluster-console/internal/controllers/auth"
	"postgresql-cluster-console/internal/storage"
	localmid "postgresql-cluster-console/middleware"
	"postgresql-cluster-console/models"
	userops "postgresql-cluster-console/restapi/operations/user"

	"github.com/go-openapi/runtime/middleware"
)

var usernameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._@-]{1,62}$`)

func errPayload(err error) *models.ResponseError {
	return controllers.MakeErrorPayload(err, controllers.BaseError)
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

type postUserHandler struct{ db storage.IStorage }

func NewPostUserHandler(db storage.IStorage) userops.PostUsersHandler {
	return &postUserHandler{db: db}
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
	role := deref(param.Body.Role)
	if !auth.ValidRoles[role] {
		return bad(errors.New("role must be admin, operator or viewer"))
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
		Username: username, DisplayName: display, PasswordHash: &hash, Role: role, AuthProvider: auth.ProviderLocal,
	})
	if err != nil {
		return bad(err)
	}
	return userops.NewPostUsersOK().WithPayload(authctl.ToModel(u))
}

type patchUserHandler struct{ db storage.IStorage }

func NewPatchUserHandler(db storage.IStorage) userops.PatchUsersIDHandler {
	return &patchUserHandler{db: db}
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
	if r := param.Body.Role; r != "" && r != u.Role {
		if !auth.ValidRoles[r] {
			return bad(errors.New("role must be admin, operator or viewer"))
		}
		if u.Role == auth.RoleAdmin {
			if n, _ := h.db.CountAdmins(ctx); n <= 1 {
				return bad(errors.New("this is the last admin; make someone else admin first"))
			}
		}
		req.Role = &r
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
	if req.PasswordHash != nil || req.Role != nil {
		_ = h.db.DeleteUserSessions(ctx, u.ID) // new password / role: sign the user in again
	}
	return userops.NewPatchUsersIDOK().WithPayload(authctl.ToModel(updated))
}

type deleteUserHandler struct{ db storage.IStorage }

func NewDeleteUserHandler(db storage.IStorage) userops.DeleteUsersIDHandler {
	return &deleteUserHandler{db: db}
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
	if u.Role == auth.RoleAdmin {
		if n, _ := h.db.CountAdmins(ctx); n <= 1 {
			return bad(errors.New("this is the last admin"))
		}
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
