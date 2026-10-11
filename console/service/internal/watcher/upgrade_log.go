package watcher

// pg_mantra upgrades: when the automation container of an upgrade ends, keep what each node reported
// (tasks "pgm_result" / "Nothing to do here") on the upgrade and set its status. The cluster's own status is
// not changed: a failed upgrade step does not mean the cluster is down.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/rs/zerolog"

	"postgresql-cluster-console/internal/storage"
)

func (lw *logWatcher) collectUpgradeLog(ctx context.Context, op *storage.Operation, log zerolog.Logger) {
	up, err := lw.db.GetUpgradeByOperation(ctx, op.ID)
	if err != nil || up == nil {
		log.Error().Err(err).Msg("upgrade of the operation not found")
		lw.setOperationStatus(ctx, op.ID, storage.OperationStatusFailed, log)
		return
	}
	status, results := ReadUpgradeLog(fmt.Sprintf("%s/upgrade-%d.json", lw.cfg.Docker.LogDir, up.ID))
	res, _ := json.Marshal(results)
	if err := lw.db.FinishUpgrade(ctx, up.ID, status, res); err != nil {
		log.Error().Err(err).Msg("failed to store the upgrade result")
	}
	lw.setOperationStatus(ctx, op.ID, status, log)
}

// ReadUpgradeLog: the playbook's JSON log -> overall status and the per-node results.
func ReadUpgradeLog(path string) (string, []any) {
	f, err := os.Open(path)
	if err != nil {
		return storage.OperationStatusFailed, []any{map[string]any{"error": "no log from the automation container: " + err.Error()}}
	}
	defer f.Close()
	var logs []LogEntity
	if err := json.NewDecoder(f).Decode(&logs); err != nil {
		return storage.OperationStatusFailed, []any{map[string]any{"error": "the automation log could not be read: " + err.Error()}}
	}
	status := ""
	results := []any{}
	var lastFailure any
	for _, e := range logs {
		switch {
		case e.Task == "pgm_result" || e.Task == "Nothing to do here":
			if e.Msg != nil && e.Msg != "" {
				results = append(results, e.Msg)
			}
		case e.Failed && lastFailure == nil:
			lastFailure = map[string]any{"error": fmt.Sprintf("%s: %v", e.Task, e.Msg)}
		}
		if e.Summary != nil {
			status = e.Status
		}
	}
	if status == "" {
		status = storage.OperationStatusFailed
	}
	if status == storage.OperationStatusFailed && len(results) == 0 && lastFailure != nil {
		results = append(results, lastFailure)
	}
	return status, results
}

func (lw *logWatcher) setOperationStatus(ctx context.Context, id int64, status string, log zerolog.Logger) {
	if _, err := lw.db.UpdateOperation(ctx, &storage.UpdateOperationReq{ID: id, Status: &status}); err != nil {
		log.Error().Err(err).Msg("failed to update operation status in db")
	}
}
