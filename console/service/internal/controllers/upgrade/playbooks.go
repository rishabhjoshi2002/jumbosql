package upgrade

// Custom playbooks: your own upgrade playbook (and its rollback playbook), with the inputs it needs. The console
// asks for those inputs, the machines (a saved Discover result, a cluster or your own inventory) and the SSH login,
// writes the playbook files to a folder the runner container sees, and starts the upgrade runner image:
//   plan      dry run: ansible-playbook --check --diff (nothing is changed; "changed" = would change)
//   run       the upgrade playbook (after a dry run)
//   rollback  the rollback playbook (after a run)
// Each run gets pgm = {id, action, run_id, playbook} as extra vars (run_id: the run a rollback undoes).

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"postgresql-cluster-console/internal/controllers"
	clusterctl "postgresql-cluster-console/internal/controllers/cluster"
	"postgresql-cluster-console/internal/storage"
	"postgresql-cluster-console/internal/xdocker"
	localmid "postgresql-cluster-console/middleware"
	"postgresql-cluster-console/models"
	"postgresql-cluster-console/pkg/tracer"
	ops "postgresql-cluster-console/restapi/operations/playbook"

	"github.com/go-openapi/runtime/middleware"
	"go.yaml.in/yaml/v3"
)

// Variable: an input of a playbook, asked at each run.
type Variable struct {
	Name     string   `json:"name"`
	Label    string   `json:"label,omitempty"`
	Type     string   `json:"type"` // text | password | number | boolean | select | textarea
	Required bool     `json:"required,omitempty"`
	Default  any      `json:"default,omitempty"`
	Options  []string `json:"options,omitempty"`
	Help     string   `json:"help,omitempty"`
}

// Group: an inventory group the playbook uses, filled with the machines where Discover found a component.
type Group struct {
	Group string `json:"group"`
	From  string `json:"from"` // a component kind (postgres, etcd, haproxy, ...) or "all"
}

var (
	nameRe       = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	varTypes     = map[string]bool{"text": true, "password": true, "number": true, "boolean": true, "select": true, "textarea": true}
	maxArchive   = int64(50 << 20)  // stored archive
	maxExtracted = int64(200 << 20) // extracted
)

const secretMask = "********"

func pbBad(err error) middleware.Responder {
	return ops.NewGetCustomPlaybooksBadRequest().WithPayload(controllers.MakeErrorPayload(err, controllers.BaseError))
}

func playbookView(p *storage.Playbook) map[string]any {
	var vars, groups any
	_ = json.Unmarshal(p.Variables, &vars)
	_ = json.Unmarshal(p.Groups, &groups)
	return map[string]any{"id": p.ID, "name": p.Name, "description": p.Description, "playbook": p.Playbook,
		"playbook_path": p.PlaybookPath, "rollback": p.Rollback, "rollback_path": p.RollbackPath, "requirements": p.Requirements,
		"variables": vars, "groups": groups, "files_name": p.FilesName, "files_size": p.FilesSize,
		"has_rollback": p.Rollback != "" || p.RollbackPath != "",
		"git_url":      p.GitURL, "git_ref": p.GitRef, "git_commit": p.GitCommit, "git_pulled_at": p.GitPulledAt,
		"created_by": p.CreatedBy, "created_at": p.CreatedAt, "updated_at": p.UpdatedAt}
}

/* ------------------------------------------------------------ playbooks: list, one, add, change, remove */

type pbList struct{ *Handlers }
type pbOne struct{ *Handlers }
type pbAdd struct{ *Handlers }
type pbChange struct{ *Handlers }
type pbRemove struct{ *Handlers }
type pbRuns struct{ *Handlers }
type pbRun struct{ *Handlers }
type pbStart struct{ *Handlers }

func (h *Handlers) PlaybookList() ops.GetCustomPlaybooksHandler        { return pbList{h} }
func (h *Handlers) PlaybookOne() ops.GetCustomPlaybooksIDHandler       { return pbOne{h} }
func (h *Handlers) PlaybookAdd() ops.PostCustomPlaybooksHandler        { return pbAdd{h} }
func (h *Handlers) PlaybookChange() ops.PutCustomPlaybooksIDHandler    { return pbChange{h} }
func (h *Handlers) PlaybookRemove() ops.DeleteCustomPlaybooksIDHandler { return pbRemove{h} }
func (h *Handlers) PlaybookRuns() ops.GetCustomPlaybooksIDRunsHandler  { return pbRuns{h} }
func (h *Handlers) PlaybookRun() ops.GetCustomPlaybooksIDRunsUIDHandler {
	return pbRun{h}
}
func (h *Handlers) PlaybookStart() ops.PostCustomPlaybooksIDRunsHandler { return pbStart{h} }

func (h pbList) Handle(p ops.GetCustomPlaybooksParams) middleware.Responder {
	list, err := h.db.ListPlaybooks(p.HTTPRequest.Context())
	if err != nil {
		return pbBad(err)
	}
	out := make([]any, 0, len(list))
	for i := range list {
		out = append(out, playbookView(&list[i]))
	}
	return ops.NewGetCustomPlaybooksOK().WithPayload(out)
}

func (h pbOne) Handle(p ops.GetCustomPlaybooksIDParams) middleware.Responder {
	pb, err := h.db.GetPlaybook(p.HTTPRequest.Context(), p.ID, false)
	if err != nil || pb == nil {
		return pbBad(fmt.Errorf("playbook %d not found", p.ID))
	}
	return ops.NewGetCustomPlaybooksIDOK().WithPayload(playbookView(pb))
}

func (h pbAdd) Handle(p ops.PostCustomPlaybooksParams) middleware.Responder {
	var src *pulled
	if p.Body != nil && strings.TrimSpace(p.Body.GitURL) != "" {
		var err error
		if src, err = pullRepo(p.HTTPRequest.Context(), p.Body.GitURL, p.Body.GitRef, p.Body.GitToken); err != nil {
			return pbBad(err)
		}
	}
	pb, keep, err := playbookFrom(p.Body, nil, src)
	if err != nil {
		return pbBad(err)
	}
	if pr := localmid.PrincipalFrom(p.HTTPRequest.Context()); pr != nil {
		pb.CreatedBy = pr.Username
	}
	out, err := h.db.SavePlaybook(p.HTTPRequest.Context(), pb, keep)
	if err != nil {
		return pbBad(saveErr(err))
	}
	return ops.NewPostCustomPlaybooksOK().WithPayload(playbookView(out))
}

func (h pbChange) Handle(p ops.PutCustomPlaybooksIDParams) middleware.Responder {
	ctx := p.HTTPRequest.Context()
	old, err := h.db.GetPlaybook(ctx, p.ID, true)
	if err != nil || old == nil {
		return pbBad(fmt.Errorf("playbook %d not found", p.ID))
	}
	var src *pulled
	if b := p.Body; b != nil && strings.TrimSpace(b.GitURL) != "" {
		// pull again when asked, when the repository or branch changed, or when nothing was pulled yet
		same := false
		if host, owner, repo, err := parseRepo(b.GitURL); err == nil {
			same = old.GitURL == fmt.Sprintf("https://%s/%s/%s", host, owner, repo) && old.GitRef == strings.TrimSpace(b.GitRef)
		}
		if b.GitPull || !same || len(old.Files) == 0 {
			if src, err = pullRepo(ctx, b.GitURL, b.GitRef, b.GitToken); err != nil {
				return pbBad(err)
			}
		} else {
			b.FilesKeep, b.FilesBase64 = true, ""
		}
	}
	pb, keep, err := playbookFrom(p.Body, old, src)
	if err != nil {
		return pbBad(err)
	}
	pb.ID = p.ID
	out, err := h.db.SavePlaybook(ctx, pb, keep)
	if err != nil || out == nil {
		return pbBad(saveErr(err))
	}
	return ops.NewPutCustomPlaybooksIDOK().WithPayload(playbookView(out))
}

func saveErr(err error) error {
	if err != nil && strings.Contains(err.Error(), "custom_playbooks_name_key") {
		return errors.New("a playbook with this name already exists")
	}
	if err == nil {
		return errors.New("not saved")
	}
	return err
}

func (h pbRemove) Handle(p ops.DeleteCustomPlaybooksIDParams) middleware.Responder {
	ctx := p.HTTPRequest.Context()
	runs, err := h.db.ListPlaybookRuns(ctx, p.ID, 20)
	if err != nil {
		return pbBad(err)
	}
	for _, r := range runs {
		if r.Status == "running" {
			return pbBad(fmt.Errorf("run #%d of this playbook is still running", r.ID))
		}
	}
	if err := h.db.DeletePlaybook(ctx, p.ID); err != nil {
		return pbBad(err)
	}
	return ops.NewDeleteCustomPlaybooksIDOK().WithPayload(map[string]any{"deleted": p.ID})
}

// playbookFrom checks a request and makes the stored playbook. old: the playbook being changed (with its archive).
func playbookFrom(b *models.RequestPlaybook, old *storage.Playbook, src *pulled) (*storage.Playbook, bool, error) {
	if b == nil || b.Name == nil || strings.TrimSpace(*b.Name) == "" {
		return nil, false, errors.New("give the playbook a name")
	}
	pb := &storage.Playbook{Name: strings.TrimSpace(*b.Name), Description: strings.TrimSpace(b.Description),
		Playbook: b.Playbook, PlaybookPath: cleanRel(b.PlaybookPath), Rollback: b.Rollback, RollbackPath: cleanRel(b.RollbackPath),
		Requirements: b.Requirements}
	keep := false
	switch {
	case src != nil: // pulled from GitHub
		pb.Files, pb.FilesName = src.data, src.name
		pb.GitURL, pb.GitRef, pb.GitCommit = src.url, src.ref, src.commit
		pb.GitPulledAt = &src.at
	case strings.TrimSpace(b.GitURL) != "" && old != nil && len(old.Files) > 0: // from GitHub, not pulled again
		keep, pb.Files, pb.FilesName = true, old.Files, old.FilesName
		pb.GitURL, pb.GitRef, pb.GitCommit, pb.GitPulledAt = old.GitURL, old.GitRef, old.GitCommit, old.GitPulledAt
	case b.FilesBase64 != "":
		data, err := base64.StdEncoding.DecodeString(b.FilesBase64)
		if err != nil {
			return nil, false, errors.New("the archive could not be read (base64)")
		}
		if int64(len(data)) > maxArchive {
			return nil, false, fmt.Errorf("the archive is larger than %d MB", maxArchive>>20)
		}
		pb.Files, pb.FilesName = data, filepath.Base(strings.TrimSpace(b.FilesName))
		if pb.FilesName == "" || pb.FilesName == "." {
			pb.FilesName = "files.tar.gz"
		}
	case b.FilesKeep && old != nil:
		keep, pb.Files, pb.FilesName = true, old.Files, old.FilesName
	}
	var names map[string]bool
	if len(pb.Files) > 0 {
		var err error
		if names, err = archiveNames(pb.Files, pb.FilesName); err != nil {
			return nil, false, err
		}
	}
	check := func(text, rel, what string, required bool) error {
		switch {
		case strings.TrimSpace(text) != "" && rel != "":
			return fmt.Errorf("%s: paste it or give its path in the archive, not both", what)
		case strings.TrimSpace(text) != "":
			var plays []map[string]any
			if err := yaml.Unmarshal([]byte(text), &plays); err != nil {
				return fmt.Errorf("%s is not a playbook (a YAML list of plays): %v", what, err)
			}
			if len(plays) == 0 {
				return fmt.Errorf("%s has no play", what)
			}
		case rel != "":
			if names == nil {
				return fmt.Errorf("%s: %q needs the archive", what, rel)
			}
			if !names[rel] {
				return fmt.Errorf("%s: %q is not in the archive", what, rel)
			}
		case required:
			return fmt.Errorf("%s is required", what)
		}
		return nil
	}
	if err := check(pb.Playbook, pb.PlaybookPath, "the upgrade playbook", true); err != nil {
		return nil, false, err
	}
	if err := check(pb.Rollback, pb.RollbackPath, "the rollback playbook", false); err != nil {
		return nil, false, err
	}
	if strings.TrimSpace(pb.Requirements) != "" {
		var req any
		if err := yaml.Unmarshal([]byte(pb.Requirements), &req); err != nil {
			return nil, false, fmt.Errorf("requirements.yml: %v", err)
		}
	}

	vars := []Variable{}
	seen := map[string]bool{}
	for _, raw := range b.Variables {
		var v Variable
		if err := remarshal(raw, &v); err != nil {
			return nil, false, fmt.Errorf("an input: %v", err)
		}
		v.Name = strings.TrimSpace(v.Name)
		if v.Type == "" {
			v.Type = "text"
		}
		switch {
		case !nameRe.MatchString(v.Name):
			return nil, false, fmt.Errorf("input %q: a variable name (letters, digits, _)", v.Name)
		case v.Name == "pgm" || strings.HasPrefix(v.Name, "ansible_"):
			return nil, false, fmt.Errorf("input %q: this name is used by pg_MANTRA / Ansible", v.Name)
		case seen[v.Name]:
			return nil, false, fmt.Errorf("input %q is there twice", v.Name)
		case !varTypes[v.Type]:
			return nil, false, fmt.Errorf("input %q: unknown type %q", v.Name, v.Type)
		case v.Type == "select" && len(v.Options) == 0:
			return nil, false, fmt.Errorf("input %q: give the choices", v.Name)
		}
		if v.Type == "password" {
			v.Default = nil // never stored
		}
		seen[v.Name] = true
		vars = append(vars, v)
	}
	groups := []Group{}
	for _, raw := range b.Groups {
		var g Group
		if err := remarshal(raw, &g); err != nil {
			return nil, false, fmt.Errorf("a group: %v", err)
		}
		g.Group, g.From = strings.TrimSpace(g.Group), strings.TrimSpace(g.From)
		if g.Group == "" && g.From == "" {
			continue
		}
		if !nameRe.MatchString(g.Group) || g.Group == "all" || g.Group == "ungrouped" {
			return nil, false, fmt.Errorf("group %q: a group name (letters, digits, _)", g.Group)
		}
		if g.From == "" {
			return nil, false, fmt.Errorf("group %q: which machines (a component, or all)", g.Group)
		}
		groups = append(groups, g)
	}
	pb.Variables, _ = json.Marshal(vars)
	pb.Groups, _ = json.Marshal(groups)
	return pb, keep, nil
}

func remarshal(in, out any) error {
	b, err := json.Marshal(in)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, out)
}

// cleanRel: a path inside the archive ("" when empty or outside it)
func cleanRel(p string) string {
	p = strings.TrimSpace(strings.ReplaceAll(p, "\\", "/"))
	if p == "" {
		return ""
	}
	p = path.Clean(strings.TrimPrefix(p, "./"))
	if p == "." || strings.HasPrefix(p, "../") || p == ".." || strings.HasPrefix(p, "/") {
		return ""
	}
	return p
}

/* ------------------------------------------------------------ archives (.tar.gz / .tgz / .tar / .zip) */

type entry struct {
	name string
	dir  bool
	size int64
	open func() (io.ReadCloser, error)
}

func archiveEntries(data []byte, name string) ([]entry, error) {
	var out []entry
	lower := strings.ToLower(name)
	if strings.HasSuffix(lower, ".zip") || bytes.HasPrefix(data, []byte("PK\x03\x04")) {
		zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
		if err != nil {
			return nil, fmt.Errorf("the archive is not a zip: %v", err)
		}
		for _, f := range zr.File {
			f := f
			if f.Mode()&os.ModeSymlink != 0 {
				continue
			}
			out = append(out, entry{name: f.Name, dir: f.FileInfo().IsDir(), size: int64(f.UncompressedSize64), open: f.Open})
		}
		return out, nil
	}
	var r io.Reader = bytes.NewReader(data)
	if bytes.HasPrefix(data, []byte{0x1f, 0x8b}) {
		gz, err := gzip.NewReader(r)
		if err != nil {
			return nil, fmt.Errorf("the archive is not a .tar.gz: %v", err)
		}
		r = gz
	}
	tr := tar.NewReader(r)
	var total int64
	for {
		hd, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("the archive could not be read (.tar.gz, .tgz, .tar or .zip): %v", err)
		}
		switch hd.Typeflag {
		case tar.TypeDir:
			out = append(out, entry{name: hd.Name, dir: true})
		case tar.TypeReg:
			total += hd.Size
			if total > maxExtracted {
				return nil, fmt.Errorf("the archive is larger than %d MB extracted", maxExtracted>>20)
			}
			buf, err := io.ReadAll(io.LimitReader(tr, hd.Size))
			if err != nil {
				return nil, err
			}
			out = append(out, entry{name: hd.Name, size: hd.Size, open: func() (io.ReadCloser, error) {
				return io.NopCloser(bytes.NewReader(buf)), nil
			}})
		}
	}
	return out, nil
}

// archiveFiles: the files of an archive by their clean path; one top folder holding everything is dropped
// (roles.tar.gz with upgrade/site.yml -> site.yml).
func archiveFiles(data []byte, name string) (map[string]entry, error) {
	list, err := archiveEntries(data, name)
	if err != nil {
		return nil, err
	}
	files := map[string]entry{}
	tops := map[string]bool{}
	for _, e := range list {
		p := cleanRel(e.name)
		if p == "" || e.dir {
			continue
		}
		files[p] = e
		top, _, _ := strings.Cut(p, "/")
		if !strings.Contains(p, "/") {
			top = ""
		}
		tops[top] = true
	}
	if len(files) == 0 {
		return nil, errors.New("the archive has no file")
	}
	if len(files) > 5000 {
		return nil, errors.New("the archive has more than 5000 files")
	}
	if len(tops) == 1 {
		for t := range tops {
			if t != "" {
				strip := map[string]entry{}
				for p, e := range files {
					strip[strings.TrimPrefix(p, t+"/")] = e
				}
				files = strip
			}
		}
	}
	return files, nil
}

func archiveNames(data []byte, name string) (map[string]bool, error) {
	files, err := archiveFiles(data, name)
	if err != nil {
		return nil, err
	}
	out := map[string]bool{}
	for p := range files {
		out[p] = true
	}
	return out, nil
}

func extract(data []byte, name, dir string) error {
	files, err := archiveFiles(data, name)
	if err != nil {
		return err
	}
	for p, e := range files {
		dst := filepath.Join(dir, filepath.FromSlash(p))
		if !strings.HasPrefix(dst, filepath.Clean(dir)+string(os.PathSeparator)) {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		rc, err := e.open()
		if err != nil {
			return err
		}
		f, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			rc.Close()
			return err
		}
		_, err = io.Copy(f, io.LimitReader(rc, maxExtracted))
		rc.Close()
		f.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

/* ------------------------------------------------------------ runs */

func (h pbRuns) Handle(p ops.GetCustomPlaybooksIDRunsParams) middleware.Responder {
	list, err := h.db.ListPlaybookRuns(p.HTTPRequest.Context(), p.ID, 100)
	if err != nil {
		return pbBad(err)
	}
	out := make([]any, 0, len(list))
	for i := range list {
		out = append(out, view(&list[i], false))
	}
	return ops.NewGetCustomPlaybooksIDRunsOK().WithPayload(out)
}

func (h pbRun) Handle(p ops.GetCustomPlaybooksIDRunsUIDParams) middleware.Responder {
	u, err := h.db.GetUpgrade(p.HTTPRequest.Context(), p.UID)
	if err != nil || u == nil || u.PlaybookID == nil || *u.PlaybookID != p.ID {
		return pbBad(errors.New("run not found"))
	}
	return ops.NewGetCustomPlaybooksIDRunsUIDOK().WithPayload(view(u, true))
}

// runOptions: what is kept with a run (never a password)
type runOptions struct {
	DiscoveryID int64          `json:"discovery_id,omitempty"`
	ClusterID   int64          `json:"cluster_id,omitempty"`
	Inventory   string         `json:"inventory,omitempty"`
	Hosts       []string       `json:"hosts,omitempty"`
	Vars        map[string]any `json:"vars,omitempty"`
	ExtraVars   string         `json:"extra_vars,omitempty"`
	Playbook    string         `json:"playbook"`
	SSHUser     string         `json:"ssh_user,omitempty"`
	SSHPort     int64          `json:"ssh_port,omitempty"`
	Verbose     bool           `json:"verbose,omitempty"`
}

func (h pbStart) Handle(p ops.PostCustomPlaybooksIDRunsParams) middleware.Responder {
	v, err := h.startPlaybook(p.HTTPRequest.Context(), p.ID, p.Body)
	if err != nil {
		return pbBad(err)
	}
	return ops.NewPostCustomPlaybooksIDRunsOK().WithPayload(v)
}

func (h *Handlers) startPlaybook(ctx context.Context, id int64, b *models.RequestPlaybookRun) (any, error) {
	if b == nil || b.Action == nil {
		return nil, errors.New("action is required")
	}
	action := *b.Action
	if action != "plan" && action != "run" && action != "rollback" {
		return nil, errors.New("action must be plan, run or rollback")
	}
	pb, err := h.db.GetPlaybook(ctx, id, true)
	if err != nil || pb == nil {
		return nil, fmt.Errorf("playbook %d not found", id)
	}
	if action == "rollback" && pb.Rollback == "" && pb.RollbackPath == "" {
		return nil, errors.New("this playbook has no rollback playbook: add one first")
	}
	runs, err := h.db.ListPlaybookRuns(ctx, id, 20)
	if err != nil {
		return nil, err
	}
	for _, r := range runs {
		if r.Status == "running" {
			return nil, fmt.Errorf("run #%d of this playbook is still running", r.ID)
		}
	}

	opt := runOptions{DiscoveryID: b.DiscoveryID, ClusterID: b.ClusterID, Inventory: strings.TrimSpace(b.Inventory), Hosts: b.Hosts,
		ExtraVars: strings.TrimSpace(b.ExtraVars), SSHUser: strings.TrimSpace(b.SSHUser), SSHPort: b.SSHPort, Verbose: b.Verbose}
	given, _ := b.Vars.(map[string]any)
	var parentID *int64
	runID := int64(0)
	if action != "plan" {
		if b.ParentID == 0 {
			return nil, errors.New("parent_id is required: an upgrade follows a dry run, a rollback follows an upgrade")
		}
		parent, err := h.db.GetUpgrade(ctx, b.ParentID)
		if err != nil || parent == nil || parent.PlaybookID == nil || *parent.PlaybookID != id {
			return nil, errors.New("parent run not found for this playbook")
		}
		want := map[string]string{"run": "plan", "rollback": "run"}[action]
		if parent.Action != want {
			return nil, fmt.Errorf("a %s follows a %s (#%d is a %s)", action, want, parent.ID, parent.Action)
		}
		var po runOptions
		_ = json.Unmarshal(parent.Options, &po)
		// the same machines as the run it follows
		if opt.DiscoveryID == 0 && opt.ClusterID == 0 && opt.Inventory == "" {
			opt.DiscoveryID, opt.ClusterID, opt.Inventory = po.DiscoveryID, po.ClusterID, po.Inventory
		}
		if len(opt.Hosts) == 0 {
			opt.Hosts = po.Hosts
		}
		if opt.ExtraVars == "" {
			opt.ExtraVars = po.ExtraVars
		}
		if given == nil {
			given = map[string]any{}
		}
		for k, v := range po.Vars {
			if _, ok := given[k]; !ok && v != secretMask {
				given[k] = v
			}
		}
		if action == "rollback" {
			runID = parent.ID
		}
		parentID = &parent.ID
	}

	// the inputs
	var defs []Variable
	_ = json.Unmarshal(pb.Variables, &defs)
	vals, stored, err := inputValues(defs, given)
	if err != nil {
		return nil, err
	}
	opt.Vars = stored

	// the machines
	var groups []Group
	_ = json.Unmarshal(pb.Groups, &groups)
	inv, invName, secretID, projectID, err := h.playbookInventory(ctx, &opt, groups)
	if err != nil {
		return nil, err
	}

	extra := map[string]any{}
	if opt.ExtraVars != "" {
		if err := yaml.Unmarshal([]byte(opt.ExtraVars), &extra); err != nil {
			return nil, fmt.Errorf("extra variables (YAML or JSON): %v", err)
		}
	}
	for k, v := range vals {
		extra[k] = v
	}

	// SSH: the login given now, else the cluster's stored secret, else what the inventory says
	envs := []string{}
	switch {
	case opt.SSHUser != "":
		extra["ansible_user"] = opt.SSHUser
		if opt.SSHPort > 0 {
			extra["ansible_port"] = opt.SSHPort
		}
		if b.SSHKey != "" {
			envs = append(envs, "SSH_PRIVATE_KEY_CONTENT="+base64.StdEncoding.EncodeToString([]byte(strings.TrimSpace(b.SSHKey)+"\n")))
		}
		if b.SSHPassword != "" {
			extra["ansible_ssh_pass"] = b.SSHPassword
			extra["ansible_become_pass"] = b.SSHPassword
		}
	case secretID != nil:
		senv, asExtra, err := clusterctl.SecretEnvs(ctx, h.db, *secretID, h.cfg.EncryptionKey, projectID)
		if err != nil {
			return nil, fmt.Errorf("the cluster's SSH secret: %w", err)
		}
		for _, kv := range senv {
			if k, v, ok := strings.Cut(kv, "="); ok && asExtra {
				extra[k] = v
			} else if !asExtra {
				envs = append(envs, kv)
			}
		}
	case opt.Inventory == "":
		return nil, errors.New("give the SSH user and password or key (used for this run only)")
	}
	if b.BecomePassword != "" {
		extra["ansible_become_pass"] = b.BecomePassword
	}

	by := ""
	if pr := localmid.PrincipalFrom(ctx); pr != nil {
		by = pr.Username
	}
	opt.Playbook = pb.Name
	optJSON, _ := json.Marshal(opt)
	nz := func(v int64) *int64 {
		if v == 0 {
			return nil
		}
		return &v
	}
	up, err := h.db.CreateUpgrade(ctx, &storage.Upgrade{ClusterID: nz(opt.ClusterID), DiscoveryID: nz(opt.DiscoveryID),
		PlaybookID: &pb.ID, Component: "playbook", Action: action, ParentID: parentID, Options: optJSON, CreatedBy: by})
	if err != nil {
		return nil, err
	}
	if runID == 0 {
		runID = up.ID
	}
	failed := func(err error) (any, error) {
		_ = h.db.FinishUpgrade(ctx, up.ID, "failed", []byte(fmt.Sprintf(`[{"error": %q}]`, err.Error())))
		return nil, err
	}

	// the playbook folder, seen by the runner as /tmp/ansible/pgm-play-<id>
	dirName := PlaybookDir(up.ID)
	dir := filepath.Join(h.cfg.Docker.LogDir, dirName)
	_ = os.RemoveAll(dir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return failed(fmt.Errorf("the playbook folder: %w", err))
	}
	if len(pb.Files) > 0 {
		if err := extract(pb.Files, pb.FilesName, dir); err != nil {
			return failed(fmt.Errorf("the archive: %w", err))
		}
	}
	write := func(name, text string) error {
		return os.WriteFile(filepath.Join(dir, name), []byte(text), 0o644)
	}
	entry := pb.PlaybookPath
	if action == "rollback" {
		entry = pb.RollbackPath
	}
	if entry == "" {
		entry = map[bool]string{true: "pgm-rollback.yml", false: "pgm-upgrade.yml"}[action == "rollback"]
		text := pb.Playbook
		if action == "rollback" {
			text = pb.Rollback
		}
		if err := write(entry, text); err != nil {
			return failed(err)
		}
	}
	if strings.TrimSpace(pb.Requirements) != "" {
		if err := write("pgm-requirements.yml", pb.Requirements); err != nil {
			return failed(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, invName), inv, 0o644); err != nil {
		return failed(err)
	}

	extra["pgm"] = map[string]any{"id": up.ID, "action": action, "run_id": runID, "playbook": pb.Name, "check": action == "plan"}
	extraJSON, _ := json.Marshal(extra)
	in := ansibleLogDir + "/" + dirName
	envs = append(envs,
		"PGM_MODE=playbook",
		"PGM_DIR="+in,
		"PGM_PLAYBOOK="+entry,
		"PGM_INVENTORY="+invName,
		"PGM_CHECK="+map[bool]string{true: "1", false: "0"}[action == "plan"],
		"PGM_LIMIT="+strings.Join(opt.Hosts, ","),
		"PGM_VERBOSE="+map[bool]string{true: "1", false: "0"}[opt.Verbose],
		fmt.Sprintf("ANSIBLE_JSON_LOG_FILE=%s/upgrade-%d.json", ansibleLogDir, up.ID))
	if b.VaultPassword != "" {
		envs = append(envs, "PGM_VAULT_PASSWORD="+base64.StdEncoding.EncodeToString([]byte(b.VaultPassword)))
	}
	dockerID, err := h.docker.ManageCluster(ctx, &xdocker.ManageClusterConfig{Image: h.cfg.Docker.UpgradeImage, Envs: envs,
		ExtraVars: string(extraJSON), Mounts: []xdocker.Mount{{DockerPath: ansibleLogDir, HostPath: h.cfg.Docker.LogDir}}})
	if err != nil {
		_ = os.RemoveAll(dir)
		return failed(fmt.Errorf("could not start the upgrade runner (%s - built by ./build.sh console): %w", h.cfg.Docker.UpgradeImage, err))
	}
	_ = h.db.SetUpgradeDocker(ctx, up.ID, string(dockerID))
	cid, _ := ctx.Value(tracer.CtxCidKey{}).(string)
	lctx := context.WithValue(context.Background(), tracer.CtxCidKey{}, cid)
	go h.docker.StoreContainerLogs(lctx, dockerID, func(line string) { _ = h.db.AppendUpgradeLog(lctx, up.ID, line) })
	return view(up, false), nil
}

// PlaybookDir: the folder of a run's playbook files (under the log folder; the watcher removes it at the end).
func PlaybookDir(id int64) string { return fmt.Sprintf("pgm-play-%d", id) }

// inputValues checks the inputs given for a run. vals go to the playbook; stored is kept with the run (passwords masked).
func inputValues(defs []Variable, given map[string]any) (map[string]any, map[string]any, error) {
	vals, stored := map[string]any{}, map[string]any{}
	for _, d := range defs {
		v, ok := given[d.Name]
		if !ok || v == nil || v == "" {
			if d.Default != nil && d.Default != "" {
				v, ok = d.Default, true
			} else {
				ok = false
			}
		}
		if !ok {
			if d.Required && d.Type != "boolean" {
				label := d.Label
				if label == "" {
					label = d.Name
				}
				return nil, nil, fmt.Errorf("%q is required", label)
			}
			if d.Type == "boolean" {
				vals[d.Name], stored[d.Name] = false, false
			}
			continue
		}
		switch d.Type {
		case "number":
			switch n := v.(type) {
			case float64:
				v = n
			case json.Number:
				f, err := n.Float64()
				if err != nil {
					return nil, nil, fmt.Errorf("%q: a number", d.Name)
				}
				v = f
			default:
				f, err := strconv.ParseFloat(strings.TrimSpace(fmt.Sprint(v)), 64)
				if err != nil {
					return nil, nil, fmt.Errorf("%q: a number", d.Name)
				}
				v = f
			}
			if f := v.(float64); f == float64(int64(f)) {
				v = int64(f)
			}
		case "boolean":
			switch x := v.(type) {
			case bool:
			default:
				v = strings.EqualFold(fmt.Sprint(x), "true") || fmt.Sprint(x) == "1" || strings.EqualFold(fmt.Sprint(x), "yes")
			}
		case "select":
			s := fmt.Sprint(v)
			found := false
			for _, o := range d.Options {
				found = found || o == s
			}
			if !found {
				return nil, nil, fmt.Errorf("%q: one of %s", d.Name, strings.Join(d.Options, ", "))
			}
			v = s
		default:
			v = fmt.Sprint(v)
		}
		vals[d.Name] = v
		if d.Type == "password" {
			stored[d.Name] = secretMask
		} else {
			stored[d.Name] = v
		}
	}
	return vals, stored, nil
}

// playbookInventory: the machines of a run, as the file the runner uses (name: inventory.json / .yml / .ini).
func (h *Handlers) playbookInventory(ctx context.Context, opt *runOptions, groups []Group) ([]byte, string, *int64, int64, error) {
	n := 0
	for _, x := range []bool{opt.DiscoveryID != 0, opt.ClusterID != 0, opt.Inventory != ""} {
		if x {
			n++
		}
	}
	if n != 1 {
		return nil, "", nil, 0, errors.New("choose the machines: a saved discovery, a cluster or your inventory")
	}
	switch {
	case opt.Inventory != "":
		var m map[string]any
		if err := yaml.Unmarshal([]byte(opt.Inventory), &m); err == nil && len(m) > 0 && !strings.HasPrefix(opt.Inventory, "[") {
			return []byte(opt.Inventory), "pgm-inventory.yml", nil, 0, nil
		}
		return []byte(opt.Inventory + "\n"), "pgm-inventory.ini", nil, 0, nil
	case opt.DiscoveryID != 0:
		d, err := h.db.GetDiscovery(ctx, opt.DiscoveryID)
		if err != nil || d == nil {
			return nil, "", nil, 0, fmt.Errorf("saved discovery %d not found", opt.DiscoveryID)
		}
		inv, err := inventoryFromDiscovery(d.Result, true)
		if err != nil {
			return nil, "", nil, 0, err
		}
		inv, err = withGroups(inv, groups, func(from string) []string {
			return []string{"pgm_" + strings.ReplaceAll(from, "-", "_")}
		})
		return inv, "pgm-inventory.json", nil, 0, err
	default:
		t, err := h.clusterTarget(ctx, opt.ClusterID)
		if err != nil {
			return nil, "", nil, 0, err
		}
		inv, err := withGroups(t.inventory, groups, func(from string) []string {
			if c := component(from); c != nil {
				return c.Groups
			}
			return []string{from}
		})
		return inv, "pgm-inventory.json", t.secretID, t.projectID, err
	}
}

// withGroups adds the playbook's groups to a JSON inventory, each made of the groups that hold a component.
func withGroups(inv []byte, groups []Group, from func(string) []string) ([]byte, error) {
	if len(groups) == 0 {
		return inv, nil
	}
	var m map[string]any
	if err := json.Unmarshal(inv, &m); err != nil {
		return nil, fmt.Errorf("the inventory: %w", err)
	}
	all, _ := m["all"].(map[string]any)
	if all == nil {
		all = map[string]any{}
		m["all"] = all
	}
	children, _ := all["children"].(map[string]any)
	if children == nil {
		children = map[string]any{}
		all["children"] = children
	}
	for _, g := range groups {
		if _, exists := children[g.Group]; exists {
			continue
		}
		if g.From == "all" {
			hosts := map[string]any{}
			collectHosts(all, hosts)
			children[g.Group] = map[string]any{"hosts": hosts}
			continue
		}
		sub := map[string]any{}
		for _, src := range from(g.From) {
			if _, ok := children[src]; ok {
				sub[src] = map[string]any{}
			}
		}
		children[g.Group] = map[string]any{"children": sub}
	}
	return json.Marshal(m)
}

func collectHosts(g map[string]any, out map[string]any) {
	if hs, ok := g["hosts"].(map[string]any); ok {
		for h := range hs {
			out[h] = map[string]any{}
		}
	}
	if ch, ok := g["children"].(map[string]any); ok {
		for _, c := range ch {
			if cm, ok := c.(map[string]any); ok {
				collectHosts(cm, out)
			}
		}
	}
}
