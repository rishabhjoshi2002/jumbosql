package storage

// pg_mantra: package upgrades (plan, run, rollback) of a cluster in the console or of a setup found by Discover.

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

type Upgrade struct {
	ID          int64      `json:"id"`
	ClusterID   *int64     `json:"cluster_id,omitempty"`
	DiscoveryID *int64     `json:"discovery_id,omitempty"`
	Component   string     `json:"component"`
	Action      string     `json:"action"`
	Status      string     `json:"status"`
	ParentID    *int64     `json:"parent_id,omitempty"`
	OperationID *int64     `json:"operation_id,omitempty"`
	DockerID    string     `json:"-"`
	Options     []byte     `json:"-"`
	Result      []byte     `json:"-"`
	Log         string     `json:"-"`
	CreatedBy   string     `json:"created_by"`
	CreatedAt   time.Time  `json:"created_at"`
	FinishedAt  *time.Time `json:"finished_at,omitempty"`
}

const upgradeCols = `upgrade_id, cluster_id, discovery_id, component, action, status, parent_id, operation_id, docker_id,
	options, result, created_by, created_at, finished_at`

func scanUpgrade(row pgx.Row) (*Upgrade, error) {
	var u Upgrade
	err := row.Scan(&u.ID, &u.ClusterID, &u.DiscoveryID, &u.Component, &u.Action, &u.Status, &u.ParentID, &u.OperationID,
		&u.DockerID, &u.Options, &u.Result, &u.CreatedBy, &u.CreatedAt, &u.FinishedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func (s *dbStorage) CreateUpgrade(ctx context.Context, u *Upgrade) (*Upgrade, error) {
	return scanUpgrade(s.db.QueryRow(ctx, `insert into upgrades (cluster_id, discovery_id, component, action, parent_id, options, created_by)
		values ($1, $2, $3, $4, $5, $6, $7) returning `+upgradeCols, u.ClusterID, u.DiscoveryID, u.Component, u.Action, u.ParentID,
		u.Options, u.CreatedBy))
}

func (s *dbStorage) SetUpgradeDocker(ctx context.Context, id int64, dockerID string) error {
	_, err := s.db.Exec(ctx, `update upgrades set docker_id = $2 where upgrade_id = $1`, id, dockerID)
	return err
}

// AppendUpgradeLog adds lines of the runner's output.
func (s *dbStorage) AppendUpgradeLog(ctx context.Context, id int64, lines string) error {
	_, err := s.db.Exec(ctx, `update upgrades set log = right(log || $2 || chr(10), 2000000) where upgrade_id = $1`, id, lines)
	return err
}

// FinishUpgrade stores the outcome (status success / failed and what each node reported).
func (s *dbStorage) FinishUpgrade(ctx context.Context, id int64, status string, result []byte) error {
	if result == nil {
		result = []byte("[]")
	}
	_, err := s.db.Exec(ctx, `update upgrades set status = $2, result = $3, finished_at = now() where upgrade_id = $1`, id, status, result)
	return err
}

func (s *dbStorage) GetUpgrade(ctx context.Context, id int64) (*Upgrade, error) {
	u, err := scanUpgrade(s.db.QueryRow(ctx, `select `+upgradeCols+` from upgrades where upgrade_id = $1`, id))
	if err != nil || u == nil {
		return u, err
	}
	err = s.db.QueryRow(ctx, `select log from upgrades where upgrade_id = $1`, id).Scan(&u.Log)
	return u, err
}

// ListUpgrades: the upgrades of a cluster (clusterID) or of a discovered setup (discoveryID), newest first.
func (s *dbStorage) ListUpgrades(ctx context.Context, clusterID, discoveryID int64, limit int) ([]Upgrade, error) {
	return s.listUpgrades(ctx, `where (cluster_id = $1 or discovery_id = $2) order by created_at desc limit $3`, clusterID, discoveryID, limit)
}

// ListRunningUpgrades: those whose runner container is (or was) running - for the watcher.
func (s *dbStorage) ListRunningUpgrades(ctx context.Context) ([]Upgrade, error) {
	return s.listUpgrades(ctx, `where status = 'running' and docker_id <> '' order by upgrade_id`)
}

func (s *dbStorage) listUpgrades(ctx context.Context, where string, args ...any) ([]Upgrade, error) {
	rows, err := s.db.Query(ctx, `select `+upgradeCols+` from upgrades `+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Upgrade
	for rows.Next() {
		u, err := scanUpgrade(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *u)
	}
	return out, rows.Err()
}
