package storage

// JumboSQL: access policies, audit log and SQL editor roles (migration 20261006100000_jumbosql_policies.sql).

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"postgresql-cluster-console/internal/policy"

	"github.com/jackc/pgx/v5"
)

/* ---------------------------------------------------------------- policies ---------------------------------------------------------------- */

const policyColumns = `policy_id, name, coalesce(description, ''), effect, enabled, builtin, subjects, permissions, resources, data, conditions,
	created_at, updated_at, coalesce(updated_by, '')`

type PolicyRow struct {
	policy.Policy
	CreatedAt time.Time
	UpdatedAt *time.Time
	UpdatedBy string
}

func scanPolicy(row pgx.Row) (*PolicyRow, error) {
	var p PolicyRow
	var subjects, resources, data, conditions []byte
	err := row.Scan(&p.ID, &p.Name, &p.Description, &p.Effect, &p.Enabled, &p.Builtin, &subjects, &p.Permissions,
		&resources, &data, &conditions, &p.CreatedAt, &p.UpdatedAt, &p.UpdatedBy)
	if err != nil {
		return nil, err
	}
	for _, x := range []struct {
		raw []byte
		dst any
	}{{subjects, &p.Subjects}, {resources, &p.Resources}, {data, &p.Data}, {conditions, &p.Conditions}} {
		if len(x.raw) > 0 {
			if err := json.Unmarshal(x.raw, x.dst); err != nil {
				return nil, err
			}
		}
	}
	if p.Permissions == nil {
		p.Permissions = []string{}
	}
	return &p, nil
}

func (s *dbStorage) GetPolicies(ctx context.Context) ([]PolicyRow, error) {
	rows, err := s.db.Query(ctx, "select "+policyColumns+" from policies order by builtin desc, lower(name)")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PolicyRow
	for rows.Next() {
		p, err := scanPolicy(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *p)
	}
	return out, rows.Err()
}

func (s *dbStorage) GetPolicy(ctx context.Context, id int64) (*PolicyRow, error) {
	p, err := scanPolicy(s.db.QueryRow(ctx, "select "+policyColumns+" from policies where policy_id = $1", id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return p, err
}

func policyArgs(p *policy.Policy) []any {
	j := func(v any) []byte { b, _ := json.Marshal(v); return b }
	perms := p.Permissions
	if perms == nil {
		perms = []string{}
	}
	return []any{p.Name, nullIfEmpty(p.Description), p.Effect, p.Enabled, j(p.Subjects), perms, j(p.Resources), j(p.Data), j(p.Conditions)}
}

func nullIfEmpty(s string) any {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return s
}

func (s *dbStorage) CreatePolicy(ctx context.Context, p *policy.Policy, by string) (*PolicyRow, error) {
	args := append(policyArgs(p), by)
	return scanPolicy(s.db.QueryRow(ctx,
		`insert into policies (name, description, effect, enabled, subjects, permissions, resources, data, conditions, updated_by)
		 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning `+policyColumns, args...))
}

func (s *dbStorage) UpdatePolicy(ctx context.Context, id int64, p *policy.Policy, by string) (*PolicyRow, error) {
	args := append([]any{id}, policyArgs(p)...)
	args = append(args, by)
	row, err := scanPolicy(s.db.QueryRow(ctx,
		`update policies set name = $2, description = $3, effect = $4, enabled = $5, subjects = $6, permissions = $7,
		        resources = $8, data = $9, conditions = $10, updated_by = $11, updated_at = now()
		  where policy_id = $1 returning `+policyColumns, args...))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return row, err
}

func (s *dbStorage) DeletePolicy(ctx context.Context, id int64) error {
	_, err := s.db.Exec(ctx, "delete from policies where policy_id = $1", id)
	return err
}

/* ---------------------------------------------------------------- clusters for policies ---------------------------------------------------------------- */

// GetClusterRefs returns every cluster with the attributes policies match on (name, environment, project).
func (s *dbStorage) GetClusterRefs(ctx context.Context) ([]policy.Cluster, error) {
	rows, err := s.db.Query(ctx,
		`select c.cluster_id, c.cluster_name, coalesce(e.environment_name, ''), coalesce(p.project_name, '')
		   from clusters c
		   left join environments e on e.environment_id = c.environment_id
		   left join projects p on p.project_id = c.project_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []policy.Cluster
	for rows.Next() {
		var c policy.Cluster
		if err := rows.Scan(&c.ID, &c.Name, &c.Environment, &c.Project); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// ClusterIDOfServer / ClusterIDOfOperation map sub-resources to their cluster (0 when unknown).
func (s *dbStorage) ClusterIDOfServer(ctx context.Context, serverID int64) (int64, error) {
	var id *int64
	err := s.db.QueryRow(ctx, "select cluster_id from servers where server_id = $1", serverID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) || id == nil {
		return 0, nil
	}
	return *id, err
}

func (s *dbStorage) ClusterIDOfOperation(ctx context.Context, operationID int64) (int64, error) {
	var id *int64
	err := s.db.QueryRow(ctx, "select cluster_id from operations where id = $1", operationID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) || id == nil {
		return 0, nil
	}
	return *id, err
}

/* ---------------------------------------------------------------- audit ---------------------------------------------------------------- */

type AuditEvent struct {
	ID        int64          `json:"id"`
	At        time.Time      `json:"at"`
	UserID    *int64         `json:"user_id,omitempty"`
	Username  string         `json:"username"`
	ClientIP  string         `json:"client_ip,omitempty"`
	Action    string         `json:"action"`
	Method    string         `json:"method,omitempty"`
	Path      string         `json:"path,omitempty"`
	ClusterID *int64         `json:"cluster_id,omitempty"`
	Outcome   string         `json:"outcome"` // ok | denied | error
	Status    int            `json:"status,omitempty"`
	Details   map[string]any `json:"details,omitempty"`
}

type AuditFilter struct {
	Username  string
	Action    string // prefix, e.g. "sql." or "patroni."
	Outcome   string
	ClusterID int64
	From, To  *time.Time
	Search    string // in path and details
	Limit     int
	Offset    int
}

func (s *dbStorage) AddAuditEvent(ctx context.Context, e *AuditEvent) error {
	details, _ := json.Marshal(e.Details)
	if e.Details == nil {
		details = []byte("{}")
	}
	_, err := s.db.Exec(ctx,
		`insert into audit_events (user_id, username, client_ip, action, method, path, cluster_id, outcome, status, details)
		 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		e.UserID, e.Username, nullIfEmpty(e.ClientIP), e.Action, nullIfEmpty(e.Method), nullIfEmpty(e.Path), e.ClusterID,
		e.Outcome, e.Status, details)
	return err
}

func (s *dbStorage) GetAuditEvents(ctx context.Context, f AuditFilter) ([]AuditEvent, int64, error) {
	where := []string{"true"}
	var args []any
	add := func(cond string, v any) {
		args = append(args, v)
		where = append(where, strings.ReplaceAll(cond, "?", "$"+itoa(len(args))))
	}
	if f.Username != "" {
		add("lower(username) = lower(?)", f.Username)
	}
	if f.Action != "" {
		add("action like ? || '%'", f.Action)
	}
	if f.Outcome != "" {
		add("outcome = ?", f.Outcome)
	}
	if f.ClusterID > 0 {
		add("cluster_id = ?", f.ClusterID)
	}
	if f.From != nil {
		add("at >= ?", *f.From)
	}
	if f.To != nil {
		add("at < ?", *f.To)
	}
	if f.Search != "" {
		add("(path ilike '%' || ? || '%' or action ilike '%' || ? || '%' or details::text ilike '%' || ? || '%')", f.Search)
	}
	cond := strings.Join(where, " and ")
	var total int64
	if err := s.db.QueryRow(ctx, "select count(*) from audit_events where "+cond, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	limit := f.Limit
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	args = append(args, limit, f.Offset)
	rows, err := s.db.Query(ctx,
		`select event_id, at, user_id, username, coalesce(client_ip, ''), action, coalesce(method, ''), coalesce(path, ''),
		        cluster_id, outcome, coalesce(status, 0), details
		   from audit_events where `+cond+` order by at desc, event_id desc limit $`+itoa(len(args)-1)+` offset $`+itoa(len(args)), args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []AuditEvent
	for rows.Next() {
		var e AuditEvent
		var details []byte
		if err := rows.Scan(&e.ID, &e.At, &e.UserID, &e.Username, &e.ClientIP, &e.Action, &e.Method, &e.Path,
			&e.ClusterID, &e.Outcome, &e.Status, &details); err != nil {
			return nil, 0, err
		}
		_ = json.Unmarshal(details, &e.Details)
		out = append(out, e)
	}
	return out, total, rows.Err()
}

func (s *dbStorage) PurgeAuditEvents(ctx context.Context, olderThan time.Duration) (int64, error) {
	tag, err := s.db.Exec(ctx, "delete from audit_events where at < now() - $1::interval", olderThan.String())
	return tag.RowsAffected(), err
}

func itoa(n int) string {
	const digits = "0123456789"
	if n < 10 {
		return digits[n : n+1]
	}
	return itoa(n/10) + digits[n%10:n%10+1]
}

/* ---------------------------------------------------------------- SQL editor roles ---------------------------------------------------------------- */

type SQLRoleRow struct {
	ClusterID int64
	RoleName  string
	Password  string
	Profile   policy.SQLProfile
	Synced    map[string]time.Time
}

// GetSQLRole returns a managed role with its password decrypted with key, or nil.
func (s *dbStorage) GetSQLRole(ctx context.Context, clusterID int64, role, key string) (*SQLRoleRow, error) {
	var r SQLRoleRow
	var profile, synced []byte
	err := s.db.QueryRow(ctx,
		`select cluster_id, role_name, extensions.pgp_sym_decrypt(password_enc, $3), profile, synced
		   from sql_roles where cluster_id = $1 and role_name = $2`, clusterID, role, key).
		Scan(&r.ClusterID, &r.RoleName, &r.Password, &profile, &synced)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(profile, &r.Profile)
	_ = json.Unmarshal(synced, &r.Synced)
	return &r, nil
}

func (s *dbStorage) SaveSQLRole(ctx context.Context, r *SQLRoleRow, key string) error {
	profile, _ := json.Marshal(r.Profile)
	synced, _ := json.Marshal(r.Synced)
	_, err := s.db.Exec(ctx,
		`insert into sql_roles (cluster_id, role_name, password_enc, profile, synced, last_used_at)
		 values ($1, $2, extensions.pgp_sym_encrypt($3, $4, 'cipher-algo=aes256'), $5, $6, now())
		 on conflict (cluster_id, role_name) do update
		   set password_enc = excluded.password_enc, profile = excluded.profile, synced = excluded.synced, last_used_at = now()`,
		r.ClusterID, r.RoleName, r.Password, key, profile, synced)
	return err
}
