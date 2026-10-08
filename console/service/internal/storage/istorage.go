package storage

import (
	"context"
	"time"

	"postgresql-cluster-console/internal/policy"
)

type IStorage interface {
	// pg_genin: access policies, audit log, SQL editor roles
	GetPolicies(ctx context.Context) ([]PolicyRow, error)
	GetPolicy(ctx context.Context, id int64) (*PolicyRow, error)
	CreatePolicy(ctx context.Context, p *policy.Policy, by string) (*PolicyRow, error)
	UpdatePolicy(ctx context.Context, id int64, p *policy.Policy, by string) (*PolicyRow, error)
	DeletePolicy(ctx context.Context, id int64) error
	GetClusterRefs(ctx context.Context) ([]policy.Cluster, error)
	ClusterIDOfServer(ctx context.Context, serverID int64) (int64, error)
	ClusterIDOfOperation(ctx context.Context, operationID int64) (int64, error)
	AddAuditEvent(ctx context.Context, e *AuditEvent) error
	GetAuditEvents(ctx context.Context, f AuditFilter) ([]AuditEvent, int64, error)
	PurgeAuditEvents(ctx context.Context, olderThan time.Duration) (int64, error)
	GetSQLRole(ctx context.Context, clusterID int64, role, key string) (*SQLRoleRow, error)
	SaveSQLRole(ctx context.Context, r *SQLRoleRow, key string) error

	// pg_genin: Insights
	InsightClusterIDs(ctx context.Context) ([]int64, error)
	AddMetricSamples(ctx context.Context, clusterID int64, samples []MetricSample) error
	GetMetricSamples(ctx context.Context, clusterID int64, metrics []string, from time.Time) ([]MetricSample, error)
	FirstMetricSample(ctx context.Context, clusterID int64) (time.Time, int64, error)
	PurgeMetricSamples(ctx context.Context, olderThan time.Duration) (int64, error)
	SaveInsightSummary(ctx context.Context, clusterID int64, at time.Time, summary []byte) error
	SaveDiscovery(ctx context.Context, d *Discovery) (int64, error)
	ListDiscoveries(ctx context.Context, limit int) ([]Discovery, []string, error)
	GetDiscovery(ctx context.Context, id int64) (*Discovery, error)
	DeleteDiscovery(ctx context.Context, id int64) error
	GetInsightSummaries(ctx context.Context, clusterIDs []int64) (map[int64][]byte, error)
	GetUserPreferences(ctx context.Context, userID int64) ([]byte, error)
	SaveUserPreferences(ctx context.Context, userID int64, prefs []byte) error

	// pg_genin: users and login sessions
	CountUsers(ctx context.Context) (int64, error)
	CountAdmins(ctx context.Context) (int64, error)
	GetUserByName(ctx context.Context, username, provider string) (*User, error)
	GetUser(ctx context.Context, id int64) (*User, error)
	GetUsers(ctx context.Context) ([]User, error)
	CreateUser(ctx context.Context, req *CreateUserReq) (*User, error)
	UpdateUser(ctx context.Context, req *UpdateUserReq) (*User, error)
	DeleteUser(ctx context.Context, id int64) error
	TouchUserLogin(ctx context.Context, id int64) error
	CreateUserSession(ctx context.Context, tokenHash string, userID int64, expiresAt time.Time, userAgent string) error
	GetSessionUser(ctx context.Context, tokenHash string) (*User, error)
	DeleteUserSession(ctx context.Context, tokenHash string) error
	DeleteUserSessions(ctx context.Context, userID int64) error
	DeleteExpiredUserSessions(ctx context.Context) error

	GetCloudProviders(ctx context.Context, limit, offset *int64) ([]CloudProvider, *MetaPagination, error)
	GetCloudProviderInfo(ctx context.Context, providerCode string) (*CloudProviderInfo, error)
	GetExtensions(ctx context.Context, req *GetExtensionsReq) ([]Extension, *MetaPagination, error)
	GetPostgresVersions(ctx context.Context) ([]PostgresVersion, error)

	// environment
	GetEnvironments(ctx context.Context, limit, offset *int64) ([]Environment, *MetaPagination, error)
	GetEnvironment(ctx context.Context, id int64) (*Environment, error)
	GetEnvironmentByName(ctx context.Context, name string) (*Environment, error)
	CreateEnvironment(ctx context.Context, req *AddEnvironmentReq) (*Environment, error)
	DeleteEnvironment(ctx context.Context, id int64) error
	CheckEnvironmentIsUsed(ctx context.Context, id int64) (bool, error)

	// setting
	CreateSetting(ctx context.Context, name string, value interface{}) (*Setting, error)
	GetSettings(ctx context.Context, req *GetSettingsReq) ([]Setting, *MetaPagination, error)
	GetSettingByName(ctx context.Context, name string) (*Setting, error)
	UpdateSetting(ctx context.Context, name string, value interface{}) (*Setting, error)

	// project
	CreateProject(ctx context.Context, name, description string) (*Project, error)
	GetProjects(ctx context.Context, limit, offset *int64) ([]Project, *MetaPagination, error)
	GetProject(ctx context.Context, id int64) (*Project, error)
	GetProjectByName(ctx context.Context, name string) (*Project, error)
	DeleteProject(ctx context.Context, id int64) error
	UpdateProject(ctx context.Context, id int64, name, description *string) (*Project, error)

	// secrets
	GetSecrets(ctx context.Context, req *GetSecretsReq) ([]SecretView, *MetaPagination, error)
	GetSecret(ctx context.Context, id int64) (*SecretView, error)
	GetSecretByName(ctx context.Context, name string) (*SecretView, error)
	CreateSecret(ctx context.Context, req *AddSecretReq) (*SecretView, error)
	DeleteSecret(ctx context.Context, id int64) error
	GetSecretVal(ctx context.Context, id int64, secretKey string) ([]byte, error)

	// cluster
	CreateCluster(ctx context.Context, req *CreateClusterReq) (*Cluster, error)
	GetCluster(ctx context.Context, id int64) (*Cluster, error)
	GetClusters(ctx context.Context, req *GetClustersReq) ([]Cluster, *MetaPagination, error)
	GetDefaultClusterName(ctx context.Context) (string, error)
	DeleteCluster(ctx context.Context, id int64) error
	DeleteClusterSoft(ctx context.Context, id int64) error
	DeleteServer(ctx context.Context, id int64) error
	GetClusterByName(ctx context.Context, name string) (*Cluster, error)
	UpdateCluster(ctx context.Context, req *UpdateClusterReq) (*Cluster, error)

	// operation
	CreateOperation(ctx context.Context, req *CreateOperationReq) (*Operation, error)
	GetOperations(ctx context.Context, req *GetOperationsReq) ([]OperationView, *MetaPagination, error)
	GetOperation(ctx context.Context, id int64) (*Operation, error)
	UpdateOperation(ctx context.Context, req *UpdateOperationReq) (*Operation, error)
	GetInProgressOperations(ctx context.Context, from time.Time) ([]Operation, error)

	// server
	CreateServer(ctx context.Context, req *CreateServerReq) (*Server, error)
	GetServer(ctx context.Context, id int64) (*Server, error)
	GetClusterServers(ctx context.Context, clusterID int64) ([]Server, error)
	UpdateServer(ctx context.Context, req *UpdateServerReq) (*Server, error)
	ResetServer(ctx context.Context, clusterID int64, ipAddress string) (*Server, error)
}
