// Package auth - pg_genie console login.
//
// Users sign in with a username and password. The check is done by a Provider; today the only provider is
// "local" (users stored in the console database), and LDAP or SSO (OIDC/SAML) providers can be added later
// behind the same interface. A successful login creates a random session token; only its SHA-256 is stored.
//
// The static PG_CONSOLE_AUTHORIZATION_TOKEN keeps working as an API token for scripts and automation.
package auth

import (
	"context"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"postgresql-cluster-console/internal/storage"
)

// Roles, from most to least privileged.
const (
	RoleAdmin    = "admin"    // everything, including user management
	RoleOperator = "operator" // create and manage clusters, Patroni actions
	RoleViewer   = "viewer"   // read-only
)

var ValidRoles = map[string]bool{RoleAdmin: true, RoleOperator: true, RoleViewer: true}

const ProviderLocal = "local"

var (
	ErrInvalidCredentials = errors.New("invalid username or password")
	ErrWeakPassword       = errors.New("password must be at least 8 characters")
)

// ---- password hashing: PBKDF2-HMAC-SHA256 (Go standard library), encoded as
// pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>

const pbkdf2Iterations = 600_000

func HashPassword(password string) (string, error) {
	if len(password) < 8 {
		return "", ErrWeakPassword
	}
	return hashPassword(password)
}

func hashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key, err := pbkdf2.Key(sha256.New, password, salt, pbkdf2Iterations, 32)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("pbkdf2-sha256$%d$%s$%s", pbkdf2Iterations,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}

func VerifyPassword(password, encoded string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2-sha256" {
		return false
	}
	iter, err := strconv.Atoi(parts[1])
	if err != nil || iter < 1 {
		return false
	}
	salt, err1 := base64.RawStdEncoding.DecodeString(parts[2])
	want, err2 := base64.RawStdEncoding.DecodeString(parts[3])
	if err1 != nil || err2 != nil {
		return false
	}
	got, err := pbkdf2.Key(sha256.New, password, salt, iter, len(want))
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(got, want) == 1
}

// ---- providers

// Provider checks a username and password and returns the console user.
type Provider interface {
	Name() string
	Authenticate(ctx context.Context, username, password string) (*storage.User, error)
}

type localProvider struct{ db storage.IStorage }

func NewLocalProvider(db storage.IStorage) Provider { return &localProvider{db: db} }

func (p *localProvider) Name() string { return ProviderLocal }

// dummyHash keeps the timing of "unknown user" close to "wrong password".
var dummyHash, _ = HashPassword("jumbosql-timing-equalizer")

func (p *localProvider) Authenticate(ctx context.Context, username, password string) (*storage.User, error) {
	u, err := p.db.GetUserByName(ctx, username, ProviderLocal)
	if err != nil {
		return nil, err
	}
	if u == nil || u.PasswordHash == nil {
		VerifyPassword(password, dummyHash)
		return nil, ErrInvalidCredentials
	}
	if !VerifyPassword(password, *u.PasswordHash) {
		return nil, ErrInvalidCredentials
	}
	return u, nil
}

// ---- sessions

type Service struct {
	db        storage.IStorage
	providers []Provider
	ttl       time.Duration
}

func NewService(db storage.IStorage, ttl time.Duration, providers ...Provider) *Service {
	if ttl <= 0 {
		ttl = 12 * time.Hour
	}
	return &Service{db: db, providers: providers, ttl: ttl}
}

func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func newToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	// "js_" prefix makes session tokens recognizable; base64url keeps them cookie-safe for the SQL editor.
	return "js_" + base64.RawURLEncoding.EncodeToString(b), nil
}

// Login tries each provider in order and opens a session for the first one that accepts the credentials.
func (s *Service) Login(ctx context.Context, username, password, userAgent string) (string, *storage.User, time.Time, error) {
	username = strings.TrimSpace(username)
	if username == "" || password == "" {
		return "", nil, time.Time{}, ErrInvalidCredentials
	}
	var lastErr error = ErrInvalidCredentials
	for _, p := range s.providers {
		u, err := p.Authenticate(ctx, username, password)
		if err != nil {
			lastErr = err
			continue
		}
		token, err := newToken()
		if err != nil {
			return "", nil, time.Time{}, err
		}
		expires := time.Now().Add(s.ttl)
		if len(userAgent) > 300 {
			userAgent = userAgent[:300]
		}
		if err = s.db.CreateUserSession(ctx, HashToken(token), u.ID, expires, userAgent); err != nil {
			return "", nil, time.Time{}, err
		}
		_ = s.db.TouchUserLogin(ctx, u.ID)
		_ = s.db.DeleteExpiredUserSessions(ctx)
		return token, u, expires, nil
	}
	if !errors.Is(lastErr, ErrInvalidCredentials) {
		return "", nil, time.Time{}, lastErr
	}
	return "", nil, time.Time{}, ErrInvalidCredentials
}

// UserForToken returns the user of a live session token, or nil.
func (s *Service) UserForToken(ctx context.Context, token string) (*storage.User, error) {
	if !strings.HasPrefix(token, "js_") {
		return nil, nil
	}
	return s.db.GetSessionUser(ctx, HashToken(token))
}

func (s *Service) Logout(ctx context.Context, token string) error {
	return s.db.DeleteUserSession(ctx, HashToken(token))
}

// Bootstrap creates the first admin when there are no users yet.
func (s *Service) Bootstrap(ctx context.Context, username, password string) (bool, error) {
	n, err := s.db.CountUsers(ctx)
	if err != nil || n > 0 {
		return false, err
	}
	if password == "" {
		return false, errors.New("bootstrap admin: no password configured")
	}
	// the first admin may use a short token as password, so nobody is locked out; they can change it later
	hash, err := hashPassword(password)
	if err != nil {
		return false, fmt.Errorf("bootstrap admin: %w", err)
	}
	display := "Administrator"
	_, err = s.db.CreateUser(ctx, &storage.CreateUserReq{
		Username: username, DisplayName: &display, PasswordHash: &hash, Role: RoleAdmin, AuthProvider: ProviderLocal,
		Attributes: map[string]string{"group": RoleAdmin}, // matches the built-in Administrators policy
	})
	return err == nil, err
}
