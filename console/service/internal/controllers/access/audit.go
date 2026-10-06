package access

import (
	"time"

	"postgresql-cluster-console/internal/storage"
	"postgresql-cluster-console/models"
	ops "postgresql-cluster-console/restapi/operations/access"

	"github.com/go-openapi/runtime/middleware"
)

type getAudit struct{ *Handlers }

func (h *Handlers) GetAudit() ops.GetAuditHandler { return &getAudit{h} }

func (h *getAudit) Handle(param ops.GetAuditParams) middleware.Responder {
	f := storage.AuditFilter{}
	str := func(p *string) string {
		if p == nil {
			return ""
		}
		return *p
	}
	f.Username, f.Action, f.Outcome, f.Search = str(param.Username), str(param.Action), str(param.Outcome), str(param.Q)
	if param.ClusterID != nil {
		f.ClusterID = *param.ClusterID
	}
	if param.From != nil {
		t := time.Time(*param.From)
		f.From = &t
	}
	if param.To != nil {
		t := time.Time(*param.To)
		f.To = &t
	}
	if param.Limit != nil {
		f.Limit = int(*param.Limit)
	}
	if param.Offset != nil {
		f.Offset = int(*param.Offset)
	}
	events, total, err := h.db.GetAuditEvents(param.HTTPRequest.Context(), f)
	if err != nil {
		return ops.NewGetAuditBadRequest().WithPayload(fail(err))
	}
	data := make([]any, 0, len(events))
	for _, e := range events {
		data = append(data, e)
	}
	return ops.NewGetAuditOK().WithPayload(&models.ResponseAudit{Data: data, Total: total})
}
