// Package access applies the policies (internal/policy) to API requests: it decides each request, tells
// handlers which clusters a user may see, works out SQL profiles and writes the audit log.
package access

import (
	"context"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"postgresql-cluster-console/internal/policy"
	"postgresql-cluster-console/internal/storage"
	localmid "postgresql-cluster-console/middleware"

	"github.com/rs/zerolog"
)

const cacheTTL = 15 * time.Second

type Service struct {
	db        storage.IStorage
	log       zerolog.Logger
	retention time.Duration

	mu         sync.Mutex
	set        *policy.Set
	clusters   map[int64]policy.Cluster
	loadedAt   time.Time
	lastPurged time.Time
}

func NewService(db storage.IStorage, log zerolog.Logger, retention time.Duration) *Service {
	return &Service{db: db, log: log, retention: retention}
}

// Invalidate makes the next decision reload policies and clusters (after a change).
func (s *Service) Invalidate() {
	s.mu.Lock()
	s.loadedAt = time.Time{}
	s.mu.Unlock()
}

func (s *Service) load(ctx context.Context) (*policy.Set, map[int64]policy.Cluster) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.set != nil && time.Since(s.loadedAt) < cacheTTL {
		return s.set, s.clusters
	}
	rows, err := s.db.GetPolicies(ctx)
	if err != nil {
		s.log.Error().Err(err).Msg("failed to load access policies")
		if s.set != nil {
			return s.set, s.clusters // keep the last good snapshot
		}
		return &policy.Set{}, map[int64]policy.Cluster{} // nothing loaded: deny everything (except the API token)
	}
	set := &policy.Set{}
	for _, r := range rows {
		set.Policies = append(set.Policies, r.Policy)
	}
	refs, err := s.db.GetClusterRefs(ctx)
	clusters := map[int64]policy.Cluster{}
	if err == nil {
		for _, c := range refs {
			clusters[c.ID] = c
		}
	} else {
		s.log.Error().Err(err).Msg("failed to load clusters for access policies")
	}
	s.set, s.clusters, s.loadedAt = set, clusters, time.Now()
	return set, clusters
}

// Set returns the current policies (for simulation and the UI).
func (s *Service) Set(ctx context.Context) *policy.Set { set, _ := s.load(ctx); return set }

func (s *Service) Cluster(ctx context.Context, id int64) *policy.Cluster {
	_, clusters := s.load(ctx)
	c, ok := clusters[id]
	if !ok {
		s.Invalidate() // maybe a new cluster
		_, clusters = s.load(ctx)
		if c, ok = clusters[id]; !ok {
			return nil
		}
	}
	return &c
}

// Subject of a request's principal.
func Subject(p *localmid.Principal) policy.Subject {
	if p == nil {
		return policy.Subject{}
	}
	return policy.Subject{UserID: p.UserID, Username: p.Username, Attributes: p.Attributes, System: p.System}
}

// RequestContext: client IP (X-Real-IP from the console's nginx, else the connection) and time.
func RequestContext(r *http.Request) policy.Context {
	return policy.Context{IP: net.ParseIP(ClientIP(r)), Now: time.Now()}
}

func ClientIP(r *http.Request) string {
	if ip := strings.TrimSpace(r.Header.Get("X-Real-IP")); ip != "" {
		return ip
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return strings.TrimSpace(strings.Split(xff, ",")[0])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// Can: one permission, on a cluster (clusterID 0 = on any cluster / not cluster-scoped).
func (s *Service) Can(ctx context.Context, sub policy.Subject, perm string, clusterID int64, pctx policy.Context) policy.Decision {
	set, _ := s.load(ctx)
	var cl *policy.Cluster
	if clusterID > 0 {
		cl = s.Cluster(ctx, clusterID)
		if cl == nil {
			return policy.Decision{Reason: "unknown cluster"}
		}
	}
	return set.Allowed(sub, perm, cl, "", pctx)
}

// VisibleClusters returns the ids of the clusters the user may see with perm; all=true means no restriction.
func (s *Service) VisibleClusters(ctx context.Context, sub policy.Subject, perm string, pctx policy.Context) (ids []int64, names []string, all bool) {
	if sub.System {
		return nil, nil, true
	}
	set, clusters := s.load(ctx)
	ids, names = []int64{}, []string{}
	for id, c := range clusters {
		c := c
		if set.Allowed(sub, perm, &c, "", pctx).Allowed {
			ids = append(ids, id)
			names = append(names, c.Name)
		}
	}
	return ids, names, false
}

// SQLProfile for a user on a cluster and database ("" = without a particular database).
func (s *Service) SQLProfile(ctx context.Context, sub policy.Subject, clusterID int64, db string, pctx policy.Context) policy.SQLProfile {
	set, _ := s.load(ctx)
	cl := s.Cluster(ctx, clusterID)
	if cl == nil {
		return policy.SQLProfile{Level: policy.LevelNone}
	}
	return set.SQL(sub, cl, db, pctx)
}

// Permissions summarizes, for the UI, which permissions the user has globally and per cluster.
type Permissions struct {
	Global   []string           `json:"global"`   // non-cluster permissions, and cluster ones held on at least one cluster
	Clusters map[int64][]string `json:"clusters"` // cluster id -> cluster-scoped permissions there
}

func (s *Service) Permissions(ctx context.Context, sub policy.Subject, pctx policy.Context) Permissions {
	set, clusters := s.load(ctx)
	out := Permissions{Global: []string{}, Clusters: map[int64][]string{}}
	for _, info := range policy.Catalog {
		if set.Allowed(sub, info.Name, nil, "", pctx).Allowed {
			out.Global = append(out.Global, info.Name)
		}
	}
	for id, c := range clusters {
		c := c
		var perms []string
		for _, info := range policy.Catalog {
			if info.ClusterScoped && set.Allowed(sub, info.Name, &c, "", pctx).Allowed {
				perms = append(perms, info.Name)
			}
		}
		if len(perms) > 0 {
			out.Clusters[id] = perms
		}
	}
	return out
}

// Audit writes an event; failures are logged, never returned (the audit must not break the request).
func (s *Service) Audit(ctx context.Context, e *storage.AuditEvent) {
	actx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if err := s.db.AddAuditEvent(actx, e); err != nil {
		s.log.Error().Err(err).Str("action", e.Action).Msg("failed to write audit event")
	}
	s.mu.Lock()
	purge := s.retention > 0 && time.Since(s.lastPurged) > time.Hour
	if purge {
		s.lastPurged = time.Now()
	}
	s.mu.Unlock()
	if purge {
		go func() {
			pctx, cancel := context.WithTimeout(context.Background(), time.Minute)
			defer cancel()
			if n, err := s.db.PurgeAuditEvents(pctx, s.retention); err != nil {
				s.log.Error().Err(err).Msg("failed to purge old audit events")
			} else if n > 0 {
				s.log.Info().Int64("deleted", n).Msg("purged old audit events")
			}
		}()
	}
}

// AuditRequest builds an event from a request.
func AuditEventFor(r *http.Request, p *localmid.Principal, action, outcome string, status int, clusterID int64, details map[string]any) *storage.AuditEvent {
	e := &storage.AuditEvent{Username: "anonymous", ClientIP: ClientIP(r), Action: action, Method: r.Method,
		Path: r.URL.Path, Outcome: outcome, Status: status, Details: details}
	if p != nil {
		e.Username = p.Username
		if p.UserID > 0 {
			id := p.UserID
			e.UserID = &id
		}
	}
	if clusterID > 0 {
		e.ClusterID = &clusterID
	}
	return e
}
