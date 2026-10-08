package storage

// pg_genin: Insights - samples of cluster metrics, kept for trends and forecasts.

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// MetricSample is one measured value: metric (e.g. "db.size_bytes") for key (a database, a table, "" = cluster).
type MetricSample struct {
	At     time.Time
	Metric string
	Key    string
	Value  float64
}

// InsightClusterIDs: clusters the collector should sample (not deleted, with connection info).
func (s *dbStorage) InsightClusterIDs(ctx context.Context) ([]int64, error) {
	rows, err := s.db.Query(ctx, `select cluster_id from clusters
		 where deleted_at is null and connection_info is not null and connection_info::text not in ('null', '{}')
		 order by cluster_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// AddMetricSamples stores one round of samples of a cluster.
func (s *dbStorage) AddMetricSamples(ctx context.Context, clusterID int64, samples []MetricSample) error {
	if len(samples) == 0 {
		return nil
	}
	rows := make([][]any, 0, len(samples))
	for _, m := range samples {
		rows = append(rows, []any{clusterID, m.At, m.Metric, m.Key, m.Value})
	}
	_, err := s.db.CopyFrom(ctx, pgx.Identifier{"metric_samples"}, []string{"cluster_id", "at", "metric", "key", "value"},
		pgx.CopyFromRows(rows))
	return err
}

// GetMetricSamples returns the samples of the given metrics since from, oldest first.
func (s *dbStorage) GetMetricSamples(ctx context.Context, clusterID int64, metrics []string, from time.Time) ([]MetricSample, error) {
	rows, err := s.db.Query(ctx, `select at, metric, key, value from metric_samples
		 where cluster_id = $1 and metric = any($2) and at >= $3 order by at`, clusterID, metrics, from)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MetricSample
	for rows.Next() {
		var m MetricSample
		if err := rows.Scan(&m.At, &m.Metric, &m.Key, &m.Value); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// FirstMetricSample: when sampling of the cluster started (zero time when never).
func (s *dbStorage) FirstMetricSample(ctx context.Context, clusterID int64) (time.Time, int64, error) {
	var at *time.Time
	var n int64
	err := s.db.QueryRow(ctx, `select min(at), count(distinct at) from metric_samples where cluster_id = $1 and metric = 'cluster.size_bytes'`,
		clusterID).Scan(&at, &n)
	if err != nil || at == nil {
		return time.Time{}, 0, err
	}
	return *at, n, nil
}

// PurgeMetricSamples deletes samples older than the retention.
func (s *dbStorage) PurgeMetricSamples(ctx context.Context, olderThan time.Duration) (int64, error) {
	tag, err := s.db.Exec(ctx, "delete from metric_samples where at < $1", time.Now().Add(-olderThan))
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// SaveInsightSummary keeps the latest summary of a cluster's Insights report (JSON).
func (s *dbStorage) SaveInsightSummary(ctx context.Context, clusterID int64, at time.Time, summary []byte) error {
	_, err := s.db.Exec(ctx, `insert into insight_reports (cluster_id, at, summary) values ($1, $2, $3)
		on conflict (cluster_id) do update set at = excluded.at, summary = excluded.summary`, clusterID, at, summary)
	return err
}

// GetInsightSummaries returns the cached summaries of the given clusters (cluster id -> JSON).
func (s *dbStorage) GetInsightSummaries(ctx context.Context, clusterIDs []int64) (map[int64][]byte, error) {
	rows, err := s.db.Query(ctx, `select cluster_id, summary from insight_reports where cluster_id = any($1)`, clusterIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64][]byte{}
	for rows.Next() {
		var id int64
		var b []byte
		if err := rows.Scan(&id, &b); err != nil {
			return nil, err
		}
		out[id] = b
	}
	return out, rows.Err()
}

// GetUserPreferences: the user's home page choices (JSON object, "{}" when none).
func (s *dbStorage) GetUserPreferences(ctx context.Context, userID int64) ([]byte, error) {
	var b []byte
	err := s.db.QueryRow(ctx, `select coalesce(preferences, '{}'::jsonb) from users where user_id = $1`, userID).Scan(&b)
	return b, err
}

// SaveUserPreferences replaces the user's home page choices.
func (s *dbStorage) SaveUserPreferences(ctx context.Context, userID int64, prefs []byte) error {
	_, err := s.db.Exec(ctx, `update users set preferences = $2 where user_id = $1`, userID, prefs)
	return err
}
