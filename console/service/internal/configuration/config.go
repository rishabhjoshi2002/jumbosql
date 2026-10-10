package configuration

import (
	"fmt"
	"time"

	"github.com/kelseyhightower/envconfig"
)

type Config struct {
	Logger struct {
		Level string `default:"DEBUG" desc:"Log level. Accepted values: [TRACE, DEBUG, INFO, WARN, ERROR, FATAL, PANIC]"`
	}
	Http struct {
		Host         string        `default:"0.0.0.0" desc:"Accepted host for connection. '0.0.0.0' for all hosts"`
		Port         int           `default:"8080" desc:"Listening port"`
		WriteTimeout time.Duration `default:"180s" desc:"Maximum duration before timing out write of the response (pg_genie: long enough for Patroni restarts)"`
		ReadTimeout  time.Duration `default:"10s" desc:"Maximum duration before timing out read of the request"`
	}
	Https struct {
		IsUsed     bool   `default:"false" desc:"Flag for turn on/off https"`
		Host       string `default:"0.0.0.0" desc:"Accepted host for connection. '0.0.0.0' for all hosts"`
		Port       int    `default:"8081" desc:"Listening port"`
		CACert     string `default:"/etc/pg_console/cacert.pem" desc:"The certificate to use for secure connections"`
		ServerCert string `default:"/etc/pg_console/server-cert.pem" desc:"The certificate authority file to be used with mutual tls auth"`
		ServerKey  string `default:"/etc/pg_console/server-key.pem" desc:"The private key to use for secure connections"`
	}
	Authorization struct {
		Token string `default:"auth_token" desc:"Authorization token for REST API (scripts/automation; people sign in with a username)"`
	}
	// pg_genie: username/password sign-in
	Auth struct {
		SessionTTL    time.Duration `envconfig:"session_ttl" default:"12h" desc:"How long a sign-in lasts"`
		AdminUsername string        `envconfig:"admin_username" default:"admin" desc:"First admin, created when there are no users yet"`
		AdminPassword string        `envconfig:"admin_password" default:"" desc:"First admin's password (empty = use the authorization token)"`
	}
	// pg_genie: Insights (trends, forecasts, recommendations)
	Insights struct {
		Enabled        bool          `envconfig:"enabled" default:"true" desc:"Sample clusters for the Insights page"`
		Interval       time.Duration `envconfig:"interval" default:"5m" desc:"How often cluster-wide numbers are sampled"`
		TablesInterval time.Duration `envconfig:"tables_interval" default:"1h" desc:"How often table sizes and dead rows are sampled"`
		Retention      time.Duration `envconfig:"retention" default:"2160h" desc:"How long samples are kept (default 90 days)"`
	}
	// pg_genie: audit log
	Audit struct {
		Retention time.Duration `envconfig:"retention" default:"4320h" desc:"How long audit events are kept (default 180 days)"`
	}
	Db struct {
		Host            string        `default:"localhost" desc:"Database host"`
		Port            uint16        `default:"5432" desc:"Database port"`
		DbName          string        `default:"postgres" desc:"Database name"`
		User            string        `default:"postgres" desc:"Database user name"`
		Password        string        `default:"postgres-pass" desc:"Database user password"`
		MaxConns        int32         `default:"10" desc:"MaxConns is the maximum size of the pool"`
		MaxConnLifeTime time.Duration `default:"60s" desc:"MaxConnLifetime is the duration since creation after which a connection will be automatically closed"`
		MaxConnIdleTime time.Duration `default:"60s" desc:"MaxConnIdleTime is the duration after which an idle connection will be automatically closed by the health check"`
		MigrationDir    string        `default:"/etc/db/migrations" desc:"Path to directory with migration scripts"`
	}
	EncryptionKey string `default:"super_secret" desc:"Encryption key for secret storage"`
	// pg_genie: the Ansible vault password for vault.yml, handed to each deployment container (never stored).
	// Set PG_CONSOLE_VAULT_PASSWORD, or PG_CONSOLE_VAULT_PASSWORD_FILE for a Docker secret file.
	VaultPassword string `envconfig:"vault_password" default:"" desc:"Ansible vault password for the HA automation (or use _FILE)"`
	Docker        struct {
		Host   string `default:"unix:///var/run/docker.sock" desc:"Docker host"`
		LogDir string `default:"/tmp/ansible" desc:"Directory inside docker container for ansible json log"`
		Image  string `default:"jumbosql/automation-ha:2.2.0" desc:"Docker image for the HA automation (built locally by build.sh)"`
	}
	LogWatcher struct {
		RunEvery    time.Duration `default:"1m" desc:"LogWatcher run interval"`
		AnalyzePast time.Duration `default:"48h" desc:"LogWatcher gets operations to analyze which created_at > now() - AnalyzePast"`
	}
	ClusterWatcher struct {
		RunEvery time.Duration `default:"1m" desc:"ClusterWatcher run interval"`
		PoolSize int64         `default:"4" desc:"Amount of async request from ClusterWatcher"`
	}
	DbDesk struct {
		Enabled bool          `envconfig:"dbdesk_studio_enabled" default:"true" desc:"Enable automatic dbdesk-studio registration after successful cluster deploy"`
		URL     string        `envconfig:"dbdesk_studio_api_url" default:"http://dbdesk-studio:6789" desc:"dbdesk-studio API base URL"`
		SSLMode string        `envconfig:"dbdesk_studio_sslmode" default:"prefer" desc:"SSL mode for dbdesk-studio postgres connection profiles"`
		Timeout time.Duration `envconfig:"dbdesk_studio_timeout" default:"5s" desc:"HTTP timeout for dbdesk-studio health and registration requests"`
	}
	// pg_genie: Patroni REST API access for switchover / restart / reinitialize from the console.
	Patroni struct {
		Port     int           `envconfig:"port" default:"8009" desc:"Patroni REST API port on the database nodes (the HA automation listens on 8009)"`
		Username string        `envconfig:"username" default:"" desc:"Patroni REST API basic-auth user (restapi.authentication), if set"`
		Password string        `envconfig:"password" default:"" desc:"Patroni REST API basic-auth password"`
		Timeout  time.Duration `envconfig:"timeout" default:"30s" desc:"Timeout for Patroni actions (switchover, restart, reinitialize)"`
	}
}

const cfgPrefix = "PG_CONSOLE"

func ReadConfig() (*Config, error) {
	cfg := Config{}

	if err := resolveFileSecrets(cfgPrefix); err != nil {
		return nil, fmt.Errorf("failed to resolve file-backed secrets: %s", err.Error())
	}

	err := envconfig.Process(cfgPrefix, &cfg)
	if err != nil {
		return nil, fmt.Errorf("failed to parse config: %s", err.Error())
	}

	return &cfg, nil
}

func PrintUsage() {
	cfg := Config{}
	err := envconfig.Usage(cfgPrefix, &cfg)
	if err != nil {
		fmt.Printf("failed to print envconfig usage: %s", err.Error())
	}
}

// Redacted returns a copy of the config safe for logging. Secret-bearing
// fields are masked: non-empty values become "[REDACTED]", empty values become
// "[unset]". This preserves the diagnostic value of the startup config dump
// (operators can confirm whether a secret was loaded at all) without writing
// the cleartext value to logs.
func (c *Config) Redacted() Config {
	mask := func(v string) string {
		if v == "" {
			return "[unset]"
		}
		return "[REDACTED]"
	}
	out := *c
	out.Authorization.Token = mask(out.Authorization.Token)
	out.Db.Password = mask(out.Db.Password)
	out.EncryptionKey = mask(out.EncryptionKey)
	out.Patroni.Password = mask(out.Patroni.Password)
	out.VaultPassword = mask(out.VaultPassword)
	out.Auth.AdminPassword = mask(out.Auth.AdminPassword)
	return out
}
