package configuration

import (
	"bytes"
	"strings"
	"testing"

	"github.com/kelseyhightower/envconfig"
)

// The pg_genie settings must have the names the docs and build.sh use (nested sections must not repeat the
// section name: PG_CONSOLE_PATRONI_PORT, not PG_CONSOLE_PATRONI_PATRONI_PORT).
func TestEnvNames(t *testing.T) {
	var cfg Config
	var buf bytes.Buffer
	if err := envconfig.Usagef(cfgPrefix, &cfg, &buf, "{{range .}}{{usage_key .}}\n{{end}}"); err != nil {
		t.Fatal(err)
	}
	keys := buf.String()
	for _, want := range []string{"PG_CONSOLE_AUTH_SESSION_TTL", "PG_CONSOLE_AUTH_ADMIN_USERNAME", "PG_CONSOLE_AUTH_ADMIN_PASSWORD",
		"PG_CONSOLE_AUDIT_RETENTION", "PG_CONSOLE_INSIGHTS_ENABLED", "PG_CONSOLE_INSIGHTS_INTERVAL",
		"PG_CONSOLE_INSIGHTS_TABLES_INTERVAL", "PG_CONSOLE_INSIGHTS_RETENTION", "PG_CONSOLE_PATRONI_PORT", "PG_CONSOLE_PATRONI_USERNAME", "PG_CONSOLE_PATRONI_PASSWORD",
		"PG_CONSOLE_PATRONI_TIMEOUT", "PG_CONSOLE_VAULT_PASSWORD", "PG_CONSOLE_AUTHORIZATION_TOKEN", "PG_CONSOLE_ENCRYPTIONKEY"} {
		if !strings.Contains(keys, want+"\n") {
			t.Errorf("missing %s", want)
		}
	}
	if strings.Contains(keys, "PATRONI_PATRONI") || strings.Contains(keys, "AUTH_AUTH") || strings.Contains(keys, "AUDIT_AUDIT") || strings.Contains(keys, "INSIGHTS_INSIGHTS") {
		t.Errorf("doubled section names:\n%s", keys)
	}
}
