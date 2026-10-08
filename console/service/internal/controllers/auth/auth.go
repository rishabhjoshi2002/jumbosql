package auth

// pg_genin: /auth/login, /auth/logout, /auth/me, /auth/password

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"postgresql-cluster-console/internal/auth"
	"postgresql-cluster-console/internal/controllers"
	"postgresql-cluster-console/internal/storage"
	localmid "postgresql-cluster-console/middleware"
	"postgresql-cluster-console/models"
	authops "postgresql-cluster-console/restapi/operations/auth"

	"github.com/go-openapi/runtime/middleware"
	"github.com/go-openapi/strfmt"
	"github.com/rs/zerolog"
)

// ToModel converts a stored user for the API (never includes the password hash).
func ToModel(u *storage.User) *models.User {
	if u == nil {
		return nil
	}
	m := &models.User{
		ID:           u.ID,
		Username:     u.Username,
		Role:         u.Role,
		Attributes:   u.Attributes,
		AuthProvider: u.AuthProvider,
		CreatedAt:    strfmt.DateTime(u.CreatedAt),
	}
	if g := u.Attributes["group"]; g != "" {
		m.Role = g
	}
	if u.DisplayName != nil {
		m.DisplayName = *u.DisplayName
	}
	if u.LastLoginAt != nil {
		t := strfmt.DateTime(*u.LastLoginAt)
		m.LastLoginAt = &t
	}
	return m
}

func bearer(r *http.Request) string {
	parts := strings.SplitN(r.Header.Get("Authorization"), " ", 2)
	if len(parts) == 2 && parts[0] == "Bearer" {
		return parts[1]
	}
	return ""
}

type loginHandler struct {
	svc *auth.Service
	log zerolog.Logger
}

func NewPostAuthLoginHandler(svc *auth.Service, log zerolog.Logger) authops.PostAuthLoginHandler {
	return &loginHandler{svc: svc, log: log.With().Str("module", "auth").Logger()}
}

// Hooks set by the service wiring (pg_genin access policies): audit sign-ins, and the effective permissions
// returned by /auth/me.
var (
	AuditLogin  func(r *http.Request, username string, user *storage.User, ok bool, reason string)
	Permissions func(r *http.Request) any
)

func (h *loginHandler) Handle(param authops.PostAuthLoginParams) middleware.Responder {
	username, password := "", ""
	if param.Body.Username != nil {
		username = *param.Body.Username
	}
	if param.Body.Password != nil {
		password = *param.Body.Password
	}
	token, user, expires, err := h.svc.Login(param.HTTPRequest.Context(), username, password, param.HTTPRequest.UserAgent())
	if err != nil {
		if AuditLogin != nil {
			AuditLogin(param.HTTPRequest, username, nil, false, err.Error())
		}
		if errors.Is(err, auth.ErrInvalidCredentials) {
			h.log.Warn().Str("username", username).Str("remote", param.HTTPRequest.RemoteAddr).Msg("failed login")
			return authops.NewPostAuthLoginUnauthorized().WithPayload(&models.ResponseError{
				Code: http.StatusUnauthorized, Title: "Invalid username or password",
			})
		}
		h.log.Error().Err(err).Msg("login failed")
		return authops.NewPostAuthLoginUnauthorized().WithPayload(controllers.MakeErrorPayload(err, controllers.BaseError))
	}
	h.log.Info().Str("username", user.Username).Msg("signed in")
	if AuditLogin != nil {
		AuditLogin(param.HTTPRequest, user.Username, user, true, "")
	}
	return authops.NewPostAuthLoginOK().WithPayload(&models.ResponseLogin{
		Token:     token,
		ExpiresAt: strfmt.DateTime(expires.UTC().Truncate(time.Second)),
		User:      ToModel(user),
	})
}

type logoutHandler struct{ svc *auth.Service }

func NewPostAuthLogoutHandler(svc *auth.Service) authops.PostAuthLogoutHandler {
	return &logoutHandler{svc: svc}
}

func (h *logoutHandler) Handle(param authops.PostAuthLogoutParams) middleware.Responder {
	if t := bearer(param.HTTPRequest); strings.HasPrefix(t, "js_") {
		_ = h.svc.Logout(param.HTTPRequest.Context(), t)
	}
	return authops.NewPostAuthLogoutNoContent()
}

type meHandler struct{ db storage.IStorage }

func NewGetAuthMeHandler(db storage.IStorage) authops.GetAuthMeHandler { return &meHandler{db: db} }

func (h *meHandler) Handle(param authops.GetAuthMeParams) middleware.Responder {
	p := localmid.PrincipalFrom(param.HTTPRequest.Context())
	var perms any
	if Permissions != nil {
		perms = Permissions(param.HTTPRequest)
	}
	if p == nil || p.UserID == 0 {
		// static API token: no user record
		return authops.NewGetAuthMeOK().WithPayload(&models.User{Username: "api-token", Role: auth.RoleAdmin, AuthProvider: "token", Permissions: perms})
	}
	u, err := h.db.GetUser(param.HTTPRequest.Context(), p.UserID)
	if err != nil || u == nil {
		return authops.NewGetAuthMeOK().WithPayload(&models.User{ID: p.UserID, Username: p.Username, Role: p.Role, Permissions: perms})
	}
	m := ToModel(u)
	m.Permissions = perms
	if b, err := h.db.GetUserPreferences(param.HTTPRequest.Context(), u.ID); err == nil {
		var prefs map[string]any
		if json.Unmarshal(b, &prefs) == nil {
			m.Preferences = prefs
		}
	}
	return authops.NewGetAuthMeOK().WithPayload(m)
}

// pg_genin: PUT /auth/me/preferences - the user's own home page choices (cards, their order, start page).
type preferencesHandler struct{ db storage.IStorage }

func NewPutAuthMePreferencesHandler(db storage.IStorage) authops.PutAuthMePreferencesHandler {
	return &preferencesHandler{db: db}
}

const maxPreferencesBytes = 32 << 10

func (h *preferencesHandler) Handle(param authops.PutAuthMePreferencesParams) middleware.Responder {
	bad := func(msg string) middleware.Responder {
		return authops.NewPutAuthMePreferencesBadRequest().WithPayload(&models.ResponseError{Code: http.StatusBadRequest, Title: msg, Description: msg})
	}
	p := localmid.PrincipalFrom(param.HTTPRequest.Context())
	if p == nil || p.UserID == 0 {
		return bad("preferences belong to a user; the API token has none")
	}
	in, ok := param.Body.(map[string]any)
	if !ok {
		return bad("preferences must be a JSON object")
	}
	// pg_genin: the home page (cards, start page) is set by an admin in Settings -> Users; a user keeps the
	// rest (e.g. notes) but cannot change "home"
	ctx := param.HTTPRequest.Context()
	cur := map[string]any{}
	if old, err := h.db.GetUserPreferences(ctx, p.UserID); err == nil && len(old) > 0 {
		_ = json.Unmarshal(old, &cur)
	}
	delete(in, "home")
	if home, ok := cur["home"]; ok {
		in["home"] = home
	}
	b, err := json.Marshal(in)
	if err != nil {
		return bad("preferences must be a JSON object")
	}
	if len(b) > maxPreferencesBytes {
		return bad("preferences are too large")
	}
	if err := h.db.SaveUserPreferences(ctx, p.UserID, b); err != nil {
		return authops.NewPutAuthMePreferencesBadRequest().WithPayload(controllers.MakeErrorPayload(err, controllers.BaseError))
	}
	return authops.NewPutAuthMePreferencesOK().WithPayload(in)
}

type passwordHandler struct{ db storage.IStorage }

func NewPostAuthPasswordHandler(db storage.IStorage) authops.PostAuthPasswordHandler {
	return &passwordHandler{db: db}
}

func (h *passwordHandler) Handle(param authops.PostAuthPasswordParams) middleware.Responder {
	ctx := param.HTTPRequest.Context()
	bad := func(err error) middleware.Responder {
		return authops.NewPostAuthPasswordBadRequest().WithPayload(controllers.MakeErrorPayload(err, controllers.BaseError))
	}
	p := localmid.PrincipalFrom(ctx)
	if p == nil || p.UserID == 0 {
		return bad(errors.New("the API token has no password; sign in as a user"))
	}
	u, err := h.db.GetUser(ctx, p.UserID)
	if err != nil || u == nil {
		return bad(errors.New("user not found"))
	}
	if u.AuthProvider != auth.ProviderLocal || u.PasswordHash == nil {
		return bad(errors.New("this user's password is managed by " + u.AuthProvider))
	}
	if param.Body.CurrentPassword == nil || !auth.VerifyPassword(*param.Body.CurrentPassword, *u.PasswordHash) {
		return bad(errors.New("current password is wrong"))
	}
	if param.Body.NewPassword == nil {
		return bad(auth.ErrWeakPassword)
	}
	hash, err := auth.HashPassword(*param.Body.NewPassword)
	if err != nil {
		return bad(err)
	}
	if _, err = h.db.UpdateUser(ctx, &storage.UpdateUserReq{ID: u.ID, PasswordHash: &hash}); err != nil {
		return bad(err)
	}
	// a password change signs the user out everywhere; the UI asks them to sign in again
	_ = h.db.DeleteUserSessions(ctx, u.ID)
	return authops.NewPostAuthPasswordNoContent()
}
