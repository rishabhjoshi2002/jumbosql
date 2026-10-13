package upgrade

// Custom playbooks from GitHub: the repository (github.com or GitHub Enterprise) is pulled as an archive at a
// branch, tag or commit and kept with the playbook, like an uploaded archive; "Pull Latest" pulls it again.
// A token for a private repository is used for that pull only and never saved.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// pulled: an archive taken from a repository
type pulled struct {
	data   []byte
	name   string
	url    string // the repository, normalized (https://host/owner/repo)
	ref    string
	commit string
	at     time.Time
}

var (
	repoPart  = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)
	refRe     = regexp.MustCompile(`^[A-Za-z0-9_./-]{1,200}$`)
	shortSHA  = regexp.MustCompile(`-([0-9a-f]{7,40})/?$`)
	githubAPI = func(host string) string { // overridable in tests
		if host == "github.com" || host == "www.github.com" {
			return "https://api.github.com"
		}
		return "https://" + host + "/api/v3"
	}
	httpClient = &http.Client{Timeout: 3 * time.Minute}
)

// parseRepo: https://github.com/owner/repo(.git), github.com/owner/repo, owner/repo, or a GitHub Enterprise
// address -> host, owner, repo.
func parseRepo(s string) (host, owner, repo string, err error) {
	s = strings.TrimSpace(s)
	s = strings.TrimSuffix(strings.TrimSuffix(s, "/"), ".git")
	if strings.HasPrefix(s, "git@") { // git@github.com:owner/repo
		s = "https://" + strings.Replace(strings.TrimPrefix(s, "git@"), ":", "/", 1)
	}
	if !strings.Contains(s, "://") {
		if strings.Count(s, "/") == 1 {
			s = "github.com/" + s
		}
		s = "https://" + s
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" {
		return "", "", "", fmt.Errorf("%q is not a repository address", s)
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) < 2 || !repoPart.MatchString(parts[0]) || !repoPart.MatchString(parts[1]) {
		return "", "", "", errors.New("give the repository as https://github.com/owner/repo")
	}
	return strings.ToLower(u.Host), parts[0], parts[1], nil
}

// pullRepo downloads the repository at ref (empty: the default branch).
func pullRepo(ctx context.Context, repoURL, ref, token string) (*pulled, error) {
	host, owner, repo, err := parseRepo(repoURL)
	if err != nil {
		return nil, err
	}
	ref = strings.TrimSpace(ref)
	if ref != "" && (!refRe.MatchString(ref) || strings.Contains(ref, "..")) {
		return nil, fmt.Errorf("%q is not a branch, tag or commit", ref)
	}
	api := fmt.Sprintf("%s/repos/%s/%s/tarball", githubAPI(host), owner, repo)
	if ref != "" {
		api += "/" + url.PathEscape(ref)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, api, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "pg_MANTRA")
	if t := strings.TrimSpace(token); t != "" {
		req.Header.Set("Authorization", "Bearer "+t)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("could not reach %s: %w", host, err)
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return nil, fmt.Errorf("%s/%s (%s) not found: check the address and the branch, or give a token for a private repository",
			owner, repo, orDefault(ref))
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		return nil, fmt.Errorf("GitHub refused the download (%d): %s - check the token", resp.StatusCode, strings.TrimSpace(string(b)))
	case resp.StatusCode != http.StatusOK:
		return nil, fmt.Errorf("GitHub answered %s", resp.Status)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxArchive+1))
	if err != nil {
		return nil, fmt.Errorf("download: %w", err)
	}
	if int64(len(data)) > maxArchive {
		return nil, fmt.Errorf("the repository is larger than %d MB", maxArchive>>20)
	}
	p := &pulled{data: data, name: repo + ".tar.gz", url: fmt.Sprintf("https://%s/%s/%s", host, owner, repo), ref: ref,
		at: time.Now()}
	// the archive's top folder is owner-repo-<commit>
	if entries, err := archiveEntries(data, p.name); err == nil && len(entries) > 0 {
		top, _, _ := strings.Cut(strings.TrimPrefix(entries[0].name, "./"), "/")
		if m := shortSHA.FindStringSubmatch(top); m != nil {
			p.commit = m[1]
		}
	}
	return p, nil
}

func orDefault(ref string) string {
	if ref == "" {
		return "default branch"
	}
	return ref
}
