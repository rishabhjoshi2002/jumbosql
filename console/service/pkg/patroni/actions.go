package patroni

// JumboSQL: write operations against the Patroni REST API (switchover, restart, reinitialize).
// The read-only client in client.go is used by the cluster watcher; this one is used by the API handlers
// behind the console's Patroni panel.

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// ActionsConfig - how to reach Patroni on the database nodes.
type ActionsConfig struct {
	Port     int
	Username string
	Password string
	Timeout  time.Duration
}

// IActions - Patroni operations exposed in the console.
type IActions interface {
	// GetCluster returns the /cluster view from the first node in hosts that answers.
	GetCluster(ctx context.Context, hosts []string) (*ClusterInfo, error)
	// Switchover moves the leader role. candidate may be empty to let Patroni choose.
	Switchover(ctx context.Context, host, leader, candidate string) (string, error)
	// Restart restarts PostgreSQL on host.
	Restart(ctx context.Context, host string) (string, error)
	// Reinitialize rebuilds the replica on host from the leader.
	Reinitialize(ctx context.Context, host string) (string, error)
	// Failover promotes candidate even without a healthy leader (patronictl failover).
	Failover(ctx context.Context, host, candidate string) (string, error)
	// Reload makes Patroni re-read its configuration on host (patronictl reload).
	Reload(ctx context.Context, host string) (string, error)
	// Raw sends any request and returns the decoded JSON (or the text) - used for history and config.
	Raw(ctx context.Context, method, host, path string, body interface{}) (interface{}, error)
}

type actions struct {
	cfg   ActionsConfig
	http  *http.Client
	https *http.Client
}

func NewActions(cfg ActionsConfig) IActions {
	if cfg.Port == 0 {
		cfg.Port = 8008
	}
	if cfg.Timeout == 0 {
		cfg.Timeout = 30 * time.Second
	}
	return &actions{
		cfg:  cfg,
		http: &http.Client{Timeout: cfg.Timeout},
		https: &http.Client{
			Timeout: cfg.Timeout,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec // Patroni often runs with self-signed certs
			},
		},
	}
}

// PatroniError - Patroni answered, but refused the request (e.g. "candidate is not healthy").
type PatroniError struct {
	Status int
	Body   string
}

func (e *PatroniError) Error() string {
	return fmt.Sprintf("patroni returned %d: %s", e.Status, e.Body)
}

func (a *actions) baseURL(scheme, host string) string {
	return scheme + "://" + net.JoinHostPort(host, strconv.Itoa(a.cfg.Port))
}

// do sends the request over HTTPS and falls back to HTTP only when HTTPS can't connect at all.
// An HTTP error status from Patroni is returned as-is (no retry), so an action is never sent twice.
func (a *actions) do(ctx context.Context, method, host, path string, body interface{}) ([]byte, error) {
	var payload []byte
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			return nil, err
		}
	}

	send := func(client *http.Client, scheme string) ([]byte, error) {
		req, err := http.NewRequestWithContext(ctx, method, a.baseURL(scheme, host)+path, bytes.NewReader(payload))
		if err != nil {
			return nil, err
		}
		if payload != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if a.cfg.Username != "" {
			req.SetBasicAuth(a.cfg.Username, a.cfg.Password)
		}
		resp, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		defer func() { _ = resp.Body.Close() }()
		respBody, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		if err != nil {
			return nil, err
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return nil, &PatroniError{Status: resp.StatusCode, Body: strings.TrimSpace(string(respBody))}
		}
		return respBody, nil
	}

	out, err := send(a.https, "https")
	if err == nil {
		return out, nil
	}
	var pErr *PatroniError
	if errors.As(err, &pErr) {
		return nil, err
	}
	// HTTPS failed below the HTTP layer (refused / TLS handshake): Patroni is serving plain HTTP.
	return send(a.http, "http")
}

func (a *actions) GetCluster(ctx context.Context, hosts []string) (*ClusterInfo, error) {
	var lastErr error
	for _, h := range hosts {
		body, err := a.do(ctx, http.MethodGet, h, "/cluster", nil)
		if err != nil {
			lastErr = err
			continue
		}
		var info ClusterInfo
		if err = json.Unmarshal(body, &info); err != nil {
			lastErr = err
			continue
		}
		return &info, nil
	}
	if lastErr == nil {
		lastErr = errors.New("no database servers to ask")
	}
	return nil, fmt.Errorf("patroni is not reachable on any node: %w", lastErr)
}

func (a *actions) Switchover(ctx context.Context, host, leader, candidate string) (string, error) {
	req := map[string]string{"leader": leader}
	if candidate != "" {
		req["candidate"] = candidate
	}
	body, err := a.do(ctx, http.MethodPost, host, "/switchover", req)
	return strings.TrimSpace(string(body)), err
}

func (a *actions) Restart(ctx context.Context, host string) (string, error) {
	body, err := a.do(ctx, http.MethodPost, host, "/restart", map[string]interface{}{})
	return strings.TrimSpace(string(body)), err
}

func (a *actions) Reinitialize(ctx context.Context, host string) (string, error) {
	body, err := a.do(ctx, http.MethodPost, host, "/reinitialize", map[string]interface{}{})
	return strings.TrimSpace(string(body)), err
}

func (a *actions) Failover(ctx context.Context, host, candidate string) (string, error) {
	body, err := a.do(ctx, http.MethodPost, host, "/failover", map[string]string{"candidate": candidate})
	return strings.TrimSpace(string(body)), err
}

func (a *actions) Reload(ctx context.Context, host string) (string, error) {
	body, err := a.do(ctx, http.MethodPost, host, "/reload", nil)
	return strings.TrimSpace(string(body)), err
}

func (a *actions) Raw(ctx context.Context, method, host, path string, body interface{}) (interface{}, error) {
	raw, err := a.do(ctx, method, host, path, body)
	if err != nil {
		return nil, err
	}
	var out interface{}
	if json.Unmarshal(raw, &out) == nil {
		return out, nil
	}
	return strings.TrimSpace(string(raw)), nil
}
