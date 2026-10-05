package storage

// JumboSQL: console users and login sessions (tables from migration 20261005150000_jumbosql_users.sql).

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// User - a console user. PasswordHash is empty for users of external providers (LDAP, SSO).
type User struct {
	ID           int64
	Username     string
	DisplayName  *string
	PasswordHash *string
	Role         string
	AuthProvider string
	CreatedAt    time.Time
	UpdatedAt    *time.Time
	LastLoginAt  *time.Time
}

type CreateUserReq struct {
	Username     string
	DisplayName  *string
	PasswordHash *string
	Role         string
	AuthProvider string
}

type UpdateUserReq struct {
	ID           int64
	DisplayName  *string
	PasswordHash *string
	Role         *string
}

const userColumns = `user_id, username, display_name, password_hash, role, auth_provider, created_at, updated_at, last_login_at`

func (s *dbStorage) CountUsers(ctx context.Context) (int64, error) {
	var n int64
	err := s.db.QueryRow(ctx, "select count(*) from users").Scan(&n)
	return n, err
}

func (s *dbStorage) GetUserByName(ctx context.Context, username, provider string) (*User, error) {
	u, err := QueryRowToStruct[User](ctx, s.db,
		"select "+userColumns+" from users where lower(username) = lower($1) and auth_provider = $2", username, provider)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return u, err
}

func (s *dbStorage) GetUser(ctx context.Context, id int64) (*User, error) {
	u, err := QueryRowToStruct[User](ctx, s.db, "select "+userColumns+" from users where user_id = $1", id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return u, err
}

func (s *dbStorage) GetUsers(ctx context.Context) ([]User, error) {
	return QueryRowsToStruct[User](ctx, s.db, "select "+userColumns+" from users order by lower(username)")
}

func (s *dbStorage) CreateUser(ctx context.Context, req *CreateUserReq) (*User, error) {
	provider := req.AuthProvider
	if provider == "" {
		provider = "local"
	}
	return QueryRowToStruct[User](ctx, s.db,
		`insert into users (username, display_name, password_hash, role, auth_provider)
		 values ($1, $2, $3, $4, $5) returning `+userColumns,
		req.Username, req.DisplayName, req.PasswordHash, req.Role, provider)
}

func (s *dbStorage) UpdateUser(ctx context.Context, req *UpdateUserReq) (*User, error) {
	u, err := QueryRowToStruct[User](ctx, s.db,
		`update users set
		   display_name  = coalesce($2, display_name),
		   password_hash = coalesce($3, password_hash),
		   role          = coalesce($4, role),
		   updated_at    = now()
		 where user_id = $1 returning `+userColumns,
		req.ID, req.DisplayName, req.PasswordHash, req.Role)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return u, err
}

func (s *dbStorage) DeleteUser(ctx context.Context, id int64) error {
	_, err := s.db.Exec(ctx, "delete from users where user_id = $1", id)
	return err
}

func (s *dbStorage) CountAdmins(ctx context.Context) (int64, error) {
	var n int64
	err := s.db.QueryRow(ctx, "select count(*) from users where role = 'admin'").Scan(&n)
	return n, err
}

func (s *dbStorage) TouchUserLogin(ctx context.Context, id int64) error {
	_, err := s.db.Exec(ctx, "update users set last_login_at = now() where user_id = $1", id)
	return err
}

// ---- sessions (only the SHA-256 of a token is stored)

func (s *dbStorage) CreateUserSession(ctx context.Context, tokenHash string, userID int64, expiresAt time.Time, userAgent string) error {
	_, err := s.db.Exec(ctx,
		"insert into user_sessions (token_hash, user_id, expires_at, user_agent) values ($1, $2, $3, $4)",
		tokenHash, userID, expiresAt, userAgent)
	return err
}

// GetSessionUser returns the user of a live (not expired) session, or nil.
func (s *dbStorage) GetSessionUser(ctx context.Context, tokenHash string) (*User, error) {
	u, err := QueryRowToStruct[User](ctx, s.db,
		`select u.user_id, u.username, u.display_name, u.password_hash, u.role, u.auth_provider,
		        u.created_at, u.updated_at, u.last_login_at
		   from user_sessions s join users u using (user_id)
		  where s.token_hash = $1 and s.expires_at > now()`, tokenHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return u, err
}

func (s *dbStorage) DeleteUserSession(ctx context.Context, tokenHash string) error {
	_, err := s.db.Exec(ctx, "delete from user_sessions where token_hash = $1", tokenHash)
	return err
}

func (s *dbStorage) DeleteUserSessions(ctx context.Context, userID int64) error {
	_, err := s.db.Exec(ctx, "delete from user_sessions where user_id = $1", userID)
	return err
}

func (s *dbStorage) DeleteExpiredUserSessions(ctx context.Context) error {
	_, err := s.db.Exec(ctx, "delete from user_sessions where expires_at <= now()")
	return err
}
