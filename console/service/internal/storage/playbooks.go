package storage

// pg_mantra: custom upgrade playbooks - an admin's own playbook (and rollback playbook), with the inputs it needs.

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

type Playbook struct {
	ID           int64     `json:"id"`
	Name         string    `json:"name"`
	Description  string    `json:"description"`
	Playbook     string    `json:"playbook"`
	PlaybookPath string    `json:"playbook_path"`
	Rollback     string    `json:"rollback"`
	RollbackPath string    `json:"rollback_path"`
	Requirements string    `json:"requirements"`
	Variables    []byte    `json:"-"`
	Groups       []byte    `json:"-"`
	Files        []byte    `json:"-"`
	FilesName    string    `json:"files_name"`
	FilesSize    int64     `json:"files_size"`
	CreatedBy    string    `json:"created_by"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

const playbookCols = `playbook_id, name, description, playbook, playbook_path, rollback, rollback_path, requirements,
	variables, groups, files_name, coalesce(length(files), 0), created_by, created_at, updated_at`

func scanPlaybook(row pgx.Row, withFiles bool) (*Playbook, error) {
	var p Playbook
	dest := []any{&p.ID, &p.Name, &p.Description, &p.Playbook, &p.PlaybookPath, &p.Rollback, &p.RollbackPath, &p.Requirements,
		&p.Variables, &p.Groups, &p.FilesName, &p.FilesSize, &p.CreatedBy, &p.CreatedAt, &p.UpdatedAt}
	if withFiles {
		dest = append(dest, &p.Files)
	}
	err := row.Scan(dest...)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

func (s *dbStorage) ListPlaybooks(ctx context.Context) ([]Playbook, error) {
	rows, err := s.db.Query(ctx, `select `+playbookCols+` from custom_playbooks order by name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Playbook{}
	for rows.Next() {
		p, err := scanPlaybook(rows, false)
		if err != nil {
			return nil, err
		}
		out = append(out, *p)
	}
	return out, rows.Err()
}

func (s *dbStorage) GetPlaybook(ctx context.Context, id int64, withFiles bool) (*Playbook, error) {
	cols := playbookCols
	if withFiles {
		cols += `, files`
	}
	return scanPlaybook(s.db.QueryRow(ctx, `select `+cols+` from custom_playbooks where playbook_id = $1`, id), withFiles)
}

// SavePlaybook adds (ID 0) or changes a playbook. keepFiles: an update keeps the stored archive.
func (s *dbStorage) SavePlaybook(ctx context.Context, p *Playbook, keepFiles bool) (*Playbook, error) {
	if p.ID == 0 {
		return scanPlaybook(s.db.QueryRow(ctx, `insert into custom_playbooks (name, description, playbook, playbook_path, rollback,
			rollback_path, requirements, variables, groups, files, files_name, created_by)
			values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning `+playbookCols,
			p.Name, p.Description, p.Playbook, p.PlaybookPath, p.Rollback, p.RollbackPath, p.Requirements, p.Variables, p.Groups,
			p.Files, p.FilesName, p.CreatedBy), false)
	}
	return scanPlaybook(s.db.QueryRow(ctx, `update custom_playbooks set name = $2, description = $3, playbook = $4, playbook_path = $5,
			rollback = $6, rollback_path = $7, requirements = $8, variables = $9, groups = $10,
			files = case when $13 then files else $11 end, files_name = case when $13 then files_name else $12 end,
			updated_at = now()
		where playbook_id = $1 returning `+playbookCols,
		p.ID, p.Name, p.Description, p.Playbook, p.PlaybookPath, p.Rollback, p.RollbackPath, p.Requirements, p.Variables, p.Groups,
		p.Files, p.FilesName, keepFiles), false)
}

func (s *dbStorage) DeletePlaybook(ctx context.Context, id int64) error {
	_, err := s.db.Exec(ctx, `delete from custom_playbooks where playbook_id = $1`, id)
	return err
}
