package service

import (
	"context"

	"net/http"

	"postgresql-cluster-console/internal/access"
	"postgresql-cluster-console/internal/auth"
	"postgresql-cluster-console/internal/configuration"
	accessctl "postgresql-cluster-console/internal/controllers/access"
	authctl "postgresql-cluster-console/internal/controllers/auth"
	"postgresql-cluster-console/internal/controllers/cluster"
	"postgresql-cluster-console/internal/controllers/dictionary"
	"postgresql-cluster-console/internal/controllers/environment"
	"postgresql-cluster-console/internal/controllers/operation"
	"postgresql-cluster-console/internal/controllers/project"
	"postgresql-cluster-console/internal/controllers/secret"
	"postgresql-cluster-console/internal/controllers/setting"
	"postgresql-cluster-console/internal/controllers/user"
	"postgresql-cluster-console/internal/storage"
	"postgresql-cluster-console/internal/watcher"
	"postgresql-cluster-console/internal/xdocker"
	localmid "postgresql-cluster-console/middleware"
	"postgresql-cluster-console/models"
	"postgresql-cluster-console/pkg/patroni"
	"postgresql-cluster-console/pkg/sqlroles"
	"postgresql-cluster-console/restapi"
	"postgresql-cluster-console/restapi/operations"
	"postgresql-cluster-console/restapi/operations/system"

	"github.com/go-openapi/runtime/middleware"

	"github.com/go-openapi/loads"
	"github.com/jessevdk/go-flags"
	"github.com/rs/zerolog/log"
)

type IService interface {
	Serve() error
}

type httpService struct {
	srv *restapi.Server
}

func NewService(
	cfg *configuration.Config,
	version string,
	db storage.IStorage,
	dockerManager xdocker.IManager,
	logCollector watcher.LogCollector,
	clusterWatcher watcher.ClusterWatcher,
) (IService, error) {
	swaggerSpec, err := loads.Analyzed(restapi.SwaggerJSON, "2.0")
	if err != nil {
		return nil, err
	}
	api := operations.NewPgConsoleAPI(swaggerSpec)
	srv := restapi.NewServer(api)

	srv.Host = cfg.Http.Host
	srv.Port = cfg.Http.Port
	srv.ReadTimeout = cfg.Http.ReadTimeout
	srv.WriteTimeout = cfg.Http.WriteTimeout
	restapi.Token = cfg.Authorization.Token

	// JumboSQL: username/password sign-in (local users today; LDAP/SSO providers can be added to the list)
	authSvc := auth.NewService(db, cfg.Auth.SessionTTL, auth.NewLocalProvider(db))
	adminPassword := cfg.Auth.AdminPassword
	if adminPassword == "" {
		adminPassword = cfg.Authorization.Token
	}
	if created, err := authSvc.Bootstrap(context.Background(), cfg.Auth.AdminUsername, adminPassword); err != nil {
		log.Error().Err(err).Msg("could not create the first admin user")
	} else if created {
		log.Info().Str("username", cfg.Auth.AdminUsername).Msg("created the first admin user (password: PG_CONSOLE_AUTH_ADMIN_PASSWORD, or the authorization token)")
	}
	restapi.Sessions = func(ctx context.Context, token string) *localmid.Principal {
		u, err := authSvc.UserForToken(ctx, token)
		if err != nil || u == nil {
			return nil
		}
		return &localmid.Principal{UserID: u.ID, Username: u.Username, Role: u.Role, Attributes: u.Attributes}
	}

	// JumboSQL: attribute-based access policies decide every request; the audit log records what happened
	accessSvc := access.NewService(db, log.Logger, cfg.Audit.Retention)
	restapi.Authz = accessSvc
	authctl.Permissions = func(r *http.Request) any {
		return accessSvc.Permissions(r.Context(), access.Subject(localmid.PrincipalFrom(r.Context())), access.RequestContext(r))
	}
	authctl.AuditLogin = func(r *http.Request, username string, u *storage.User, ok bool, reason string) {
		p := &localmid.Principal{Username: username}
		outcome, details := "ok", map[string]any{}
		if u != nil {
			p.UserID = u.ID
		}
		if !ok {
			outcome, details["reason"] = "denied", reason
		}
		action := "auth.login"
		if !ok {
			action = "auth.login_failed"
		}
		accessSvc.Audit(r.Context(), access.AuditEventFor(r, p, action, outcome, 0, 0, details))
	}

	localLog := log.With().Str("module", "http_server").Logger()
	api.Logger = func(s string, i ...interface{}) {
		localLog.Debug().Msgf(s, i...)
	}

	if cfg.Https.IsUsed {
		srv.EnabledListeners = append(srv.EnabledListeners, "https")
		srv.TLSHost = cfg.Https.Host
		srv.TLSPort = cfg.Https.Port
		srv.TLSReadTimeout = cfg.Http.ReadTimeout
		srv.TLSWriteTimeout = cfg.Http.WriteTimeout
		srv.TLSCACertificate = flags.Filename(cfg.Https.CACert)
		srv.TLSCertificate = flags.Filename(cfg.Https.ServerCert)
		srv.TLSCertificateKey = flags.Filename(cfg.Https.ServerKey)
	}

	api.DictionaryGetExternalDeploymentsHandler = dictionary.NewGetExternalDeploymentsHandler(db)
	api.DictionaryGetDatabaseExtensionsHandler = dictionary.NewGetDbExtensionsHandler(db)
	api.DictionaryGetPostgresVersionsHandler = dictionary.NewGetPostgresVersions(db)

	// environment
	api.EnvironmentGetEnvironmentsHandler = environment.NewGetEnvironmentsHandler(db)
	api.EnvironmentPostEnvironmentsHandler = environment.NewPostEnvironmentsHandler(db, log.Logger)
	api.EnvironmentDeleteEnvironmentsIDHandler = environment.NewDeleteEnvironmentsHandler(db, log.Logger)

	// setting
	api.SettingPostSettingsHandler = setting.NewPostSettingHandler(db)
	api.SettingGetSettingsHandler = setting.NewGetSettingsHandler(db)
	api.SettingPatchSettingsNameHandler = setting.NewPatchSettingHandler(db)

	// project
	api.ProjectPostProjectsHandler = project.NewPostProjectHandler(db, log.Logger)
	api.ProjectGetProjectsHandler = project.NewGetProjectsHandler(db)
	api.ProjectDeleteProjectsIDHandler = project.NewDeleteProjectHandler(db, log.Logger)
	api.ProjectPatchProjectsIDHandler = project.NewPatchProjectHandler(db)

	// secret
	api.SecretPostSecretsHandler = secret.NewPostSecretHandler(db, log.Logger, cfg)
	api.SecretGetSecretsHandler = secret.NewGetSecretHandler(db)
	api.SecretDeleteSecretsIDHandler = secret.NewDeleteSecretHandler(db)

	// cluster
	api.ClusterPostClustersHandler = cluster.NewPostClusterHandler(db, dockerManager, logCollector, cfg, log.Logger, accessSvc)
	api.ClusterDeleteClustersIDHandler = cluster.NewDeleteClusterHandler(db)
	api.OperationGetOperationsHandler = operation.NewGetOperationsHandler(db, accessSvc)
	api.OperationGetOperationsIDLogHandler = operation.NewGetOperationLogHandler(db)
	api.ClusterGetClustersHandler = cluster.NewGetClustersHandler(db, log.Logger, accessSvc)
	api.ClusterGetClustersIDHandler = cluster.NewGetClusterHandler(db, log.Logger)
	api.ClusterGetClustersDefaultNameHandler = cluster.NewGetClusterDefaultNameHandler(db, log.Logger)
	api.ClusterDeleteServersIDHandler = cluster.NewDeleteServerHandler(db, log.Logger)
	api.ClusterPostClustersIDRefreshHandler = cluster.NewPostClusterRefreshHandler(db, log.Logger, clusterWatcher)

	// JumboSQL: sign-in and users
	api.AuthPostAuthLoginHandler = authctl.NewPostAuthLoginHandler(authSvc, log.Logger)
	api.AuthPostAuthLogoutHandler = authctl.NewPostAuthLogoutHandler(authSvc)
	api.AuthGetAuthMeHandler = authctl.NewGetAuthMeHandler(db)
	api.AuthPostAuthPasswordHandler = authctl.NewPostAuthPasswordHandler(db)
	api.UserGetUsersHandler = user.NewGetUsersHandler(db)
	api.UserPostUsersHandler = user.NewPostUserHandler(db, accessSvc)
	api.UserPatchUsersIDHandler = user.NewPatchUserHandler(db, accessSvc)
	api.UserDeleteUsersIDHandler = user.NewDeleteUserHandler(db, accessSvc)

	// JumboSQL: access policies and audit log
	accessCtl := accessctl.New(db, accessSvc)
	api.AccessGetPoliciesHandler = accessCtl.GetPolicies()
	api.AccessPostPoliciesHandler = accessCtl.PostPolicies()
	api.AccessPatchPoliciesIDHandler = accessCtl.PatchPolicy()
	api.AccessDeletePoliciesIDHandler = accessCtl.DeletePolicy()
	api.AccessGetPoliciesPermissionsHandler = accessCtl.GetPermissions()
	api.AccessPostPoliciesSimulateHandler = accessCtl.Simulate()
	api.AccessGetAuditHandler = accessCtl.GetAudit()

	// JumboSQL: Patroni panel (switchover / restart / reinitialize)
	patroniActions := patroni.NewActions(patroni.ActionsConfig{
		Port:     cfg.Patroni.Port,
		Username: cfg.Patroni.Username,
		Password: cfg.Patroni.Password,
		Timeout:  cfg.Patroni.Timeout,
	})
	api.ClusterPostClustersIDSwitchoverHandler = cluster.NewPostClusterSwitchoverHandler(db, log.Logger, patroniActions, clusterWatcher)
	api.ClusterPostServersIDRestartHandler = cluster.NewPostServerRestartHandler(db, log.Logger, patroniActions, clusterWatcher)
	api.ClusterPostServersIDReinitializeHandler = cluster.NewPostServerReinitializeHandler(db, log.Logger, patroniActions, clusterWatcher)
	api.ClusterPostClustersIDPatroniHandler = cluster.NewPostClusterPatroniHandler(db, log.Logger, patroniActions, clusterWatcher, accessSvc)

	// JumboSQL: PostgreSQL logs viewer
	logsList, logsRead := cluster.NewLogsHandlers(db, patroniActions, cfg.DbDesk.SSLMode)
	api.ClusterGetClustersIDLogsHandler = logsList
	api.ClusterGetClustersIDLogsFileHandler = logsRead

	// JumboSQL: SQL editor (runs scripts through HAProxy's read-write port, returns every result set)
	// data scope enforced inside PostgreSQL through console-managed roles (passwords encrypted with the encryption key)
	sqlRoles := sqlroles.NewManager(sqlRoleStore{db: db, key: cfg.EncryptionKey})
	sqlRun, sqlCancel, sqlAccess := cluster.NewSQLHandlers(db, log.Logger, cfg.DbDesk.SSLMode, accessSvc, sqlRoles)
	api.ClusterPostClustersIDSQLHandler = sqlRun
	api.ClusterPostClustersIDSQLCancelHandler = sqlCancel
	api.ClusterGetClustersIDSQLAccessHandler = sqlAccess

	api.SystemGetVersionHandler = system.GetVersionHandlerFunc(func(params system.GetVersionParams) middleware.Responder {
		return system.NewGetVersionOK().WithPayload(&models.ResponseVersion{
			Version: version,
		})
	})

	api.Logger = func(s string, i ...interface{}) {
		log.Debug().Msgf(s, i...)
	}

	srv.ConfigureAPI()

	return &httpService{
		srv: srv,
	}, nil
}

func (s *httpService) Serve() error {
	return s.srv.Serve()
}
