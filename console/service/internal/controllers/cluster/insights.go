package cluster

// JumboSQL: GET /clusters/{id}/insights - trends, forecasts and recommendations (internal/insights).

import (
	"postgresql-cluster-console/internal/controllers"
	"postgresql-cluster-console/internal/insights"
	"postgresql-cluster-console/restapi/operations/cluster"

	"github.com/go-openapi/runtime/middleware"
)

type insightsHandler struct{ svc *insights.Service }

func NewInsightsHandler(svc *insights.Service) cluster.GetClustersIDInsightsHandler {
	return &insightsHandler{svc: svc}
}

func (h *insightsHandler) Handle(param cluster.GetClustersIDInsightsParams) middleware.Responder {
	days := 30
	if param.Days != nil && *param.Days > 0 {
		days = int(*param.Days)
		if days > 365 {
			days = 365
		}
	}
	db := ""
	if param.Database != nil {
		db = *param.Database
	}
	rep, err := h.svc.Build(param.HTTPRequest.Context(), param.ID, days, db)
	if err != nil {
		return cluster.NewGetClustersIDInsightsBadRequest().WithPayload(controllers.MakeErrorPayload(err, controllers.BaseError))
	}
	return cluster.NewGetClustersIDInsightsOK().WithPayload(rep)
}
