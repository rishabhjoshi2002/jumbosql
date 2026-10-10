package discover

// Read-only queries for the Discover panel: one statement, checked, then run inside a READ ONLY transaction
// with a time limit, and rolled back.

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"

	"postgresql-cluster-console/pkg/sqlrun"
)

type QueryRequest struct {
	Target   Target
	User     string
	Password string
	Database string
	SSLMode  string
	SQL      string
	MaxRows  int
}

type QueryResult struct {
	Columns    []string    `json:"columns"`
	Rows       [][]*string `json:"rows"`
	RowCount   int         `json:"row_count"`
	Truncated  bool        `json:"truncated"`
	DurationMs float64     `json:"duration_ms"`
	Error      string      `json:"error,omitempty"`
}

var (
	commentRe = regexp.MustCompile(`(?s)/\*.*?\*/|--[^\n]*`)
	// statements that only read
	readStartRe = regexp.MustCompile(`(?i)^\s*\(*\s*(select|with|show|explain|table|values)\b`)
	// functions that act on the server without writing data (a read-only transaction does not stop them),
	// and ones that run SQL given as a string
	blockedRe = regexp.MustCompile(`(?i)\b(pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|` +
		`pg_switch_wal|pg_switch_xlog|pg_create_restore_point|pg_(create|drop|copy)_\w*replication_slot|pg_replication_slot_advance|` +
		`pg_replication_origin_\w+|pg_promote|pg_wal_replay_(pause|resume)|pg_backup_(start|stop)|pg_(start|stop)_backup|` +
		`pg_stat_reset\w*|pg_read_(binary_)?file|pg_ls_\w+|pg_file_\w+|lo_(import|export|unlink|from_bytea|put)|` +
		`dblink\w*|query_to_xml\w*|cursor_to_xml\w*|set_config|pg_advisory\w*|pg_logical_emit_message|` +
		`pg_import_system_collations|txid_current|pg_current_xact_id|nextval|setval)\s*\(`)
)

// CheckReadOnly refuses anything but one reading statement.
func CheckReadOnly(sql string) (string, error) {
	s := strings.TrimSpace(sql)
	s = strings.TrimRight(s, "; \n\t\r")
	if s == "" {
		return "", errors.New("the query is empty")
	}
	if len(s) > 100_000 {
		return "", errors.New("the query is too long")
	}
	plain := commentRe.ReplaceAllString(s, " ")
	if !readStartRe.MatchString(plain) {
		return "", errors.New("only reading statements are allowed here: SELECT, WITH, SHOW, EXPLAIN, TABLE, VALUES")
	}
	if strings.Contains(stripLiterals(plain), ";") {
		return "", errors.New("one statement at a time")
	}
	if m := blockedRe.FindString(s); m != "" {
		return "", errors.New("not allowed here (it changes the server, not just reads): " + strings.TrimRight(m, "( "))
	}
	return s, nil
}

// stripLiterals blanks quoted strings and identifiers so a ';' inside them is not taken for a second statement.
func stripLiterals(s string) string {
	var b strings.Builder
	var quote byte
	for i := 0; i < len(s); i++ {
		ch := s[i]
		switch {
		case quote != 0:
			if ch == quote {
				quote = 0
			}
		case ch == '\'' || ch == '"':
			quote = ch
		default:
			b.WriteByte(ch)
		}
	}
	return b.String()
}

func RunQuery(ctx context.Context, req QueryRequest) (*QueryResult, error) {
	sql, err := CheckReadOnly(req.SQL)
	if err != nil {
		return nil, err
	}
	maxRows := req.MaxRows
	if maxRows <= 0 || maxRows > 5000 {
		maxRows = 1000
	}
	res := &QueryResult{Columns: []string{}, Rows: [][]*string{}}
	db := req.Database
	if db == "" {
		db = "postgres"
	}
	c, err := sqlrun.Connect(ctx, sqlrun.Target{Host: req.Target.Host, Port: req.Target.Port, User: req.User,
		Password: req.Password, Database: db, SSLMode: req.SSLMode, AppName: "pg_genie discover"})
	if err != nil {
		res.Error = friendlyErr(err)
		return res, nil
	}
	defer c.Close(context.Background())
	// read-only transaction; the SELECT 1 takes the snapshot, so it cannot be switched to read-write afterwards
	if _, err := c.Exec(ctx, `BEGIN TRANSACTION READ ONLY; SET LOCAL statement_timeout = '30s';
		SET LOCAL lock_timeout = '3s'; SET LOCAL idle_in_transaction_session_timeout = '60s'; SELECT 1`).ReadAll(); err != nil {
		res.Error = friendlyErr(err)
		return res, nil
	}
	defer func() { _, _ = c.Exec(context.Background(), "ROLLBACK").ReadAll() }()

	start := time.Now()
	rr := c.ExecParams(ctx, sql, nil, nil, nil, nil) // extended protocol: exactly one statement
	for _, f := range rr.FieldDescriptions() {
		res.Columns = append(res.Columns, f.Name)
	}
	for rr.NextRow() {
		res.RowCount++
		if len(res.Rows) >= maxRows {
			res.Truncated = true
			continue
		}
		vals := rr.Values()
		row := make([]*string, len(vals))
		for i, v := range vals {
			if v != nil {
				s := string(v)
				row[i] = &s
			}
		}
		res.Rows = append(res.Rows, row)
	}
	if _, err := rr.Close(); err != nil {
		res.Error = friendlyErr(err)
	}
	if len(res.Columns) == 0 { // FieldDescriptions are known only after the first read for some statements
		for _, f := range rr.FieldDescriptions() {
			res.Columns = append(res.Columns, f.Name)
		}
	}
	res.DurationMs = float64(time.Since(start).Microseconds()) / 1000
	return res, nil
}
