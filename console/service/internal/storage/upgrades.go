package storage

// pg_mantra: package upgrades of a cluster's components (plan, run, rollback).

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

type Upgrade struct {
	ID          int64      `json:"id"`
	ClusterID   int64      `json:"cluster_id"`
	Component   string     `json:"component"`
	Action      string     `json:"action"`
	Status      string     `json:"status"`
	ParentID    *int64     `json:"parent_id,omitempty"`
	OperationID *int64     `json:"operation_id,omitempty"`
	Options     []byte     `json:"-"`
	Result      []byte     `json:"-"`
	CreatedBy   string     `json:"created_by"`
	CreatedAt   time.Time  `json:"created_at"`
	FinishedAt  *time.Time `json:"finished_at,omitempty"`
}

const upgradeCols = `upgrade_id, cluster_id, component, action, status, parent_id, operation_id, options, result, created_by,
	created_at, finished_at`

func scanUpgrade(row pgx.Row) (*Upgrade, error) {
	var u Upgrade
	err := row.Scan(&u.ID, &u.ClusterID, &u.Component, &u.Action, &u.Status, &u.ParentID, &u.OperationID, &u.Options,
		&u.Result, &u.CreatedBy, &u.CreatedAt, &u.FinishedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func (s *dbStorage) CreateUpgrade(ctx context.Context, u *Upgrade) (*Upgrade, error) {
	return scanUpgrade(s.db.QueryRow(ctx, `insert into upgrades (cluster_id, component, action, parent_id, options, created_by)
		values ($1, $2, $3, $4, $5, $6) returning `+upgradeCols, u.ClusterID, u.Component, u.Action, u.ParentID, u.Options, u.CreatedBy))
}

func (s *dbStorage) SetUpgradeOperation(ctx context.Context, id, operationID int64) error {
	_, err := s.db.Exec(ctx, `update upgrades set operation_id = $2 where upgrade_id = $1`, id, operationID)
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
	return scanUpgrade(s.db.QueryRow(ctx, `select `+upgradeCols+` from upgrades where upgrade_id = $1`, id))
}

func (s *dbStorage) GetUpgradeByOperation(ctx context.Context, operationID int64) (*Upgrade, error) {
	return scanUpgrade(s.db.QueryRow(ctx, `select `+upgradeCols+` from upgrades where operation_id = $1`, operationID))
}

// ListUpgrades: a cluster's upgrades, newest first (results included: they are small).
func (s *dbStorage) ListUpgrades(ctx context.Context, clusterID int64, limit int) ([]Upgrade, error) {
	rows, err := s.db.Query(ctx, `select `+upgradeCols+` from upgrades where cluster_id = $1 order by created_at desc limit $2`, clusterID, limit)
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
