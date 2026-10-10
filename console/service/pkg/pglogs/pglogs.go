// Package pglogs reads PostgreSQL server logs over SQL (pg_genie PostgreSQL logs viewer).
//
// It connects as the superuser to one node and uses pg_ls_logdir() to list the files of log_directory and
// pg_read_binary_file() to read them. Only names that pg_ls_logdir() returns can be read, so no other file on the
// node is reachable. Reads are capped (MaxChunk) and a live tail reads from a byte offset.
package pglogs

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"postgresql-cluster-console/pkg/sqlrun"

	"github.com/jackc/pgx/v5/pgconn"
)

const (
	DefaultTailKB = 256
	MaxChunk      = 8 << 20 // 8 MiB per read
)

type File struct {
	Name     string    `json:"name"`
	Size     int64     `json:"size"`
	Modified time.Time `json:"modified"`
}

type Listing struct {
	LogDirectory string `json:"log_directory"`
	Current      string `json:"current"` // file the server writes to now (pg_current_logfile), base name
	Files        []File `json:"files"`   // newest first
}

type Chunk struct {
	File      string `json:"file"`
	Size      int64  `json:"size"`
	Offset    int64  `json:"offset"`
	Next      int64  `json:"next"`
	Text      string `json:"text"`
	Truncated bool   `json:"truncated"`
}

func rows(ctx context.Context, conn *pgconn.PgConn, sql string, args ...[]byte) ([][][]byte, error) {
	rr := conn.ExecParams(ctx, sql, args, nil, nil, nil)
	var out [][][]byte
	for rr.NextRow() {
		vals := rr.Values()
		row := make([][]byte, len(vals))
		for i, v := range vals {
			row[i] = append([]byte(nil), v...)
		}
		out = append(out, row)
	}
	_, err := rr.Close()
	return out, err
}

func list(ctx context.Context, conn *pgconn.PgConn) (*Listing, error) {
	head, err := rows(ctx, conn, "select current_setting('log_directory'), coalesce(pg_current_logfile(), '')")
	if err != nil {
		return nil, err
	}
	l := &Listing{Files: []File{}}
	if len(head) == 1 {
		l.LogDirectory = string(head[0][0])
		cur := string(head[0][1])
		if i := strings.LastIndexByte(cur, '/'); i >= 0 {
			cur = cur[i+1:]
		}
		l.Current = cur
	}
	files, err := rows(ctx, conn, "select name, size, to_char(modification at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') from pg_ls_logdir() order by modification desc, name desc")
	if err != nil {
		if strings.Contains(err.Error(), "logging collector") || strings.Contains(err.Error(), "No such file") {
			return l, nil // no log files (logging_collector off)
		}
		return nil, err
	}
	for _, f := range files {
		size, _ := strconv.ParseInt(string(f[1]), 10, 64)
		mod, _ := time.Parse(time.RFC3339, string(f[2]))
		l.Files = append(l.Files, File{Name: string(f[0]), Size: size, Modified: mod})
	}
	return l, nil
}

// List returns the log files of the node.
func List(ctx context.Context, node sqlrun.Target) (*Listing, error) {
	conn, err := sqlrun.Connect(ctx, node)
	if err != nil {
		return nil, err
	}
	defer conn.Close(context.Background())
	return list(ctx, conn)
}

// Read returns the end of the file (tailKB) or, with since >= 0, everything from byte offset since.
func Read(ctx context.Context, node sqlrun.Target, file string, tailKB int, since int64) (*Chunk, error) {
	conn, err := sqlrun.Connect(ctx, node)
	if err != nil {
		return nil, err
	}
	defer conn.Close(context.Background())
	l, err := list(ctx, conn)
	if err != nil {
		return nil, err
	}
	var f *File
	for i := range l.Files {
		if l.Files[i].Name == file {
			f = &l.Files[i]
			break
		}
	}
	if f == nil {
		return nil, fmt.Errorf("no log file %q in %s on this node", file, l.LogDirectory)
	}
	if tailKB <= 0 {
		tailKB = DefaultTailKB
	}
	want := int64(tailKB) << 10
	if want > MaxChunk {
		want = MaxChunk
	}
	c := &Chunk{File: f.Name, Size: f.Size}
	var start int64
	switch {
	case since >= 0:
		start = since
		if start > f.Size { // rotated / truncated: start over from the end window
			start = max(0, f.Size-want)
		}
		if f.Size-start > MaxChunk {
			start, c.Truncated = f.Size-MaxChunk, true
		}
	default:
		start = max(0, f.Size-want)
		c.Truncated = start > 0
	}
	length := f.Size - start
	c.Offset, c.Next = start, f.Size
	if length <= 0 {
		return c, nil
	}
	// relative paths are inside the data directory; absolute ones are allowed for the superuser
	pathExpr := "current_setting('log_directory') || '/' || $1"
	data, err := rows(ctx, conn, "select pg_read_binary_file("+pathExpr+", $2::bigint, $3::bigint)",
		[]byte(f.Name), []byte(strconv.FormatInt(start, 10)), []byte(strconv.FormatInt(length, 10)))
	if err != nil {
		return nil, err
	}
	if len(data) == 0 || len(data[0]) == 0 {
		return c, nil
	}
	raw := decodeBytea(data[0][0])
	c.Next = start + int64(len(raw))
	if c.Truncated || (since < 0 && start > 0) {
		if i := strings.IndexByte(string(raw), '\n'); i >= 0 && i < len(raw)-1 {
			raw = raw[i+1:] // start at a whole line
			c.Offset = start + int64(i+1)
		}
	}
	c.Text = strings.ToValidUTF8(string(raw), "�")
	if !utf8.ValidString(c.Text) {
		c.Text = ""
	}
	return c, nil
}

// decodeBytea decodes PostgreSQL's text output of bytea ("\x0a0b...").
func decodeBytea(v []byte) []byte {
	s := string(v)
	if !strings.HasPrefix(s, `\x`) {
		return v
	}
	s = s[2:]
	out := make([]byte, len(s)/2)
	for i := 0; i+1 < len(s); i += 2 {
		b, err := strconv.ParseUint(s[i:i+2], 16, 8)
		if err != nil {
			return v
		}
		out[i/2] = byte(b)
	}
	return out
}
