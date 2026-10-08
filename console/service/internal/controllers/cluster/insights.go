package cluster

// pg_genin: GET /clusters/{id}/insights - trends, forecasts, capacity plan and recommendations (internal/insights);
// GET /insights/summary - the same, summarised for every cluster of a project the user may see;
// GET /clusters/{id}/monitoring - live monitoring from the cluster's Prometheus.

import (
	"context"
	"encoding/json"
	"sort"
	"sync"
	"time"

	acc "postgresql-cluster-console/internal/access"
	"postgresql-cluster-console/internal/controllers"
	"postgresql-cluster-console/internal/insights"
	"postgresql-cluster-console/internal/policy"
	"postgresql-cluster-console/internal/storage"
	localmid "postgresql-cluster-console/middleware"
	"postgresql-cluster-console/restapi/operations/cluster"

	"github.com/go-openapi/runtime/middleware"
)

type insightsHandler struct {
	svc *insights.Service
	db  storage.IStorage
}

func NewInsightsHandler(svc *insights.Service, db storage.IStorage) cluster.GetClustersIDInsightsHandler {
	return &insightsHandler{svc: svc, db: db}
}

func clampInt(v *int64, def, lo, hi int) int {
	if v == nil || *v <= 0 {
		return def
	}
	return max(lo, min(hi, int(*v)))
}

func (h *insightsHandler) Handle(param cluster.GetClustersIDInsightsParams) middleware.Responder {
	days := clampInt(param.Days, 30, 1, 365)
	horizon := clampInt(param.Horizon, 30, 7, 365)
	db := ""
	if param.Database != nil {
		db = *param.Database
	}
	ctx := param.HTTPRequest.Context()
	rep, err := h.svc.Build(ctx, param.ID, days, horizon, db)
	if err != nil {
		return cluster.NewGetClustersIDInsightsBadRequest().WithPayload(controllers.MakeErrorPayload(err, controllers.BaseError))
	}
	if days == 30 && horizon == 30 { // the standard view refreshes the cached summary too
		if b, err := json.Marshal(insights.Summarize(rep)); err == nil {
			_ = h.db.SaveInsightSummary(ctx, param.ID, rep.GeneratedAt, b)
		}
	}
	return cluster.NewGetClustersIDInsightsOK().WithPayload(rep)
}

/* ------------------------------------------------------------ multi-cluster summary ------------------------------------------------------------ */

type summaryHandler struct {
	svc    *insights.Service
	db     storage.IStorage
	access *acc.Service
}

func NewInsightsSummaryHandler(svc *insights.Service, db storage.IStorage, a *acc.Service) cluster.GetInsightsSummaryHandler {
	return &summaryHandler{svc: svc, db: db, access: a}
}

// FleetCluster is one cluster in the summary.
type FleetCluster struct {
	ID            int64                    `json:"id"`
	Name          string                   `json:"name"`
	Status        string                   `json:"status"`
	EnvironmentID int64                    `json:"environment_id"`
	Servers       int                      `json:"servers"`
	Healthy       int                      `json:"healthy"`
	Leader        string                   `json:"leader,omitempty"`
	MaxLagBytes   int64                    `json:"max_lag_bytes"`
	Summary       *insights.ClusterSummary `json:"summary,omitempty"`
}

// Fleet is the summary of all clusters.
type Fleet struct {
	GeneratedAt time.Time      `json:"generated_at"`
	Clusters    []FleetCluster `json:"clusters"`
	Totals      struct {
		Clusters   int     `json:"clusters"`
		Healthy    int     `json:"healthy"` // every server running / streaming
		Servers    int     `json:"servers"`
		Critical   int     `json:"critical"`
		Warning    int     `json:"warning"`
		SizeBytes  float64 `json:"size_bytes"`
		SizeIn30   float64 `json:"size_in_30"`
		SizeIn365  float64 `json:"size_in_365"`
		PerDay     float64 `json:"size_per_day"`
		Act        int     `json:"capacity_act"`
		Watch      int     `json:"capacity_watch"`
		AvgScore   int     `json:"avg_score"`
		WorstScore int     `json:"worst_score"`
	} `json:"totals"`
}

func (h *summaryHandler) Handle(param cluster.GetInsightsSummaryParams) middleware.Responder {
	r := param.HTTPRequest
	ctx := r.Context()
	fail := func(err error) middleware.Responder {
		return cluster.NewGetInsightsSummaryBadRequest().WithPayload(controllers.MakeErrorPayload(err, controllers.BaseError))
	}
	sub := acc.Subject(localmid.PrincipalFrom(ctx))
	ids, _, all := h.access.VisibleClusters(ctx, sub, policy.InsightsView, acc.RequestContext(r))
	req := &storage.GetClustersReq{ProjectID: param.ProjectID}
	if !all {
		req.OnlyIDs = ids
	}
	limit := int64(1000)
	req.Limit = &limit
	clusters, _, err := h.db.GetClusters(ctx, req)
	if err != nil {
		return fail(err)
	}
	var clusterIDs []int64
	for _, c := range clusters {
		clusterIDs = append(clusterIDs, c.ID)
	}
	cached, err := h.db.GetInsightSummaries(ctx, clusterIDs)
	if err != nil {
		return fail(err)
	}
	refresh := param.Refresh != nil && *param.Refresh

	out := &Fleet{GeneratedAt: time.Now(), Clusters: make([]FleetCluster, len(clusters))}
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for i, c := range clusters {
		fc := FleetCluster{ID: c.ID, Name: c.Name, Status: c.Status, EnvironmentID: c.EnvironmentID}
		if srv, err := h.db.GetClusterServers(ctx, c.ID); err == nil {
			for _, s := range srv {
				fc.Servers++
				if s.Status == "running" || s.Status == "streaming" {
					fc.Healthy++
				}
				if s.Role == "leader" || s.Role == "master" || s.Role == "primary" {
					fc.Leader = s.Name
				}
				if s.Lag != nil && *s.Lag > fc.MaxLagBytes {
					fc.MaxLagBytes = *s.Lag
				}
			}
		}
		if b, ok := cached[c.ID]; ok && !refresh {
			var s insights.ClusterSummary
			if json.Unmarshal(b, &s) == nil {
				fc.Summary = &s
			}
		}
		out.Clusters[i] = fc
		if fc.Summary == nil && c.ConnectionInfo != nil { // no summary yet (or refresh): build it now
			wg.Add(1)
			go func(i int, id int64) {
				defer wg.Done()
				sem <- struct{}{}
				defer func() { <-sem }()
				bctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
				defer cancel()
				rep, err := h.svc.Build(bctx, id, 30, 30, "")
				if err != nil {
					return
				}
				s := insights.Summarize(rep)
				if b, err := json.Marshal(s); err == nil {
					_ = h.db.SaveInsightSummary(bctx, id, rep.GeneratedAt, b)
				}
				out.Clusters[i].Summary = &s
			}(i, c.ID)
		}
	}
	wg.Wait()

	t := &out.Totals
	t.WorstScore = 100
	scored := 0
	for _, c := range out.Clusters {
		t.Clusters++
		t.Servers += c.Servers
		if c.Servers > 0 && c.Healthy == c.Servers {
			t.Healthy++
		}
		if s := c.Summary; s != nil {
			t.Critical += s.Critical
			t.Warning += s.Warning
			t.SizeBytes += s.SizeBytes
			t.SizeIn30 += s.SizeIn30
			t.SizeIn365 += max(s.SizeIn365, s.SizeBytes)
			t.PerDay += s.SizePerDay
			t.Act += s.Act
			t.Watch += s.Watch
			t.AvgScore += s.Score
			t.WorstScore = min(t.WorstScore, s.Score)
			scored++
		}
	}
	if scored > 0 {
		t.AvgScore /= scored
	} else {
		t.WorstScore = 0
	}
	// worst first: lowest score, then most critical findings
	sort.SliceStable(out.Clusters, func(i, j int) bool {
		a, b := out.Clusters[i].Summary, out.Clusters[j].Summary
		switch {
		case a == nil && b == nil:
			return out.Clusters[i].Name < out.Clusters[j].Name
		case a == nil:
			return false
		case b == nil:
			return true
		case a.Score != b.Score:
			return a.Score < b.Score
		default:
			return a.Critical > b.Critical
		}
	})
	return cluster.NewGetInsightsSummaryOK().WithPayload(out)
}

/* ------------------------------------------------------------ monitoring ------------------------------------------------------------ */

type monitoringHandler struct{ svc *insights.Service }

func NewMonitoringHandler(svc *insights.Service) cluster.GetClustersIDMonitoringHandler {
	return &monitoringHandler{svc: svc}
}

func (h *monitoringHandler) Handle(param cluster.GetClustersIDMonitoringParams) middleware.Responder {
	minutes := clampInt(param.Minutes, 60, 5, 7*24*60)
	m, err := h.svc.Monitoring(param.HTTPRequest.Context(), param.ID, minutes)
	if err != nil {
		return cluster.NewGetClustersIDMonitoringBadRequest().WithPayload(controllers.MakeErrorPayload(err, controllers.BaseError))
	}
	return cluster.NewGetClustersIDMonitoringOK().WithPayload(m)
}
