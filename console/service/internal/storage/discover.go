package storage

// pg_genie: saved Discover results.

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

type Discovery struct {
	ID        int64     `json:"id"`
	Name      string    `json:"name"`
	CreatedBy string    `json:"created_by"`
	CreatedAt time.Time `json:"created_at"`
	Inventory string    `json:"inventory"`
	Username  string    `json:"username"`
	Result    []byte    `json:"-"`
}

func (s *dbStorage) SaveDiscovery(ctx context.Context, d *Discovery) (int64, error) {
	var id int64
	err := s.db.QueryRow(ctx, `insert into discoveries (name, created_by, inventory, username, result)
		values ($1, $2, $3, $4, $5) returning discovery_id`, d.Name, d.CreatedBy, d.Inventory, d.Username, d.Result).Scan(&id)
	return id, err
}

// ListDiscoveries: newest first, without the (large) results; summary = the architecture name.
func (s *dbStorage) ListDiscoveries(ctx context.Context, limit int) ([]Discovery, []string, error) {
	rows, err := s.db.Query(ctx, `select discovery_id, name, created_by, created_at, inventory, username,
		coalesce(result->>'architecture', '') from discoveries order by created_at desc limit $1`, limit)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	var out []Discovery
	var arch []string
	for rows.Next() {
		var d Discovery
		var a string
		if err := rows.Scan(&d.ID, &d.Name, &d.CreatedBy, &d.CreatedAt, &d.Inventory, &d.Username, &a); err != nil {
			return nil, nil, err
		}
		out = append(out, d)
		arch = append(arch, a)
	}
	return out, arch, rows.Err()
}

func (s *dbStorage) GetDiscovery(ctx context.Context, id int64) (*Discovery, error) {
	var d Discovery
	err := s.db.QueryRow(ctx, `select discovery_id, name, created_by, created_at, inventory, username, result
		from discoveries where discovery_id = $1`, id).Scan(&d.ID, &d.Name, &d.CreatedBy, &d.CreatedAt, &d.Inventory, &d.Username, &d.Result)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return &d, err
}

func (s *dbStorage) DeleteDiscovery(ctx context.Context, id int64) error {
	_, err := s.db.Exec(ctx, `delete from discoveries where discovery_id = $1`, id)
	return err
}
