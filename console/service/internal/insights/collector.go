package insights

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"postgresql-cluster-console/internal/configuration"
	"postgresql-cluster-console/internal/storage"
	"postgresql-cluster-console/internal/watcher"
	"postgresql-cluster-console/pkg/sqlrun"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/rs/zerolog"
)

// Options of the collector (PG_CONSOLE_INSIGHTS_*).
type Options struct {
	Enabled        bool
	Interval       time.Duration // cluster-wide numbers
	TablesInterval time.Duration // per-table numbers (heavier)
	Retention      time.Duration
	SSLMode        string
	MaxDatabases   int // databases per cluster whose tables are sampled
}

// Collector samples every cluster on a timer and stores the samples in the console database.
type Collector struct {
	db   storage.IStorage
	log  zerolog.Logger
	opts Options

	mu         sync.Mutex
	lastTables map[int64]time.Time
	lastPurge  time.Time
	svc        *Service
	cancel     context.CancelFunc
	wg         sync.WaitGroup
}

func NewCollector(db storage.IStorage, log zerolog.Logger, opts Options) *Collector {
	if opts.Interval <= 0 {
		opts.Interval = 5 * time.Minute
	}
	if opts.TablesInterval <= 0 {
		opts.TablesInterval = time.Hour
	}
	if opts.MaxDatabases <= 0 {
		opts.MaxDatabases = 20
	}
	return &Collector{db: db, log: log.With().Str("module", "insights").Logger(), opts: opts, lastTables: map[int64]time.Time{},
		svc: NewService(db, log, opts)}
}

// Run starts sampling in the background (the first round a little after start-up).
func (c *Collector) Run() {
	if !c.opts.Enabled {
		c.log.Info().Msg("insights collector disabled")
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	c.cancel = cancel
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		timer := time.NewTimer(30 * time.Second)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
				c.Round(ctx)
				timer.Reset(c.opts.Interval)
			}
		}
	}()
	c.log.Info().Dur("interval", c.opts.Interval).Msg("insights collector running")
}

func (c *Collector) Stop() {
	if c.cancel != nil {
		c.cancel()
		c.wg.Wait()
	}
}

// Round samples all clusters once (a few at a time) and purges old samples once an hour.
func (c *Collector) Round(ctx context.Context) {
	ids, err := c.db.InsightClusterIDs(ctx)
	if err != nil {
		c.log.Error().Err(err).Msg("listing clusters")
		return
	}
	sem := make(chan struct{}, 4)
	var wg sync.WaitGroup
	for _, id := range ids {
		wg.Add(1)
		sem <- struct{}{}
		go func(id int64) {
			defer func() { <-sem; wg.Done() }()
			cctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
			defer cancel()
			if err := c.CollectCluster(cctx, id, time.Now()); err != nil {
				c.log.Debug().Err(err).Int64("cluster_id", id).Msg("sampling failed")
			}
		}(id)
	}
	wg.Wait()

	c.mu.Lock()
	purge := time.Since(c.lastPurge) > time.Hour
	if purge {
		c.lastPurge = time.Now()
	}
	c.mu.Unlock()
	if purge && c.opts.Retention > 0 {
		if n, err := c.db.PurgeMetricSamples(ctx, c.opts.Retention); err != nil {
			c.log.Error().Err(err).Msg("purging samples")
		} else if n > 0 {
			c.log.Info().Int64("deleted", n).Msg("old insight samples purged")
		}
	}
}

// AdminTarget: the console's own connection to the cluster (HAProxy read-write port -> the leader).
func AdminTarget(cl *storage.Cluster, db, sslMode string) (sqlrun.Target, error) {
	host, port, user, password, err := watcher.ConnectionTarget(cl.ConnectionInfo)
	if err != nil {
		return sqlrun.Target{}, fmt.Errorf("the cluster has no usable connection info yet: %w", err)
	}
	return sqlrun.Target{Host: host, Port: port, User: user, Password: password, Database: db, SSLMode: sslMode,
		AppName: "pg_genin insights"}, nil
}

func connect(ctx context.Context, cl *storage.Cluster, db, sslMode string) (*pgconn.PgConn, error) {
	t, err := AdminTarget(cl, db, sslMode)
	if err != nil {
		return nil, err
	}
	return sqlrun.Connect(ctx, t)
}

// CollectCluster takes one sample of a cluster (tables only every TablesInterval).
func (c *Collector) CollectCluster(ctx context.Context, clusterID int64, now time.Time) error {
	cl, err := c.db.GetCluster(ctx, clusterID)
	if err != nil || cl == nil {
		return fmt.Errorf("cluster %d: %v", clusterID, err)
	}
	conn, err := connect(ctx, cl, "postgres", c.opts.SSLMode)
	if err != nil {
		return err
	}
	samples, dbs, err := sampleCluster(ctx, conn, now)
	conn.Close(context.Background())
	if err != nil {
		return err
	}

	c.mu.Lock()
	tablesDue := now.Sub(c.lastTables[clusterID]) >= c.opts.TablesInterval
	if tablesDue {
		c.lastTables[clusterID] = now
	}
	c.mu.Unlock()
	if tablesDue {
		for i, db := range dbs {
			if i >= c.opts.MaxDatabases {
				break
			}
			dconn, err := connect(ctx, cl, db, c.opts.SSLMode)
			if err != nil {
				continue
			}
			ts, err := sampleTables(ctx, dconn, db, now)
			dconn.Close(context.Background())
			if err == nil {
				samples = append(samples, ts...)
			}
		}
	}
	if err := c.db.AddMetricSamples(ctx, clusterID, samples); err != nil {
		return err
	}
	if tablesDue { // hourly: refresh the cluster's summary for the multi-cluster view (health, warnings, outlook)
		if rep, err := c.svc.Build(ctx, clusterID, 30, 30, ""); err == nil {
			if b, err := json.Marshal(Summarize(rep)); err == nil {
				_ = c.db.SaveInsightSummary(ctx, clusterID, rep.GeneratedAt, b)
			}
		}
	}
	return nil
}

// OptionsFromConfig reads PG_CONSOLE_INSIGHTS_* (and the SQL editor's sslmode for the connections).
func OptionsFromConfig(cfg *configuration.Config) Options {
	return Options{Enabled: cfg.Insights.Enabled, Interval: cfg.Insights.Interval, TablesInterval: cfg.Insights.TablesInterval,
		Retention: cfg.Insights.Retention, SSLMode: cfg.DbDesk.SSLMode}
}
