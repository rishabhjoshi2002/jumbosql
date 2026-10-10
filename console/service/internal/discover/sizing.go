package discover

// Sizing: what each machine really needs (from the Prometheus history when there is one, else from what it
// has now), and PostgreSQL settings that fit the memory and CPUs. Costs are worked out in the browser, with
// the prices the user types in.

import (
	"context"
	"fmt"
	"math"
	"net"
	"sort"
	"strconv"
	"strings"
	"time"

	"postgresql-cluster-console/internal/insights"
)

type Size struct {
	CPUs      int     `json:"cpus"`
	MemBytes  float64 `json:"mem_bytes"`
	DiskBytes float64 `json:"disk_bytes"`
}

type HostSizing struct {
	Address     string         `json:"address"`
	Name        string         `json:"name"`
	Roles       []string       `json:"roles"`
	PGRole      string         `json:"pg_role,omitempty"`
	Current     Size           `json:"current"`
	Recommended Size           `json:"recommended"`
	CPUPeak     float64        `json:"cpu_peak_pct"` // p95 over the history, -1 = unknown
	CPUAhead    float64        `json:"cpu_ahead_pct"`
	MemPeak     float64        `json:"mem_peak_pct"`
	MemAhead    float64        `json:"mem_ahead_pct"`
	DiskUsed    float64        `json:"disk_used_bytes"`
	DiskAhead   float64        `json:"disk_ahead_bytes"`
	Status      string         `json:"status"` // right | under | over | unknown
	Reasons     []string       `json:"reasons"`
	Lines       []SizeLine     `json:"lines"` // CPU, RAM, disk: has, used, needs, and the sum behind it
	Trend       *insights.Host `json:"trend,omitempty"`
}

// SizeLine explains one resource of one machine in plain numbers.
type SizeLine struct {
	Resource string `json:"resource"` // cpu | ram | disk
	Has      string `json:"has"`
	Peak     string `json:"peak"`  // used at peak now (p95)
	Ahead    string `json:"ahead"` // expected at the horizon
	Need     string `json:"need"`
	How      string `json:"how"` // the sum
}

type PGChange struct {
	Name        string `json:"name"`
	Current     string `json:"current"`
	Recommended string `json:"recommended"`
	Restart     bool   `json:"restart"`
	Reason      string `json:"reason"`
}

type NodeTuning struct {
	Node    string     `json:"node"`
	Host    string     `json:"host"`
	Role    string     `json:"role"`
	For     Size       `json:"for"` // the hardware the values are for
	Changes []PGChange `json:"changes"`
	Script  string     `json:"script"`
}

type Sizing struct {
	Source     string       `json:"source"` // prometheus | machines | none
	Prometheus string       `json:"prometheus,omitempty"`
	Error      string       `json:"error,omitempty"`
	Days       int          `json:"days"`
	Horizon    int          `json:"horizon"`
	Hosts      []HostSizing `json:"hosts"`
	Tuning     []NodeTuning `json:"tuning"`
	Notes      []string     `json:"notes"`
}

const gib = 1 << 30

var memSteps = []float64{1, 2, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024}
var cpuSteps = []int{1, 2, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128}

func roundMem(b float64) float64 {
	for _, s := range memSteps {
		if b <= s*gib {
			return s * gib
		}
	}
	return math.Ceil(b/(256*gib)) * 256 * gib
}

func roundCPU(n float64) int {
	for _, s := range cpuSteps {
		if n <= float64(s) {
			return s
		}
	}
	return int(math.Ceil(n/32) * 32)
}

// the least a machine doing this should have
func roleMin(roles []string) (cpus int, mem float64, disk float64) {
	cpus, mem, disk = 1, 1*gib, 10*gib
	for _, r := range roles {
		switch r {
		case "database":
			cpus, mem, disk = max(cpus, 2), math.Max(mem, 4*gib), math.Max(disk, 20*gib)
		case "monitoring":
			cpus, mem, disk = max(cpus, 2), math.Max(mem, 2*gib), math.Max(disk, 20*gib)
		case "dcs", "ha":
			cpus, mem = max(cpus, 2), math.Max(mem, 2*gib)
		}
	}
	return
}

func sizing(ctx context.Context, res *Result, inf *Infra, req Request) *Sizing {
	days, horizon := req.Days, req.Horizon
	if days <= 0 {
		days = 30
	}
	if horizon <= 0 {
		horizon = 180
	}
	sz := &Sizing{Source: "machines", Days: days, Horizon: horizon, Hosts: []HostSizing{}, Tuning: []NodeTuning{}, Notes: []string{}}
	ix := newHostIndex(inf.Hosts, res)

	// the PostgreSQL role and data directory of each machine
	pgRole := map[*HostInfo]string{}
	dataDirs := map[string]int{}
	dbBytes := map[*HostInfo]float64{}
	for _, n := range res.Nodes {
		if n.External || !n.Reachable {
			continue
		}
		if h := ix.find(n.Host); h != nil {
			pgRole[h] = n.Role
			for _, d := range n.Databases {
				dbBytes[h] += d.SizeBytes
			}
		}
		if n.DataDirectory != "" {
			dataDirs[n.DataDirectory]++
		}
	}
	dataDir, best := "/var/lib", 0
	for d, c := range dataDirs {
		if c > best {
			dataDir, best = d, c
		}
	}

	// Prometheus history (node_exporter): the given one, then any other found on the machines
	trends := map[*HostInfo]*insights.Host{}
	var proms []string
	if inf.Prometheus != "" {
		proms = append(proms, inf.Prometheus)
	}
	for _, h := range inf.Hosts {
		for _, c := range h.Components {
			if c.Kind == "prometheus" && c.Running && has(c.Ports, 9090) {
				if u := "http://" + net.JoinHostPort(h.Address, "9090"); u != inf.Prometheus {
					proms = append(proms, u)
				}
			}
		}
	}
	servers := map[string][2]string{}
	for _, h := range inf.Hosts {
		keys := []string{h.Address, h.Name, strings.Split(h.Name, ".")[0]}
		if net.ParseIP(h.Address) == nil {
			if ips, err := net.LookupHost(h.Address); err == nil {
				keys = append(keys, ips...)
			}
		}
		for _, k := range keys {
			if k != "" {
				servers[k] = [2]string{h.Address, ""}
			}
		}
	}
	var errs []string
	for _, url := range proms {
		pctx, cancel := context.WithTimeout(ctx, 40*time.Second)
		p := &insights.Prometheus{BaseURL: url}
		hs, err := p.Hosts(pctx, servers, dataDir, days, horizon, time.Now())
		cancel()
		if err != nil {
			errs = append(errs, url+": "+err.Error())
		}
		for i := range hs {
			t := hs[i]
			for _, h := range inf.Hosts {
				if t.Node != "" && h.Address == t.Node && trends[h] == nil {
					trends[h] = &t
				}
			}
		}
		if len(trends) > 0 {
			sz.Source, sz.Prometheus = "prometheus", url
			break
		}
		if err == nil {
			errs = append(errs, url+": no node_exporter data for these machines")
		}
	}
	if len(trends) == 0 && len(errs) > 0 {
		sz.Error = strings.Join(errs, "; ")
	}

	ahead := time.Now().Add(time.Duration(horizon) * 24 * time.Hour)
	for _, h := range inf.Hosts {
		if !h.Reachable && trends[h] == nil {
			continue
		}
		s := HostSizing{Address: h.Address, Name: h.label(), Roles: h.Roles, PGRole: pgRole[h], CPUPeak: -1, CPUAhead: -1,
			MemPeak: -1, MemAhead: -1, Reasons: []string{}}
		s.Current = Size{CPUs: h.CPUs, MemBytes: h.MemBytes}
		bestMount := ""
		for _, d := range h.Disks { // the disk that holds the data directory (database machines), else the root disk
			if d.Mount == "/" && bestMount == "" || h.hasKind("postgres") && mountHolds(d.Mount, dataDir) && len(d.Mount) > len(bestMount) {
				s.Current.DiskBytes, s.DiskUsed, bestMount = d.Size, d.Used, d.Mount
			}
		}
		t := trends[h]
		if t != nil {
			s.Trend = t
			if s.Current.CPUs == 0 {
				s.Current.CPUs = int(t.Cores)
			}
			if s.Current.MemBytes == 0 {
				s.Current.MemBytes = t.MemTotal
			}
			if t.DiskSize > 0 {
				s.Current.DiskBytes = t.DiskSize
			}
			s.CPUPeak, s.MemPeak = t.CPUP95, t.MemP95
			s.CPUAhead, s.MemAhead = s.CPUPeak, s.MemPeak
			if t.CPUForecast.HasForecast {
				v, _, _ := t.CPUForecast.ValueAt(ahead)
				s.CPUAhead = math.Min(100, math.Max(0, v))
			}
			if t.MemForecast.HasForecast {
				v, _, _ := t.MemForecast.ValueAt(ahead)
				s.MemAhead = math.Min(100, math.Max(0, v))
			}
			if n := len(t.DiskUsed); n > 0 {
				s.DiskUsed = t.DiskUsed[n-1].V
			}
			s.DiskAhead = s.DiskUsed
			if t.DiskForecast.HasForecast {
				v, _, _ := t.DiskForecast.ValueAt(ahead)
				s.DiskAhead = math.Max(s.DiskUsed, v)
			}
		}
		minCPU, minMem, minDisk := roleMin(h.Roles)
		hasData := s.CPUPeak >= 0
		dash := "—"
		pctOf := func(p float64, total string) string {
			if p < 0 {
				return dash
			}
			return fmt.Sprintf("%.0f%% %s", p, total)
		}
		roleNote := func(min string) string { return "minimum for this role: " + min }
		rec := Size{}

		// CPU: the busy cores at peak (p95, or the forecast if higher) at most 65 % of the machine
		cpu := SizeLine{Resource: "cpu", Has: dash, Peak: dash, Ahead: dash}
		if s.Current.CPUs > 0 {
			cpu.Has = fmt.Sprintf("%d vCPU", s.Current.CPUs)
		}
		if hasData && s.Current.CPUs > 0 {
			busy := float64(s.Current.CPUs) * s.CPUPeak / 100
			busyAhead := float64(s.Current.CPUs) * math.Max(s.CPUPeak, s.CPUAhead) / 100
			cpu.Peak = pctOf(s.CPUPeak, fmt.Sprintf("(%.1f vCPU busy)", busy))
			cpu.Ahead = pctOf(math.Max(s.CPUPeak, s.CPUAhead), fmt.Sprintf("(%.1f vCPU)", busyAhead))
			rec.CPUs = roundCPU(busyAhead / 0.65)
			cpu.How = fmt.Sprintf("%.1f vCPU busy ÷ 65%% target = %.1f → %d vCPU", busyAhead, busyAhead/0.65, rec.CPUs)
		} else {
			rec.CPUs = s.Current.CPUs
			cpu.How = "no usage data: kept as now"
		}
		if rec.CPUs < minCPU {
			rec.CPUs = minCPU
			cpu.How += "; " + roleNote(fmt.Sprintf("%d vCPU", minCPU))
		}
		cpu.Need = fmt.Sprintf("%d vCPU", rec.CPUs)

		// RAM: memory used at peak (without the OS cache) with 20 % head-room
		mem := SizeLine{Resource: "ram", Has: dash, Peak: dash, Ahead: dash}
		if s.Current.MemBytes > 0 {
			mem.Has = bytesText(s.Current.MemBytes)
		}
		if hasData && s.Current.MemBytes > 0 {
			used := s.Current.MemBytes * s.MemPeak / 100
			usedAhead := s.Current.MemBytes * math.Max(s.MemPeak, s.MemAhead) / 100
			mem.Peak = pctOf(s.MemPeak, "("+bytesText(used)+")")
			mem.Ahead = pctOf(math.Max(s.MemPeak, s.MemAhead), "("+bytesText(usedAhead)+")")
			rec.MemBytes = roundMem(usedAhead / 0.8)
			mem.How = fmt.Sprintf("%s used ÷ 80%% target = %s → %s", bytesText(usedAhead), bytesText(usedAhead/0.8), bytesText(rec.MemBytes))
		} else {
			rec.MemBytes = roundMem(s.Current.MemBytes * 0.98)
			mem.How = "no usage data: kept as now"
		}
		if rec.MemBytes < minMem {
			rec.MemBytes = minMem
			mem.How += "; " + roleNote(bytesText(minMem))
		}
		mem.Need = bytesText(rec.MemBytes)

		// disk: what will be used in <horizon> days at most 75 % full
		disk := SizeLine{Resource: "disk", Has: dash, Peak: dash, Ahead: dash}
		if s.Current.DiskBytes > 0 {
			disk.Has = bytesText(s.Current.DiskBytes)
		}
		if s.DiskUsed > 0 {
			disk.Peak = bytesText(s.DiskUsed)
			ahead := math.Max(s.DiskUsed, s.DiskAhead)
			if t != nil && t.DiskForecast.HasForecast {
				disk.Ahead = bytesText(ahead)
			}
			rec.DiskBytes = math.Ceil(ahead/0.75/(10*gib)) * 10 * gib
			disk.How = fmt.Sprintf("%s ÷ 75%% target = %s → %s", bytesText(ahead), bytesText(ahead/0.75), bytesText(rec.DiskBytes))
			if disk.Ahead == dash {
				disk.How += " (no growth trend)"
			}
		} else {
			rec.DiskBytes = s.Current.DiskBytes
			disk.How = "no usage data: kept as now"
		}
		if rec.DiskBytes < minDisk {
			rec.DiskBytes = minDisk
			disk.How += "; " + roleNote(bytesText(minDisk))
		}
		disk.Need = bytesText(rec.DiskBytes)
		s.Lines = []SizeLine{cpu, mem, disk}
		if db := dbBytes[h]; db > 0 && h.hasKind("postgres") {
			if want := math.Min(db/4, 256*gib); want > rec.MemBytes {
				s.Reasons = append(s.Reasons, fmt.Sprintf("Databases hold %s: %s RAM would cache a quarter of it.",
					bytesText(db), bytesText(roundMem(want))))
			}
		}

		s.Recommended = rec
		s.Status = "unknown"
		if hasData && s.Current.CPUs > 0 && s.Current.MemBytes > 0 {
			under := rec.CPUs > s.Current.CPUs || rec.MemBytes > s.Current.MemBytes*1.05 ||
				(s.Current.DiskBytes > 0 && rec.DiskBytes > s.Current.DiskBytes*1.02)
			over := rec.CPUs*2 <= s.Current.CPUs && rec.MemBytes*2 <= s.Current.MemBytes
			switch {
			case under:
				s.Status = "under"
			case over:
				s.Status = "over"
			default:
				s.Status = "right"
			}
		}
		sz.Hosts = append(sz.Hosts, s)
	}

	// PostgreSQL settings for each reachable node, for the hardware it has (or the recommended one)
	for _, n := range res.Nodes {
		if n.External || !n.Reachable {
			continue
		}
		var hs *HostSizing
		if h := ix.find(n.Host); h != nil {
			for i := range sz.Hosts {
				if sz.Hosts[i].Address == h.Address {
					hs = &sz.Hosts[i]
				}
			}
		}
		for_ := Size{}
		if hs != nil {
			for_ = hs.Current
			if for_.MemBytes == 0 {
				for_.MemBytes = hs.Recommended.MemBytes
			}
			if for_.CPUs == 0 {
				for_.CPUs = hs.Recommended.CPUs
			}
		}
		if for_.MemBytes == 0 {
			continue // without SSH or Prometheus the memory size is unknown
		}
		sz.Tuning = append(sz.Tuning, tune(n, for_))
	}
	if len(sz.Tuning) == 0 && len(res.Nodes) > 0 {
		sz.Notes = append(sz.Notes, "PostgreSQL settings need the RAM size: add SSH or Prometheus.")
	}
	if sz.Source != "prometheus" {
		sz.Notes = append(sz.Notes, "No usage history: sizes kept as now.")
	}
	sort.SliceStable(sz.Hosts, func(i, j int) bool {
		return layerIndex(firstRole(sz.Hosts[i].Roles)) < layerIndex(firstRole(sz.Hosts[j].Roles))
	})
	return sz
}

func firstRole(r []string) string {
	for _, x := range r {
		if x == "database" {
			return x
		}
	}
	if len(r) > 0 {
		return r[0]
	}
	return "zzz"
}

func mountHolds(mount, dir string) bool {
	return mount == "/" || dir == mount || strings.HasPrefix(dir, strings.TrimRight(mount, "/")+"/")
}

/* ------------------------------------------------------------ settings ------------------------------------------------------------ */

// settingBytes: a memory setting in bytes (pg_settings value * unit)
func settingBytes(val, unit string) (float64, bool) {
	v, err := strconv.ParseFloat(val, 64)
	if err != nil {
		return 0, false
	}
	if v < 0 {
		return v, true
	}
	mult := map[string]float64{"B": 1, "kB": 1024, "8kB": 8192, "16kB": 16384, "MB": 1 << 20, "GB": 1 << 30, "TB": 1 << 40}[unit]
	if mult == 0 {
		return 0, false
	}
	return v * mult, true
}

func memText(b float64) string { // in postgresql.conf units
	switch {
	case b >= gib && math.Mod(b, gib) == 0:
		return fmt.Sprintf("%.0fGB", b/gib)
	case b >= 1<<20:
		return fmt.Sprintf("%.0fMB", math.Round(b/(1<<20)))
	default:
		return fmt.Sprintf("%.0fkB", math.Round(b/1024))
	}
}

func tune(n *Node, hw Size) NodeTuning {
	t := NodeTuning{Node: n.ID, Host: n.Host, Role: n.Role, For: hw, Changes: []PGChange{}}
	units := map[string]string{}
	for _, s := range n.Settings {
		units[s.Name] = s.Unit
	}
	ram := hw.MemBytes
	cpus := max(hw.CPUs, 1)
	conns := max(n.MaxConnections, 20)

	sb := math.Min(ram*0.25, 64*gib)
	sb = math.Floor(sb/(1<<20)) * (1 << 20)
	wm := math.Max(4<<20, math.Min(256<<20, (ram-sb)/float64(conns*3)))
	mwm := math.Min(2*gib, math.Max(64<<20, ram/16))
	type want struct {
		name, value string
		bytes       float64 // memory settings: compared within 10 %
		restart     bool
		reason      string
	}
	ws := []want{
		{"shared_buffers", memText(sb), sb, true, "25% of RAM"},
		{"effective_cache_size", memText(ram * 0.75), ram * 0.75, false, "75% of RAM (what the OS cache can hold)"},
		{"maintenance_work_mem", memText(mwm), mwm, false, "RAM/16, at most 2GB (faster VACUUM and index builds)"},
		{"work_mem", memText(wm), wm, false, fmt.Sprintf("(RAM - shared_buffers) / (%d connections x 3)", conns)},
		{"wal_buffers", "16MB", 16 << 20, true, "16MB once shared_buffers is 512MB or more"},
		{"min_wal_size", "1GB", gib, false, "fewer WAL file recycles"},
		{"max_wal_size", "4GB", 4 * gib, false, "fewer forced checkpoints under write load"},
		{"checkpoint_completion_target", "0.9", 0, false, "spread checkpoint writes"},
		{"random_page_cost", "1.1", 0, false, "SSD / cloud disks (use 4 for spinning disks)"},
		{"effective_io_concurrency", "200", 0, false, "SSD / cloud disks"},
		{"max_worker_processes", strconv.Itoa(max(8, cpus)), 0, true, "at least one per CPU"},
		{"max_parallel_workers", strconv.Itoa(cpus), 0, false, "one per CPU"},
		{"max_parallel_workers_per_gather", strconv.Itoa(max(1, min(4, cpus/2))), 0, false, "half the CPUs, at most 4"},
		{"max_parallel_maintenance_workers", strconv.Itoa(max(1, min(4, cpus/2))), 0, false, "half the CPUs, at most 4"},
		{"wal_compression", "on", 0, false, "less WAL to write and replicate"},
	}
	if sb < 512<<20 {
		ws = append(ws[:4], ws[5:]...) // wal_buffers: the default (-1, 1/32 of shared_buffers) is fine
	}
	if ram >= 32*gib {
		ws = append(ws, want{"huge_pages", "try", 0, true, "large shared memory; set vm.nr_hugepages on the machine"})
	}
	var script []string
	for _, w := range ws {
		c, ok := n.settingsByName[w.name]
		if !ok {
			continue // this login could not read it, or the version does not have it
		}
		same := false
		curText := c
		if w.bytes > 0 {
			if b, ok := settingBytes(c, units[w.name]); ok {
				curText = memText(b)
				if b < 0 {
					curText = "default (" + c + ")"
				}
				same = b > 0 && math.Abs(b-w.bytes)/w.bytes < 0.1
			}
		} else {
			cf, e1 := strconv.ParseFloat(c, 64)
			wf, e2 := strconv.ParseFloat(w.value, 64)
			same = c == w.value || e1 == nil && e2 == nil && math.Abs(cf-wf) < 1e-9 ||
				w.name == "wal_compression" && c != "off" && c != "" || w.name == "huge_pages" && c == "on"
			if w.name == "max_worker_processes" || w.name == "max_parallel_workers" {
				same = same || e1 == nil && e2 == nil && cf >= wf // more is fine
			}
		}
		if same {
			continue
		}
		t.Changes = append(t.Changes, PGChange{Name: w.name, Current: curText, Recommended: w.value, Restart: w.restart, Reason: w.reason})
		script = append(script, fmt.Sprintf("ALTER SYSTEM SET %s = '%s';", w.name, w.value))
	}
	if len(script) > 0 {
		head := fmt.Sprintf("-- %s (%s): for %d vCPU, %s RAM\n", n.Name, n.Role, cpus, bytesText(ram))
		if n.Patroni != nil {
			head += "-- this node is managed by Patroni: put these in the Patroni DCS config (patronictl edit-config) instead\n"
		}
		restart := false
		for _, c := range t.Changes {
			restart = restart || c.Restart
		}
		tail := "SELECT pg_reload_conf();"
		if restart {
			tail += "\n-- some settings need a restart to take effect"
		}
		t.Script = head + strings.Join(script, "\n") + "\n" + tail + "\n"
	}
	return t
}
