package watcher

// pg_mantra upgrades: each upgrade keeps its runner container id. When the container ends, keep what each node
// reported (tasks "pgm_result" / "Nothing to do here") on the upgrade, set its status and remove the container.
// No cluster status is changed (the setup may not even be a console cluster).

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"postgresql-cluster-console/internal/storage"
	"postgresql-cluster-console/internal/xdocker"
	"postgresql-cluster-console/pkg/tracer"
)

func (lw *logWatcher) doUpgrades() {
	list, err := lw.db.ListRunningUpgrades(lw.ctx)
	if err != nil {
		lw.log.Error().Err(err).Msg("failed to list running upgrades")
		return
	}
	for _, u := range list {
		ctx := context.WithValue(lw.ctx, tracer.CtxCidKey{}, fmt.Sprintf("upgrade-%d", u.ID))
		st, err := lw.dockerManager.GetStatus(ctx, xdocker.InstanceID(u.DockerID))
		if err != nil {
			if time.Since(u.CreatedAt) > 15*time.Minute { // the container is gone
				lw.finishUpgrade(ctx, &u, storage.OperationStatusFailed, []any{map[string]any{"error": "the upgrade runner container disappeared: " + err.Error()}})
			}
			continue
		}
		switch st {
		case ContainerStatusExited, ContainerStatusDead, ContainerStatusRemoving:
			status, results := ReadUpgradeLog(fmt.Sprintf("%s/upgrade-%d.json", lw.cfg.Docker.LogDir, u.ID))
			lw.finishUpgrade(ctx, &u, status, results)
			if err := lw.dockerManager.RemoveContainer(ctx, xdocker.InstanceID(u.DockerID)); err != nil {
				lw.log.Warn().Err(err).Int64("upgrade", u.ID).Msg("failed to remove the upgrade runner container")
			}
		}
	}
}

func (lw *logWatcher) finishUpgrade(ctx context.Context, u *storage.Upgrade, status string, results []any) {
	res, _ := json.Marshal(results)
	if err := lw.db.FinishUpgrade(ctx, u.ID, status, res); err != nil {
		lw.log.Error().Err(err).Int64("upgrade", u.ID).Msg("failed to store the upgrade result")
	}
}

// ReadUpgradeLog: the playbook's JSON log -> overall status and the per-node results.
func ReadUpgradeLog(path string) (string, []any) {
	f, err := os.Open(path)
	if err != nil {
		return storage.OperationStatusFailed, []any{map[string]any{"error": "no log from the upgrade runner: " + err.Error()}}
	}
	defer f.Close()
	var logs []LogEntity
	if err := json.NewDecoder(f).Decode(&logs); err != nil {
		return storage.OperationStatusFailed, []any{map[string]any{"error": "the upgrade log could not be read: " + err.Error()}}
	}
	status := ""
	results := []any{}
	reported := map[string]bool{}
	var failures []map[string]any // hosts that failed outside the playbook's own reporting (unreachable, ...)
	for _, e := range logs {
		switch {
		case e.Task == "pgm_result" || e.Task == "Nothing to do here":
			if e.Msg != nil && e.Msg != "" {
				results = append(results, e.Msg)
				reported[e.Host] = true
			}
		case e.Failed:
			failures = append(failures, map[string]any{"host": e.Host, "phase": "", "status": "failed", "task": e.Task,
				"error": fmt.Sprint(e.Msg)})
		}
		if e.Summary != nil {
			status = e.Status
		}
	}
	if status == "" {
		status = storage.OperationStatusFailed
	}
	for _, f := range failures {
		h, _ := f["host"].(string)
		if h == "" || h == "localhost" {
			if len(results) == 0 {
				results = append(results, map[string]any{"error": fmt.Sprintf("%s: %s", f["task"], f["error"])})
			}
			continue
		}
		if !reported[h] {
			reported[h] = true
			results = append(results, f)
		}
	}
	return status, results
}
