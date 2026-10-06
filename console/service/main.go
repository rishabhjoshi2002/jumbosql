package main

import (
	"context"
	_ "embed"
	"fmt"
	"os"
	"postgresql-cluster-console/internal/configuration"
	"postgresql-cluster-console/internal/db"
	"postgresql-cluster-console/internal/insights"
	"postgresql-cluster-console/internal/service"
	"postgresql-cluster-console/internal/storage"
	"postgresql-cluster-console/internal/watcher"
	"postgresql-cluster-console/internal/xdocker"
	"postgresql-cluster-console/migrations"
	"postgresql-cluster-console/pkg/patroni"
	"postgresql-cluster-console/pkg/tracer"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

//go:embed VERSION
var Version string

const appName = "pg_console"

func init() {
	log.Logger = zerolog.New(os.Stdout).With().
		Timestamp().
		Str("app", appName).
		Str("version", Version).
		Logger()
}

func main() {
	if len(os.Args) > 1 {
		configuration.PrintUsage()

		return
	}

	cfg, err := configuration.ReadConfig()
	if err != nil {
		fmt.Print(err.Error())

		return
	}
	log.Info().Interface("config", cfg.Redacted()).Msg("config was parsed")

	l, err := zerolog.ParseLevel(cfg.Logger.Level)
	if err != nil {
		log.Error().Str("log_level", cfg.Logger.Level).Msg("unknown log level")
	} else {
		zerolog.SetGlobalLevel(l)
		log.Info().Str("log_level", cfg.Logger.Level).Msg("log level was set")
	}

	dbPool, err := db.NewDbPool(cfg)
	if err != nil {
		log.Error().Err(err).Msg("failed to create db pool")

		return
	}

	err = migrations.Migrate(dbPool, cfg.Db.MigrationDir)
	if err != nil {
		log.Error().Err(err).Msg("failed to make db migration")

		return
	}

	str := storage.NewDbStorage(dbPool)
	// JumboSQL: the vault password goes to each deployment container as an environment variable
	var automationEnv []string
	if cfg.VaultPassword != "" {
		automationEnv = append(automationEnv, "ANSIBLE_VAULT_PASSWORD="+cfg.VaultPassword)
	} else {
		log.Warn().Msg("PG_CONSOLE_VAULT_PASSWORD is not set: deployments can only use an unencrypted vault.yml")
	}
	dockerManager, err := xdocker.NewDockerManager(cfg.Docker.Host, cfg.Docker.Image, automationEnv...)
	if err != nil {
		log.Error().Err(err).Msg("failed to create docker manager")

		return
	}

	ctx, cancel := context.WithCancel(context.WithValue(context.Background(), tracer.CtxCidKey{}, ""))
	go func() {
		log.Info().Msgf("preload docker image: %s", cfg.Docker.Image)
		dockerManager.PreloadImage(ctx)
	}()
	defer cancel()

	logWatcher := watcher.NewLogWatcher(str, dockerManager, cfg)
	logWatcher.Run()
	defer logWatcher.Stop()

	logAggregator := watcher.NewLogCollector(str, dockerManager)
	defer logAggregator.Stop()

	patroni.Port = cfg.Patroni.Port // JumboSQL: same Patroni port for cluster status and the Patroni console
	clusterWatcher := watcher.NewServerWatcher(str, patroni.NewClient(log.Logger), cfg)
	clusterWatcher.Run()
	defer clusterWatcher.Stop()

	// JumboSQL: Insights - samples every cluster for trends and forecasts
	insightsCollector := insights.NewCollector(str, log.Logger, insights.OptionsFromConfig(cfg))
	insightsCollector.Run()
	defer insightsCollector.Stop()

	s, err := service.NewService(cfg, Version, str, dockerManager, logAggregator, clusterWatcher)
	if err != nil {
		log.Error().Err(err).Msg("failed to create service")

		return
	}

	err = s.Serve()
	if err != nil {
		log.Error().Err(err).Msg("service was finished with error")
	} else {
		log.Info().Msg("service was successfully stopped")
	}
}
