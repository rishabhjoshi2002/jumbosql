// Package sqlrun runs a SQL script against a PostgreSQL server and returns every result set, the way psql
// or pgAdmin's query tool do (pg_genie SQL editor).
//
// The script is sent with the simple query protocol, so it may hold several statements; each statement that
// returns rows (SELECT, SHOW, EXPLAIN, VALUES, TABLE, ... RETURNING, FETCH) gets its own result set with
// column names and types, every other statement its command tag. Values come back as PostgreSQL's text
// output, NULL as nil. Notices (RAISE NOTICE, VACUUM VERBOSE, ...) are collected. On an error the result sets
// of the statements before it are kept and the error carries SQLSTATE, detail, hint and position.
package sqlrun

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

const (
	DefaultMaxRows = 1000
	MaxMaxRows     = 100000
	DefaultTimeout = 5 * time.Minute
	MaxTimeout     = 6 * time.Hour
	maxNotices     = 1000
)

// Target is where to connect (for pg_genie: HAProxy's read-write port, so always the Patroni leader).
type Target struct {
	Host     string
	Port     int
	User     string
	Password string
	Database string
	SSLMode  string // disable / allow / prefer (default) / require
	AppName  string
}

type Column struct {
	Name    string `json:"name"`
	TypeOID uint32 `json:"type_oid"`
	Type    string `json:"type"`
}

// ResultSet is one statement's outcome.
type ResultSet struct {
	Statement  int         `json:"statement"` // 1-based statement number in the script
	Columns    []Column    `json:"columns,omitempty"`
	Rows       [][]*string `json:"rows,omitempty"`
	RowCount   int64       `json:"row_count"` // rows returned or affected
	Truncated  bool        `json:"truncated"` // more rows than MaxRows were returned (only MaxRows are kept)
	CommandTag string      `json:"command_tag"`
	DurationMs float64     `json:"duration_ms"`
}

// SQLError is a PostgreSQL (or connection) error, in the shape the editor shows.
type SQLError struct {
	Message   string `json:"message"`
	Severity  string `json:"severity,omitempty"`
	SQLState  string `json:"sqlstate,omitempty"`
	Detail    string `json:"detail,omitempty"`
	Hint      string `json:"hint,omitempty"`
	Position  int32  `json:"position,omitempty"` // 1-based character offset in the script
	Where     string `json:"where,omitempty"`
	Statement int    `json:"statement,omitempty"` // which statement failed (1-based)
}

type Result struct {
	Results    []ResultSet `json:"results"`
	Notices    []string    `json:"notices,omitempty"`
	Error      *SQLError   `json:"error,omitempty"`
	Cancelled  bool        `json:"cancelled,omitempty"`
	DurationMs float64     `json:"duration_ms"`
	Server     string      `json:"server,omitempty"` // inet_server_addr of the node that ran it
}

type Request struct {
	SQL     string
	MaxRows int
	Timeout time.Duration
	RunID   string // optional; lets Cancel stop this run
}

// Runner runs scripts and keeps the cancel functions of running ones.
type Runner struct {
	mu      sync.Mutex
	running map[string]context.CancelFunc
}

func NewRunner() *Runner { return &Runner{running: map[string]context.CancelFunc{}} }

// Cancel stops a running script (the server gets a cancel request). Returns false if no such run.
func (r *Runner) Cancel(runID string) bool {
	r.mu.Lock()
	cancel, ok := r.running[runID]
	r.mu.Unlock()
	if ok {
		cancel()
	}
	return ok
}

func connString(t Target) string {
	q := func(s string) string { return "'" + escape(s) + "'" }
	ssl := t.SSLMode
	if ssl == "" {
		ssl = "prefer"
	}
	app := t.AppName
	if app == "" {
		app = "pg_genie SQL editor"
	}
	db := t.Database
	if db == "" {
		db = "postgres"
	}
	return fmt.Sprintf("host=%s port=%d user=%s password=%s dbname=%s sslmode=%s application_name=%s connect_timeout=10",
		q(t.Host), t.Port, q(t.User), q(t.Password), q(db), q(ssl), q(app))
}

func escape(s string) string {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' || s[i] == '\'' {
			out = append(out, '\\')
		}
		out = append(out, s[i])
	}
	return string(out)
}

// Connect opens a connection to the target (used for console-side work such as managing SQL roles).
func Connect(ctx context.Context, t Target) (*pgconn.PgConn, error) {
	return pgconn.Connect(ctx, connString(t))
}

// Run executes the script and returns what happened. The returned error is only for problems that are not
// SQL errors (bad input); SQL and connection errors are in Result.Error.
func (r *Runner) Run(ctx context.Context, t Target, req Request) (*Result, error) {
	if t.Host == "" || t.Port == 0 {
		return nil, errors.New("the cluster has no connection address yet (is the deployment finished?)")
	}
	maxRows := req.MaxRows
	if maxRows <= 0 {
		maxRows = DefaultMaxRows
	}
	if maxRows > MaxMaxRows {
		maxRows = MaxMaxRows
	}
	timeout := req.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	if timeout > MaxTimeout {
		timeout = MaxTimeout
	}

	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if req.RunID != "" {
		r.mu.Lock()
		r.running[req.RunID] = cancel
		r.mu.Unlock()
		defer func() {
			r.mu.Lock()
			delete(r.running, req.RunID)
			r.mu.Unlock()
		}()
	}

	start := time.Now()
	res := &Result{Results: []ResultSet{}}
	cfg, err := pgconn.ParseConfig(connString(t))
	if err != nil {
		return nil, fmt.Errorf("connection settings: %w", err)
	}
	var noticeMu sync.Mutex
	cfg.OnNotice = func(_ *pgconn.PgConn, n *pgconn.Notice) {
		noticeMu.Lock()
		defer noticeMu.Unlock()
		if len(res.Notices) < maxNotices {
			res.Notices = append(res.Notices, n.Severity+": "+n.Message)
		}
	}

	conn, err := pgconn.ConnectConfig(ctx, cfg)
	if err != nil {
		res.Error = toSQLError(err, 0)
		res.DurationMs = ms(time.Since(start))
		return res, nil
	}
	defer conn.Close(context.Background())
	if addr := serverAddr(ctx, conn); addr != "" {
		res.Server = addr
	}

	stmt := 0
	mrr := conn.Exec(ctx, req.SQL)
	for mrr.NextResult() {
		stmt++
		rr := mrr.ResultReader()
		stStart := time.Now()
		set := ResultSet{Statement: stmt}
		fields := rr.FieldDescriptions()
		for _, f := range fields {
			set.Columns = append(set.Columns, Column{Name: f.Name, TypeOID: f.DataTypeOID})
		}
		var n int64
		for rr.NextRow() {
			n++
			if int(n) > maxRows {
				set.Truncated = true
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
			set.Rows = append(set.Rows, row)
		}
		tag, rerr := rr.Close()
		set.CommandTag = tag.String()
		set.DurationMs = ms(time.Since(stStart))
		switch {
		case len(fields) > 0:
			set.RowCount = n
		default:
			set.RowCount = tag.RowsAffected()
		}
		if rerr != nil {
			if len(fields) > 0 || set.CommandTag != "" {
				res.Results = append(res.Results, set)
			}
			res.Error = toSQLError(rerr, stmt)
			break
		}
		res.Results = append(res.Results, set)
	}
	if err := mrr.Close(); err != nil && res.Error == nil {
		res.Error = toSQLError(err, stmt+1)
	}
	if res.Error != nil && ctx.Err() != nil {
		res.Cancelled = true
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			res.Error.Message = fmt.Sprintf("stopped after the %s time limit: %s", timeout, res.Error.Message)
		} else {
			res.Error = &SQLError{Message: "query cancelled", Statement: res.Error.Statement}
		}
	}

	r.typeNames(res, conn)
	res.DurationMs = ms(time.Since(start))
	return res, nil
}

// typeNames fills Column.Type (format_type) for the OIDs seen, on the same connection.
func (r *Runner) typeNames(res *Result, conn *pgconn.PgConn) {
	seen := map[uint32]bool{}
	var oids []string
	for _, s := range res.Results {
		for _, c := range s.Columns {
			if !seen[c.TypeOID] {
				seen[c.TypeOID] = true
				oids = append(oids, strconv.FormatUint(uint64(c.TypeOID), 10))
			}
		}
	}
	if len(oids) == 0 || conn.IsClosed() {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	list := ""
	for i, o := range oids {
		if i > 0 {
			list += ","
		}
		list += o
	}
	rr := conn.ExecParams(ctx, "select oid::text, format_type(oid, null) from pg_type where oid in ("+list+")", nil, nil, nil, nil)
	names := map[string]string{}
	for rr.NextRow() {
		v := rr.Values()
		names[string(v[0])] = string(v[1])
	}
	if _, err := rr.Close(); err != nil {
		return
	}
	for i := range res.Results {
		for j := range res.Results[i].Columns {
			c := &res.Results[i].Columns[j]
			c.Type = names[strconv.FormatUint(uint64(c.TypeOID), 10)]
		}
	}
}

func serverAddr(ctx context.Context, conn *pgconn.PgConn) string {
	rr := conn.ExecParams(ctx, "select coalesce(host(inet_server_addr()), 'local socket')", nil, nil, nil, nil)
	addr := ""
	if rr.NextRow() {
		addr = string(rr.Values()[0])
	}
	_, _ = rr.Close()
	return addr
}

func toSQLError(err error, statement int) *SQLError {
	var pe *pgconn.PgError
	if errors.As(err, &pe) {
		return &SQLError{
			Message: pe.Message, Severity: pe.Severity, SQLState: pe.Code, Detail: pe.Detail, Hint: pe.Hint,
			Position: pe.Position, Where: pe.Where, Statement: statement,
		}
	}
	return &SQLError{Message: err.Error(), Statement: statement}
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }
