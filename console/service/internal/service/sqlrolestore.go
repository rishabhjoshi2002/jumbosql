package service

import (
	"context"

	"postgresql-cluster-console/internal/storage"
	"postgresql-cluster-console/pkg/sqlroles"
)

// sqlRoleStore keeps the SQL editor's managed roles in the console database, passwords encrypted with the key.
type sqlRoleStore struct {
	db  storage.IStorage
	key string
}

func (s sqlRoleStore) GetSQLRole(ctx context.Context, clusterID int64, role string) (*sqlroles.Record, error) {
	r, err := s.db.GetSQLRole(ctx, clusterID, role, s.key)
	if err != nil || r == nil {
		return nil, err
	}
	return &sqlroles.Record{ClusterID: r.ClusterID, RoleName: r.RoleName, Password: r.Password, Profile: r.Profile, Synced: r.Synced}, nil
}

func (s sqlRoleStore) SaveSQLRole(ctx context.Context, r *sqlroles.Record) error {
	return s.db.SaveSQLRole(ctx, &storage.SQLRoleRow{ClusterID: r.ClusterID, RoleName: r.RoleName, Password: r.Password,
		Profile: r.Profile, Synced: r.Synced}, s.key)
}
