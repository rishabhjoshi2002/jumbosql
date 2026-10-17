#!/usr/bin/env python3
"""
pgm_backup.py - pg_MANTRA backups: pgBackRest on one machine. The console runs it over SSH (status) and the
backup playbook runs it with Ansible (everything else). Called with an action and a base64 JSON spec; it prints
one JSON object (the last line of its output).

Actions
  status        pgBackRest version, its config, `pgbackrest info`, the local PostgreSQL (role, WAL archiving),
                Patroni, the pgBackRest cron entries                                  (reads only)
  backup        pgbackrest backup (full / diff / incr)
  check         pgbackrest check (archiving and repository work)
  stanza-create pgbackrest stanza-create
  config-apply  write a new pgbackrest.conf (the old one is kept as <conf>.pgm-<run>); this node's own
                pg*-path / pg*-port / pg*-socket-path / pg*-host... can be kept
  config-undo   put back the config kept by config-apply
  schedule      write (or remove) /etc/cron.d/pg_mantra_pgbackrest
  stop          stop Patroni, else PostgreSQL (what was stopped is remembered for start)
  restore       pgbackrest restore --delta: latest, to a time (PITR), a backup set, or as a standby
  promote       after a restore of the primary: start PostgreSQL, wait until the recovery ended (promoted);
                with Patroni: stop it again, clear the cluster in the DCS and start Patroni
  start         start what stop stopped (Patroni or PostgreSQL)
  health        PostgreSQL answers; its role and LSN
"""
import base64
import configparser
import glob
import io
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request

OUT = {"ok": True, "warnings": []}
STATE_DIR = "/var/lib/pg_mantra/backup"
CRON_FILE = "/etc/cron.d/pg_mantra_pgbackrest"


def done(code=0):
    OUT["ok"] = code == 0
    print(json.dumps(OUT, default=str))
    sys.exit(code)


def fail(msg):
    OUT["error"] = msg
    done(2)


def sh(cmd, timeout=900, env=None, input=None):
    e = dict(os.environ, LC_ALL="C")
    if env:
        e.update(env)
    try:
        p = subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True, text=True, timeout=timeout, env=e, input=input)
    except subprocess.TimeoutExpired:
        return 124, "", f"timed out after {timeout}s"
    except FileNotFoundError as e:
        return 127, "", f"not installed: {e.filename}"
    return p.returncode, p.stdout, p.stderr


def which(*names):
    for n in names:
        p = shutil.which(n) or next((x for x in (f"/usr/local/bin/{n}", f"/usr/bin/{n}", f"/usr/sbin/{n}") if os.path.exists(x)), None)
        if p:
            return p
    return None


def as_postgres(cmd, timeout=900, input=None):
    """run a shell command as the postgres OS user"""
    if os.geteuid() != 0:
        return sh(cmd, timeout=timeout, input=input)
    return sh(["su", "postgres", "-s", "/bin/sh", "-c", cmd], timeout=timeout, input=input)


def q(s):
    return "'" + str(s).replace("'", "'\"'\"'") + "'"


# ---------------------------------------------------------------- what runs on this node (found, never assumed)
# Names, paths and ports differ between setups (a renamed pgbackrest.conf, a data directory anywhere, PostgreSQL on
# port 5433, logs in /data/logs ...), so everything is read from the running processes, from PostgreSQL itself
# (SHOW config_file, data_directory, log_directory ...) and from the options pgBackRest is really started with.

SPEC = {}
CACHE = {}


def cached(name):
    def wrap(fn):
        def inner():
            if name not in CACHE:
                CACHE[name] = fn()
            return CACHE[name]
        return inner
    return wrap


def boot_time():
    try:
        for line in open("/proc/stat"):
            if line.startswith("btime "):
                return int(line.split()[1])
    except OSError:
        pass
    return 0


@cached("procs")
def procs():
    """every process: pid, parent, name, arguments, start time (read from /proc - no ps output format to parse)"""
    out = []
    hz = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100
    bt = boot_time()
    for d in os.listdir("/proc"):
        if not d.isdigit():
            continue
        try:
            raw = open(f"/proc/{d}/cmdline", "rb").read()
            stat = open(f"/proc/{d}/stat").read()
        except OSError:
            continue
        args = [a.decode(errors="ignore") for a in raw.split(b"\0") if a]
        try:
            comm = stat[stat.index("(") + 1:stat.rindex(")")]
            rest = stat[stat.rindex(")") + 2:].split()
            ppid, started = int(rest[1]), bt + int(rest[19]) // hz
        except (ValueError, IndexError):
            continue
        if args:
            out.append({"pid": int(d), "ppid": ppid, "comm": comm, "args": args, "started": started})
    return out


def proc_env(pid):
    try:
        raw = open(f"/proc/{pid}/environ", "rb").read()
    except OSError:
        return {}
    env = {}
    for kv in raw.split(b"\0"):
        k, _, v = kv.decode(errors="ignore").partition("=")
        if k:
            env[k] = v
    return env


def ancestors(p):
    by = {x["pid"]: x for x in procs()}
    out, seen = [], set()
    while p and p["ppid"] in by and p["ppid"] not in seen:
        seen.add(p["ppid"])
        p = by[p["ppid"]]
        out.append(p)
    return out


def read_pidfile(data):
    """postmaster.pid: pid, data dir, start, port, socket dir, listen address"""
    try:
        lines = open(os.path.join(data, "postmaster.pid"), errors="ignore").read().splitlines()
    except OSError:
        return {}
    g = lambda i: lines[i].strip() if len(lines) > i else ""  # noqa: E731
    return {"port": int(g(3)) if g(3).isdigit() else 0, "socket": g(4).split(",")[0].strip() if g(4) else "",
            "listen": g(5)}


@cached("instances")
def pg_instances():
    """the PostgreSQL servers running here: data directory (the postmaster works in it), port and socket (its
    postmaster.pid) and the binaries it was started from - whatever names, paths or ports they use"""
    out = []
    by = {x["pid"]: x for x in procs()}
    for p in procs():
        a0 = os.path.basename(p["args"][0])
        if p["comm"] not in ("postgres", "postmaster") and a0 not in ("postgres", "postmaster"):
            continue
        if p["args"][0].startswith(("postgres:", "postmaster:")):
            continue  # a backend or background worker (its title is rewritten)
        parent = by.get(p["ppid"])
        if parent and parent["comm"] in ("postgres", "postmaster") and not parent["args"][0].startswith("postgres:"):
            continue
        data = ""
        try:
            data = os.readlink(f"/proc/{p['pid']}/cwd")
        except OSError:
            pass
        if not data or not os.path.isfile(os.path.join(data, "PG_VERSION")):
            data = ""
            args = p["args"]
            for i, x in enumerate(args):
                if x in ("-D", "--pgdata") and i + 1 < len(args):
                    data = args[i + 1]
                elif x.startswith("--pgdata="):
                    data = x.split("=", 1)[1]
                elif x.startswith("-D") and len(x) > 2:
                    data = x[2:]
            data = data or proc_env(p["pid"]).get("PGDATA", "")
        exe = ""
        try:
            exe = os.readlink(f"/proc/{p['pid']}/exe")
        except OSError:
            exe = p["args"][0] if p["args"][0].startswith("/") else ""
        pidf = read_pidfile(data) if data else {}
        port = pidf.get("port") or 0
        for i, x in enumerate(p["args"]):
            if x == "-p" and i + 1 < len(p["args"]) and p["args"][i + 1].isdigit():
                port = port or int(p["args"][i + 1])
        out.append({"pid": p["pid"], "data_dir": data, "port": port or 5432, "socket": pidf.get("socket", ""),
                    "bin": os.path.dirname(exe) if exe else "", "started": p["started"]})
    return out


# ---------------------------------------------------------------- pgBackRest config
# pgBackRest reads --config (default /etc/pgbackrest/pgbackrest.conf, else the old /etc/pgbackrest.conf) and every
# *.conf in --config-include-path (default /etc/pgbackrest/conf.d); --config-path moves both. The options a setup
# really uses are read from archive_command / restore_command, running pgbackrest processes, cron, systemd and the
# PGBACKREST_* environment, so a renamed or moved config is found and every command here uses the same one.

DEFAULT_CONF, LEGACY_CONF, DEFAULT_INCLUDE = "/etc/pgbackrest/pgbackrest.conf", "/etc/pgbackrest.conf", "/etc/pgbackrest/conf.d"
OPT_RE = re.compile(r"--(config|config-path|config-include-path)(?:=|\s+)(['\"]?)([^'\"\s]+)\2")
ENV_RE = re.compile(r"PGBACKREST_(CONFIG|CONFIG_PATH|CONFIG_INCLUDE_PATH)=(['\"]?)([^'\"\s]+)\2")


def pgbackrest_texts():
    """(where, text) of everything that starts pgBackRest on this node"""
    out, later = [], []
    for inst in pg_instances():
        # what the running servers use, the primaries first (their archive_command is what archives WAL)
        ok, rows = psql_on(inst, "select pg_is_in_recovery(), current_setting('archive_command'), "
                                 "coalesce(current_setting('restore_command', true), '')")
        if ok and rows and len(rows[0]) >= 3:
            if rows[0][0] == "t":
                later.extend([("restore_command", rows[0][2]), ("archive_command", rows[0][1])])
            else:
                out.append(("archive_command", rows[0][1]))  # a primary's restore_command is left over from a restore
    out = [x for x in out + later if "pgbackrest" in x[1]]
    # servers that are stopped (during a restore): their config files
    dirs = [i["data_dir"] for i in pg_instances() if i["data_dir"]]
    saved = load_state(SPEC) if SPEC.get("run_id") else {}
    if saved.get("data_dir"):
        dirs.append(saved["data_dir"])
    if not out:
        for d in dict.fromkeys(dirs):
            for f in ("postgresql.auto.conf", "postgresql.conf"):
                for k in ("archive_command", "restore_command"):
                    v = conf_file_value(os.path.join(d, f), k)
                    if v and "pgbackrest" in v:
                        out.append((f, v))
    for p in procs():
        if any(os.path.basename(a) == "pgbackrest" for a in p["args"][:3]):
            out.append(("process", " ".join(p["args"])))
            env = proc_env(p["pid"])
            out.append(("process", " ".join(f"PGBACKREST_{k}={env[f'PGBACKREST_{k}']}" for k in ("CONFIG", "CONFIG_PATH",
                                                                                                    "CONFIG_INCLUDE_PATH") if env.get(f"PGBACKREST_{k}"))))
    files = [*glob.glob("/etc/cron.d/*"), "/etc/crontab", *glob.glob("/var/spool/cron/*"), *glob.glob("/var/spool/cron/crontabs/*"),
             *glob.glob("/etc/systemd/system/*.service"), *glob.glob("/etc/systemd/system/*.service.d/*.conf"),
             *glob.glob("/usr/lib/systemd/system/*backrest*.service"), *glob.glob("/lib/systemd/system/*backrest*.service"),
             "/etc/environment"]
    pat = patroni_conf()
    if pat:
        files += sorted(glob.glob(os.path.join(pat, "*.y*ml"))) if os.path.isdir(pat) else [pat]
    for f in files:
        try:
            if os.path.isfile(f) and os.path.getsize(f) < 2_000_000:
                t = open(f, errors="ignore").read()
                if "backrest" in t.lower():
                    out.append((f, t))
        except OSError:
            pass
    return out


@cached("br")
def br_found():
    found = {"config": "", "config-path": "", "config-include-path": "", "source": ""}
    given = (SPEC.get("config_path") or "").strip()
    if given:
        found.update({"config": given, "source": "given"})
    env = {k: os.environ.get(f"PGBACKREST_{k.upper().replace('-', '_')}", "") for k in ("config", "config-path", "config-include-path")}
    if not given and any(env.values()):
        found.update({k: v for k, v in env.items() if v}, source="environment")
    kept = (load_state(SPEC) if SPEC.get("run_id") else {}).get("br") or {}
    if not found["source"] and kept.get("config") and os.path.isfile(kept["config"]):
        # what this run found while PostgreSQL was still running (stop keeps it)
        found.update({k: kept.get(k, "") for k in ("config", "config-path", "config-include-path")}, source=kept.get("source") or "kept")
    if not found["source"]:
        # every place that starts pgBackRest, with the options it gives (none = pgBackRest's defaults)
        cands = []
        for where, text in pgbackrest_texts():
            envs = {m.group(1).lower().replace("_", "-"): m.group(3) for m in ENV_RE.finditer(text)}
            for line in text.splitlines():
                if not re.search(r"(^|[\s/'\"])pgbackrest(\s|$)", line):
                    continue
                opts = dict(envs)
                opts.update({m.group(1): m.group(3) for m in OPT_RE.finditer(line)})
                cfg = opts.get("config") or (os.path.join(opts["config-path"], "pgbackrest.conf") if opts.get("config-path") else "")
                if not cfg:
                    cfg = DEFAULT_CONF if os.path.isfile(DEFAULT_CONF) else LEGACY_CONF
                    opts = {}
                if os.path.isfile(cfg):
                    cands.append((cfg, opts, where))
        configs = list(dict.fromkeys(c[0] for c in cands))
        if configs:
            # several (a node with more than one PostgreSQL): the one with the stanza asked for, else the one the
            # primary archives with (cands are in that order: primaries, replicas, config files, processes, cron ...)
            want = (SPEC.get("stanza") or "").strip()
            pick = next((c for c in cands if want and want in stanzas(read_conf_file(c[0]))), None) or cands[0]
            found.update({k: v for k, v in pick[1].items() if k in found}, config=pick[0], source=pick[2])
            names = {tuple(sorted(stanzas(read_conf_file(c)))) for c in configs} - {()}
            if len(names) > 1:
                OUT["warnings"].append(f"pgBackRest is used with {len(configs)} configs here ({', '.join(configs)}); "
                                       f"this page uses {pick[0]} - give the stanza to choose another")
    if not found["config"]:
        if found["config-path"]:
            found["config"] = os.path.join(found["config-path"], "pgbackrest.conf")
        elif os.path.isfile(DEFAULT_CONF) or not os.path.isfile(LEGACY_CONF):
            found["config"] = DEFAULT_CONF
        else:
            found["config"] = LEGACY_CONF
    if not os.path.isfile(found["config"]) and not found["source"]:
        # not where pgBackRest looks by default and nothing names it: look for a pgBackRest config near it
        for f in sorted(set(glob.glob("/etc/pgbackrest*/*.conf") + glob.glob("/etc/pgbackrest*.conf") +
                            glob.glob("/etc/*/pgbackrest*.conf") + glob.glob("/etc/*backrest*/**/*.conf", recursive=True))):
            try:
                t = open(f, errors="ignore").read()
            except OSError:
                continue
            if re.search(r"^\s*(repo\d+|pg\d+)-[a-z-]+\s*=", t, re.M):
                found.update(config=f, source="found " + f)
                OUT["warnings"].append(f"pgBackRest config found at {f}, but nothing on this node uses it with --config: "
                                       "pgBackRest itself reads " + DEFAULT_CONF)
                break
    if not found["config-include-path"]:
        # pgBackRest: --config alone reads only that file; --config-path moves conf.d too; neither = the defaults
        explicit = found["source"] not in ("", "default") and found["config"] not in (DEFAULT_CONF, LEGACY_CONF) and not found["config-path"]
        found["config-include-path"] = (os.path.join(found["config-path"], "conf.d") if found["config-path"]
                                        else "" if explicit else DEFAULT_INCLUDE)
    opts = []
    if found["config"] not in (DEFAULT_CONF,) and not (found["config"] == LEGACY_CONF and not os.path.isfile(DEFAULT_CONF)):
        opts.append(f"--config={q(found['config'])}")
    if found["config-include-path"] and found["config-include-path"] != DEFAULT_INCLUDE:
        opts.append(f"--config-include-path={q(found['config-include-path'])}")
    found["opts"] = " ".join(opts)
    return found


def conf_path():
    return br_found()["config"]


def include_dirs(path=None):
    """the directory whose *.conf files pgBackRest also reads (only the one it really uses)"""
    d = br_found()["config-include-path"]
    return [d] if d and os.path.isdir(d) else []


def conf_files(path=None):
    """the main config and the included ones, in the order pgBackRest reads them"""
    path = path or conf_path()
    files = [path] if os.path.isfile(path) else []
    for d in include_dirs(path):
        files += sorted(f for f in glob.glob(os.path.join(d, "*.conf")) if os.path.isfile(f))
    return files


def br(args):
    """a pgbackrest command line with the config this node really uses"""
    exe = which("pgbackrest") or "pgbackrest"
    opts = br_found()["opts"]
    return f"{exe} {opts + ' ' if opts else ''}{args}"


def read_conf(path, only=False):
    """pgBackRest's config as it sees it: the main file merged with conf.d/*.conf (only=True: that one file)"""
    cp = configparser.RawConfigParser(strict=False, interpolation=None)
    cp.optionxform = str
    for f in ([path] if only else conf_files(path)):
        try:
            cp.read_string(open(f, errors="ignore").read(), source=f)
        except (OSError, configparser.Error) as e:
            OUT["warnings"].append(f"{f}: {e}")
    return cp


def read_conf_file(path):
    cp = configparser.RawConfigParser(strict=False, interpolation=None)
    try:
        cp.read_string(open(path, errors="ignore").read())
    except (OSError, configparser.Error):
        pass
    return cp


def stanzas(cp):
    return [s for s in cp.sections() if not s.startswith("global")]


def conf_get(cp, stanza, key, default=""):
    for sec in (stanza, "global"):
        if sec and cp.has_section(sec) and cp.has_option(sec, key):
            return cp.get(sec, key)
    return default


HINT = {}


def stanza_hint():
    """the stanza when the config files do not name one: from the repository, archive_command, cron or systemd"""
    if "v" in HINT:
        return HINT["v"]
    found = ""
    exe = which("pgbackrest")
    if exe:
        rc, o, _ = as_postgres(br("--output=json info"), timeout=120)
        try:
            names = [x.get("name") for x in json.loads(o)] if rc == 0 else []
            found = next((n for n in names if n), "")
        except ValueError:
            pass
    if not found:
        for _, t in pgbackrest_texts():
            m = re.search(r"--stanza[= ]['\"]?([A-Za-z0-9_.-]+)", t or "")
            if m:
                found = m.group(1)
                break
    HINT["v"] = found
    return found


def pick_stanza(spec, cp):
    st = spec.get("stanza") or ""
    names = stanzas(cp)
    if st:
        return st
    if len(names) >= 1:
        return names[0]
    return stanza_hint()


def need_stanza(st):
    if not st:
        fail("no stanza found: none in the pgBackRest config (or conf.d) and none in the repository. "
             "Give the stanza name, or add a [stanza] section in Configuration and create it")
    return st


def pg_of(cp, stanza):
    """this node's PostgreSQL as pgBackRest sees it (pg1-*); the data directory found elsewhere when not set"""
    port = conf_get(cp, stanza, "pg1-port")
    pg = {"data_dir": conf_get(cp, stanza, "pg1-path"), "port": int(port) if port.isdigit() else 0,
          "socket": conf_get(cp, stanza, "pg1-socket-path"), "host": conf_get(cp, stanza, "pg1-host"),
          "user": conf_get(cp, stanza, "pg1-user", "postgres") or "postgres", "bin": ""}
    if pg["host"]:
        pg["port"] = pg["port"] or 5432
        return pg
    # the running server this config is about: same data directory, else same port, else the only one
    insts = pg_instances()
    real = os.path.realpath(pg["data_dir"]) if pg["data_dir"] else ""
    inst = next((i for i in insts if real and i["data_dir"] and os.path.realpath(i["data_dir"]) == real), None)
    if not inst and not real:
        inst = next((i for i in insts if pg["port"] and i["port"] == pg["port"]), None) or (insts[0] if len(insts) == 1 else None)
    saved = load_state(SPEC) if SPEC.get("run_id") else {}
    if not pg["data_dir"]:
        pg["data_dir"] = (inst or {}).get("data_dir") or saved.get("data_dir") or local_data_dir()
    if saved.get("data_dir") and saved["data_dir"] != pg["data_dir"]:
        saved = {}  # kept for another server
    if inst:
        pg["port"] = pg["port"] or inst["port"]
        pg["socket"] = pg["socket"] or inst["socket"]
        pg["bin"] = inst["bin"]
    else:
        # stopped: what it used when it ran (kept by stop), its postgresql.conf, else the defaults
        pg["port"] = pg["port"] or saved.get("port") or int(conf_file_value(os.path.join(pg["data_dir"], "postgresql.conf"), "port", True) or 0) or 5432
        pg["socket"] = pg["socket"] or saved.get("socket", "")
        pg["bin"] = saved.get("bin", "")
    return pg


def local_data_dir():
    """the data directory of a PostgreSQL that is not running: Patroni's config, the service's PGDATA"""
    try:
        conf = patroni_conf()
        if conf:
            m = re.search(r"^\s+data_dir:\s*['\"]?([^'\"\s]+)", patroni_text(conf), re.M)
            if m:
                return m.group(1)
    except Exception:  # noqa: BLE001
        pass
    rc, o, _ = sh(["systemctl", "list-unit-files", "--no-legend", "--type=service", "postgresql*"], timeout=30)
    for unit in [line.split()[0] for line in o.splitlines() if line.strip()] if rc == 0 else []:
        _, env, _ = sh(["systemctl", "show", "-p", "Environment", unit], timeout=30)
        m = re.search(r"PGDATA=(\S+)", env)
        if m and os.path.isfile(os.path.join(m.group(1), "PG_VERSION")):
            return m.group(1)
    return ""


def pg_tool(name):
    for p in sorted(glob.glob(f"/usr/pgsql-*/bin/{name}") + glob.glob(f"/usr/lib/postgresql/*/bin/{name}"), reverse=True):
        return p
    return which(name)


def psql_on(inst, sql, timeout=30):
    return psql({"port": inst["port"], "socket": inst["socket"], "bin": inst["bin"]}, sql, timeout)


def psql(pg, sql, timeout=30):
    """one query on the local PostgreSQL through its socket; (ok, rows of fields)"""
    exe = os.path.join(pg["bin"], "psql") if pg.get("bin") and os.path.exists(os.path.join(pg["bin"], "psql")) else pg_tool("psql")
    if not exe:
        return False, "psql not found"
    sockets = [pg["socket"]] if pg.get("socket") else ["/var/run/postgresql", "/run/postgresql", "/tmp"]
    last = ""
    for s in sockets:
        if s and not os.path.isdir(s):
            continue
        rc, o, e = as_postgres(f"{exe} -XAt -F '|' -h {q(s)} -p {pg['port']} -d postgres -c {q(sql)}", timeout=timeout)
        if rc == 0:
            return True, [line.split("|") for line in o.strip().splitlines()]
        last = (e or o).strip()
    return False, last


def pg_state(pg):
    ok, rows = psql(pg, "select pg_is_in_recovery(), current_setting('archive_mode'), current_setting('archive_command'), "
                        "coalesce(a.last_archived_wal,''), coalesce(a.last_archived_time::text,''), coalesce(a.last_failed_wal,''), "
                        "coalesce(a.last_failed_time::text,''), a.archived_count, a.failed_count, now()::text, "
                        "current_setting('server_version'), current_setting('data_directory'), "
                        "case when pg_is_in_recovery() then pg_last_wal_replay_lsn()::text else pg_current_wal_lsn()::text end, "
                        "coalesce(current_setting('primary_slot_name', true), ''), "
                        "(select coalesce(string_agg(slot_name, ','), '') from pg_replication_slots where slot_type = 'physical'), "
                        "current_setting('archive_timeout'), "
                        "case when pg_is_in_recovery() then '' else pg_walfile_name(pg_current_wal_lsn()) end, "
                        "case when pg_is_in_recovery() then 0 else (pg_current_wal_lsn() - '0/0'::pg_lsn)::numeric "
                        "% pg_size_bytes(current_setting('wal_segment_size')) end, pg_size_bytes(current_setting('wal_segment_size')), "
                        "current_setting('config_file'), current_setting('hba_file'), current_setting('ident_file'), "
                        "current_setting('log_directory'), current_setting('log_filename'), current_setting('logging_collector'), "
                        "current_setting('log_destination'), current_setting('port'), coalesce(pg_current_logfile(), '') "
                        "from pg_stat_archiver a")
    if not ok:
        return {"running": False, "error": rows if isinstance(rows, str) else ""}
    r = rows[0] + [""] * 30
    data = r[11]
    logdir = r[22] if r[22].startswith("/") or not r[22] else os.path.join(data, r[22])
    cur = r[27] if not r[27] or r[27].startswith("/") else os.path.join(data, r[27])
    return {"running": True, "role": "replica" if r[0] == "t" else "primary", "archive_mode": r[1], "archive_command": r[2],
            "last_archived_wal": r[3], "last_archived_time": r[4], "last_failed_wal": r[5], "last_failed_time": r[6],
            "archived_count": int(r[7] or 0), "failed_count": int(r[8] or 0), "now": r[9], "version": r[10],
            "data_directory": data, "lsn": r[12], "primary_slot_name": r[13],
            "slots": [x for x in r[14].split(",") if x], "archive_timeout": r[15], "current_wal": r[16],
            "pending_wal_bytes": pending_wal(r[16], r[3], r[17], r[18]), "wal_in_segment": r[17], "wal_segment_size": r[18],
            "files": {"config_file": r[19], "hba_file": r[20], "ident_file": r[21], "log_directory": logdir,
                      "log_filename": r[23], "logging_collector": r[24], "log_destination": r[25], "current_log": cur},
            "port": int(r[26]) if r[26].isdigit() else pg.get("port")}


def pending_wal(current, archived, in_seg, seg_size):
    """WAL written on the primary that is not in the repository yet (bytes); None when unknown."""
    try:
        size, in_seg = int(seg_size), int(float(in_seg or 0))
        per = 0x100000000 // size

        def idx(f):
            return int(f[8:16], 16) * per + int(f[16:24], 16)
        if not current:
            return None
        if archived.endswith(".backup") or archived.endswith(".partial"):
            archived = archived[:24]  # its segment (or an earlier one): an estimate on the safe side
        if not archived or archived[:8] != current[:8] or len(archived) != 24:
            return in_seg if archived and archived[:8] < current[:8] and idx(archived) == idx(current) - 1 else None
        return max(idx(current) - idx(archived) - 1, 0) * size + in_seg
    except (ValueError, ZeroDivisionError):
        return None


# ---------------------------------------------------------------- Patroni

def patroni_conf():
    """Patroni's config: a file, or a directory of *.yml files (Patroni accepts both)"""
    _, o, _ = sh("ps -eo args")
    for line in o.splitlines():
        f = line.split()
        if len(f) > 1 and any(os.path.basename(x) in ("patroni", "patroni.py") for x in f[:3]) and os.path.exists(f[-1]):
            return f[-1]
    for f in ("/etc/patroni/patroni.yml", "/etc/patroni.yml", "/etc/patroni/config.yml", *sorted(glob.glob("/etc/patroni/*.yml")),
              *sorted(glob.glob("/etc/patroni/*.yaml"))):
        if os.path.isfile(f) or (os.path.isdir(f) and glob.glob(os.path.join(f, "*.y*ml"))):
            return f
    return None


def patroni_text(conf):
    files = sorted(glob.glob(os.path.join(conf, "*.yml")) + glob.glob(os.path.join(conf, "*.yaml"))) if os.path.isdir(conf) else [conf]
    out = []
    for f in files:
        try:
            out.append(open(f, errors="ignore").read())
        except OSError:
            pass
    return "\n".join(out)


def patroni_state():
    conf = patroni_conf()
    if not conf:
        return None
    txt = patroni_text(conf)
    scope = re.search(r"^scope:\s*['\"]?([^'\"\s]+)", txt, re.M)
    name = re.search(r"^name:\s*['\"]?([^'\"\s]+)", txt, re.M)
    api = re.search(r"^restapi:\s*\n(?:\s+.*\n)*?\s+connect_address:\s*['\"]?([^'\"\s]+)", txt, re.M)
    info = {"config": conf, "scope": scope.group(1) if scope else "", "member": name.group(1) if name else "",
            "api": api.group(1) if api else "127.0.0.1:8008", "running": False}
    for addr in (info["api"], "127.0.0.1:8008"):
        try:
            with urllib.request.urlopen(f"http://{addr}/patroni", timeout=4) as r:
                j = json.loads(r.read().decode())
                info.update(role=j.get("role", ""), state=j.get("state", ""), running=True)
                break
        except Exception:  # noqa: BLE001 - not running / not reachable
            pass
    return info


def patroni_unit():
    for u in ("patroni", "patroni@*"):
        rc, o, _ = sh(["systemctl", "list-unit-files", "--no-legend", f"{u}.service"])
        if rc == 0 and o.strip():
            return o.split()[0]
    return "patroni.service"


def wait_patroni(role=None, timeout=600):
    t0 = time.time()
    while time.time() - t0 < timeout:
        st = patroni_state() or {}
        if st.get("state") == "running" and (not role or st.get("role") in role):
            return st
        time.sleep(3)
    fail(f"Patroni did not report a running {role or 'member'} within {timeout}s (last: {patroni_state()})")


# ---------------------------------------------------------------- PostgreSQL service

def pg_units():
    rc, o, _ = sh(["systemctl", "list-units", "--type=service", "--state=active", "--plain", "--no-legend", "postgresql*"])
    return [line.split()[0] for line in o.splitlines() if line.strip()] if rc == 0 else []


def pg_ctl(pg, what, timeout=3600):
    own = os.path.join(pg.get("bin") or "", "pg_ctl")
    exe = own if pg.get("bin") and os.path.exists(own) else pg_tool("pg_ctl")
    if not exe or not pg.get("data_dir"):
        fail("pg_ctl or the data directory (pg1-path) was not found")
    log = f"/tmp/pg_mantra_pg_{pg['port']}.log"
    extra = f"-l {log} -t {timeout}" if what == "start" else "-m fast -t 600"
    # the config may live outside the data directory (Debian: /etc/postgresql/<v>/<name>): pg_ctl -D takes that directory
    saved = load_state(SPEC) if SPEC.get("run_id") else {}
    cdir = (saved.get("config_dir") if saved.get("data_dir") == pg["data_dir"] else "") or pg["data_dir"]
    if not os.path.isfile(os.path.join(cdir, "postgresql.conf")):
        cdir = pg["data_dir"]
    rc, o, e = as_postgres(f"{exe} -D {q(cdir)} -w {extra} {what}", timeout=timeout + 60)
    already = what == "stop" and any(x in (e + o).lower() for x in ("not running", "does not exist", "is server running"))
    if rc != 0 and not already:
        tail = ""
        if what == "start" and os.path.exists(log):
            tail = " | log: " + open(log, errors="ignore").read()[-600:]
        fail(f"pg_ctl {what} failed: {(e or o).strip()[-500:]}{tail}")


def state_file(spec):
    os.makedirs(STATE_DIR, exist_ok=True)
    return os.path.join(STATE_DIR, f"run-{spec.get('run_id', 0)}.json")


def save_state(spec, data):
    with open(state_file(spec), "w") as f:
        json.dump(data, f)


def load_state(spec):
    try:
        return json.load(open(state_file(spec)))
    except (OSError, ValueError):
        return {}


def wait_pg(pg, want_primary=False, timeout=3600):
    t0 = time.time()
    last = {}
    while time.time() - t0 < timeout:
        last = pg_state(pg)
        if last.get("running") and (not want_primary or last.get("role") == "primary"):
            return last
        time.sleep(3)
    fail(f"PostgreSQL did not become {'a primary' if want_primary else 'ready'} within {timeout}s (last: {last})")


# ---------------------------------------------------------------- actions

def pgbackrest(args, timeout=86400):
    if not which("pgbackrest"):
        fail("pgbackrest is not installed on this node")
    rc, o, e = as_postgres(br(args), timeout=timeout)
    OUT.setdefault("commands", []).append(f"pgbackrest {args}")
    OUT["output"] = (o + e).strip()[-3000:]
    return rc, o, e


def systemd_timers():
    """backup jobs kept as systemd timers (e.g. by the HA automation), shown with the cron entries"""
    rc, o, _ = sh(["systemctl", "list-timers", "--all", "--no-legend", "--plain"], timeout=30)
    out = []
    if rc != 0:
        return out
    for line in o.splitlines():
        toks = line.split()
        timer = next((t for t in toks if t.endswith(".timer")), None)
        if not timer:
            continue
        svc = next((t for t in toks if t.endswith(".service")), timer[:-6] + ".service")
        _, s1, _ = sh(["systemctl", "cat", svc], timeout=30)
        if "backrest" not in s1.lower() and "backrest" not in timer.lower() and "backup" not in timer.lower():
            continue
        _, t1, _ = sh(["systemctl", "cat", timer], timeout=30)
        cal = [c.strip() for c in re.findall(r"^OnCalendar=(.+)$", t1, re.M) if c.strip()]
        exe = re.findall(r"^ExecStart=(.+)$", s1, re.M)
        tp = re.search(r"--type[= ](full|diff|incr)", s1) or re.search(r"(full|diff|incr)", timer)
        out.append({"file": f"systemd {timer}", "line": f"{' / '.join(cal) or '?'}  {tp.group(1) if tp else ''}  "
                    f"{(exe[-1].strip() if exe else svc)[:300]}", "ours": False, "timer": True,
                    "type": tp.group(1) if tp else "", "calendar": cal})
    return out


def unit_of(pid):
    """the systemd unit a process runs in (from its cgroup), or ''"""
    try:
        for line in open(f"/proc/{pid}/cgroup", errors="ignore"):
            m = re.search(r"/([^/]+\.(?:service|scope))$", line.strip())
            if m:
                return m.group(1)
    except OSError:
        pass
    return ""


def running_backups():
    """pgBackRest backups running on this node now: who started them (a schedule - cron or a systemd timer -, the
    console, someone in a shell), type, stanza, repository, since when, and how far they are (pgBackRest 2.48+)"""
    out = []
    by = {x["pid"]: x for x in procs()}
    for p in procs():
        a = p["args"]
        if not a or not any(os.path.basename(x) == "pgbackrest" for x in a[:3]) or "backup" not in a:
            continue
        par = by.get(p["ppid"])
        if par and any(os.path.basename(x) == "pgbackrest" for x in par["args"][:3]):
            continue  # a worker of another pgbackrest
        chain = ancestors(p)
        text = " ".join(" ".join(x["args"]) for x in chain)
        comms = {x["comm"] for x in chain}
        unit = unit_of(p["pid"])
        if "pgm_backup.py" in text or "ansible" in text.lower():
            who, how = "console", ""
        elif comms & {"cron", "crond", "CROND", "anacron", "atd", "fcron"}:
            who, how = "schedule", "cron"
        elif comms & {"sshd", "login", "tmux: server", "screen", "agetty"} or unit.startswith("session-"):
            who, how = "manual", ""
        elif unit.endswith(".service") and (os.path.exists(f"/etc/systemd/system/{unit[:-8]}.timer") or
                                            os.path.exists(f"/usr/lib/systemd/system/{unit[:-8]}.timer") or
                                            os.path.exists(f"/lib/systemd/system/{unit[:-8]}.timer") or
                                            sh(["systemctl", "cat", unit[:-8] + ".timer"], timeout=10)[0] == 0):
            who, how = "schedule", "timer " + unit[:-8] + ".timer"
        else:
            who, how = "other", unit
        opt = lambda k, d="": next((m.group(1) for x in a for m in [re.match(rf"--{k}=(.+)", x)] if m), d)  # noqa: E731
        out.append({"pid": p["pid"], "stanza": opt("stanza"), "type": opt("type", "incr"), "repo": opt("repo"),
                    "started": p["started"], "by": who, "how": how, "user": proc_owner(p["pid"])})
    # how far each one is: pgBackRest keeps it in its lock (info shows it while the backup runs)
    for st in {r["stanza"] for r in out if r["stanza"]}:
        rc, o, _ = as_postgres(br(f"--stanza={q(st)} --output=json info"), timeout=60)
        try:
            lock = (json.loads(o)[0].get("status", {}).get("lock", {}) or {}).get("backup", {}) if rc == 0 else {}
        except (ValueError, IndexError, AttributeError):
            lock = {}
        for r in out:
            if r["stanza"] == st and lock:
                r["held"] = lock.get("held")
                if lock.get("size"):
                    r["size"], r["done"] = lock.get("size"), lock.get("size-cplt")
    return out


def proc_owner(pid):
    try:
        import pwd
        return pwd.getpwuid(os.stat(f"/proc/{pid}").st_uid).pw_name
    except (OSError, KeyError, ImportError):
        return ""


def activity(spec):
    """only what runs now (fast: the console asks often)"""
    OUT["running"] = running_backups()
    OUT["now"] = int(time.time())


def section(name, fn):
    """one part of the status: an error there is reported, the rest still runs"""
    try:
        fn()
    except Exception as e:  # noqa: BLE001
        OUT["warnings"].append(f"{name}: {type(e).__name__}: {e}")


SECRET_KEY = re.compile(r"(cipher-pass|-key$|-key-|secret|password|token|-pass$)")
MASK = "********"


def mask(text):
    """a config with its secrets (S3 / Azure keys, cipher passwords ...) hidden: they never leave the node"""
    out = []
    for line in text.splitlines():
        m = re.match(r"^(\s*)([A-Za-z0-9-]+)(\s*=\s*)(.*)$", line)
        if m and SECRET_KEY.search(m.group(2)) and m.group(4).strip() and "-key-type" not in m.group(2):
            line = f"{m.group(1)}{m.group(2)}{m.group(3)}{MASK}"
        out.append(line)
    return "\n".join(out) + ("\n" if text.endswith("\n") else "")


REPO_TYPES = ("posix", "cifs", "s3", "azure", "gcs", "sftp")


def repo_list(cp, st):
    """every repository (repo1, repo2 ...) of the config, of any type, without its secrets"""
    keys = sorted({int(m.group(1)) for sec in ["global", st] if sec and cp.has_section(sec) for k in cp.options(sec)
                   for m in [re.match(r"repo(\d+)-", k)] if m})
    if not keys and (cp.sections() or os.path.isfile(conf_path())):
        keys = [1]  # nothing set: pgBackRest uses repo1 in /var/lib/pgbackrest
    out = []
    for n in keys:
        g = lambda k, d="": conf_get(cp, st, f"repo{n}-{k}", d)  # noqa: E731
        t = g("type", "posix")
        r = {"key": f"repo{n}", "index": n, "type": t, "path": g("path", "/var/lib/pgbackrest"),
             "host": g("host"), "retention_full": g("retention-full"), "retention_diff": g("retention-diff"),
             "retention_full_type": g("retention-full-type", "count"), "cipher": g("cipher-type", "none"),
             "bucket": g("s3-bucket") or g("gcs-bucket") or g("azure-container"),
             "endpoint": g("s3-endpoint") or g("gcs-endpoint") or g("azure-endpoint") or g("sftp-host"),
             "region": g("s3-region"), "managed": repo_managed(n)}
        if t == "posix" and not r["host"] and os.path.isdir(r["path"]):
            v = os.statvfs(r["path"])
            r["free_bytes"] = v.f_bavail * v.f_frsize
            r["total_bytes"] = v.f_blocks * v.f_frsize
        out.append(r)
    return out


def status(spec):
    path = conf_path()
    files = conf_files(path)
    found = br_found()
    OUT["config_path"] = path
    OUT["config_found"] = {"source": found["source"] or "default", "options": found["opts"],
                           "include_path": found["config-include-path"], "exists": os.path.isfile(path)}
    OUT["config"] = mask(open(path, errors="ignore").read()) if os.path.isfile(path) else ""
    OUT["config_files"] = []
    for f in files:
        try:
            OUT["config_files"].append({"path": f, "content": mask(open(f, errors="ignore").read())})
        except OSError:
            pass
    exe = which("pgbackrest")
    OUT["installed"] = bool(exe)
    if exe:
        _, o, _ = sh([exe, "version"])
        OUT["version"] = o.strip().replace("pgBackRest ", "")
    cp = read_conf(path)
    st = pick_stanza(spec, cp)
    OUT["stanzas"] = stanzas(cp)
    OUT["stanza"] = st
    OUT["stanza_in_config"] = bool(st and cp.has_section(st))
    pg = pg_of(cp, st)
    # a repository server backs up remote PostgreSQL servers (pg1-host...); a database node may itself use a
    # remote repository (repo1-host)
    OUT["pg_conf"] = pg
    OUT["pg_instances"] = [{k: i[k] for k in ("data_dir", "port", "socket", "bin")} for i in pg_instances()]
    OUT["repo_host"] = bool(pg.get("host"))
    OUT["remote_repo"] = conf_get(cp, st, "repo1-host")

    def repos():
        OUT["repos"] = repo_list(cp, st)
    OUT["repos"] = []
    section("repositories", repos)

    def act():
        OUT["running"] = running_backups()
    OUT["running"] = []
    section("running backups", act)

    def info():
        rc, o, e = as_postgres(br("--output=json info"), timeout=120)
        try:
            OUT["info"] = json.loads(o) if rc == 0 else []
        except ValueError:
            OUT["info"] = []
        if rc != 0:
            OUT["info_error"] = (e or o).strip()[-800:]
        if st and OUT.get("info"):
            cur = next((x for x in OUT["info"] if x.get("name") == st), None)
            if cur:
                OUT["usable_sets"], OUT["timeline"] = usable_sets(st, cur)
    if exe:
        section("pgbackrest info", info)

    def pgs():
        OUT["pg"] = pg_state(pg) if not pg.get("host") else {"running": False, "remote": pg["host"]}
        # a stopped replica: which slot it streams from, read from its config (a restore recreates it)
        data = pg.get("data_dir") or ""
        if not pg.get("host") and data and not OUT["pg"].get("primary_slot_name"):
            for f in ("postgresql.auto.conf", "postgresql.conf"):
                v = conf_file_value(os.path.join(data, f), "primary_slot_name")
                if v:
                    OUT["pg"]["primary_slot_name"] = v
                    break
    OUT["pg"] = {}
    section("PostgreSQL", pgs)

    def pending_from_repo():
        # after a restart PostgreSQL forgets its last archived WAL: ask the repository instead
        p = OUT["pg"]
        if p.get("role") != "primary" or p.get("pending_wal_bytes") is not None:
            return
        cur = next((x for x in OUT.get("info") or [] if x.get("name") == st), None)
        archived = max((a.get("max") or "" for a in (cur or {}).get("archive") or []), default="")
        if archived:
            p["pending_wal_bytes"] = pending_wal(p.get("current_wal"), archived, p.get("wal_in_segment"), p.get("wal_segment_size"))
            p["pending_from"] = "repository"
    section("unarchived WAL", pending_from_repo)
    OUT["patroni"] = None

    def pat():
        OUT["patroni"] = patroni_state()
    section("Patroni", pat)

    def crons():
        cron = []
        for f in [CRON_FILE, *glob.glob("/etc/cron.d/*"), "/etc/crontab"]:
            if os.path.isfile(f):
                for line in open(f, errors="ignore"):
                    if "pgbackrest" in line and not line.strip().startswith("#"):
                        cron.append({"file": f, "line": line.strip(), "ours": f == CRON_FILE})
        rc, o, _ = sh(["crontab", "-l", "-u", "postgres"])
        if rc == 0:
            cron += [{"file": "crontab -u postgres", "line": line.strip(), "ours": False} for line in o.splitlines()
                     if "pgbackrest" in line and not line.strip().startswith("#")]
        cron += systemd_timers()
        seen = set()
        for c in cron:
            if (c["file"], c["line"]) not in seen:
                seen.add((c["file"], c["line"]))
                OUT["cron"].append(c)
    OUT["cron"] = []
    section("schedule", crons)


def repo_opt(spec):
    """--repo=N when one repository is chosen (several are configured)"""
    r = str(spec.get("repo") or "").strip().replace("repo", "")
    if not r:
        return ""
    if not r.isdigit() or not 1 <= int(r) <= 256:
        fail(f"not a repository number: {spec.get('repo')}")
    return f" --repo={int(r)}"


def backup(spec):
    cp = read_conf(conf_path())
    st = need_stanza(pick_stanza(spec, cp))
    t = spec.get("type", "incr")
    if t not in ("full", "diff", "incr"):
        fail(f"unknown backup type {t}")
    pg = pg_of(cp, st)
    if not pg.get("host"):
        s = pg_state(pg)
        if s.get("role") == "replica" and conf_get(cp, st, "backup-standby", "n") not in ("y", "yes"):
            fail("this node is a standby; backups run on the primary (or set backup-standby=y)")
    rc, o, e = pgbackrest(f"--stanza={q(st)}{repo_opt(spec)} --type={t} backup")
    if rc != 0:
        fail(f"backup failed: {(e or o).strip()[-1200:]}")
    rc, o, _ = as_postgres(br(f"--stanza={q(st)} --output=json info"), timeout=120)
    try:
        b = json.loads(o)[0]["backup"][-1]
        OUT["backup"] = {"label": b["label"], "type": b["type"], "size": b.get("info", {}).get("size"),
                         "repo": (b.get("database") or {}).get("repo-key"),
                         "repo_size": b.get("info", {}).get("repository", {}).get("delta"),
                         "start": b["timestamp"]["start"], "stop": b["timestamp"]["stop"]}
    except (ValueError, KeyError, IndexError):
        pass


def check(spec, create=False):
    cp = read_conf(conf_path())
    st = need_stanza(pick_stanza(spec, cp))
    if create:
        rc, o, e = pgbackrest(f"--stanza={q(st)} stanza-create", timeout=600)
        if rc != 0:
            fail(f"stanza-create failed: {(e or o).strip()[-1200:]}")
        OUT["created"] = st
    rc, o, e = pgbackrest(f"--stanza={q(st)} check", timeout=600)
    if rc != 0:
        fail((f"stanza {st} was created, but " if create else "") + f"check failed: {(e or o).strip()[-1200:]}")
    OUT["checked"] = st


LOCAL_KEY = re.compile(r"^pg\d+-(path|port|socket-path|host|host-user|host-config|host-config-path|host-port|database|user)$")


def merge_local(new_text, cp_old):
    """the new config, keeping this node's own pg*-path / port / socket / host... values"""
    new = configparser.RawConfigParser(strict=False, interpolation=None)
    new.optionxform = str
    new.read_string(new_text)
    kept = []
    for sec in new.sections():
        if not cp_old.has_section(sec):
            continue
        for k in cp_old.options(sec):
            if LOCAL_KEY.match(k):
                if new.get(sec, k, fallback=None) != cp_old.get(sec, k):
                    kept.append(f"[{sec}] {k}={cp_old.get(sec, k)}")
                new.set(sec, k, cp_old.get(sec, k))
    buf = io.StringIO()
    new.write(buf, space_around_delimiters=False)
    return buf.getvalue().rstrip() + "\n", kept


def target_file(spec):
    """the config file to write: the main one, or one of conf.d/*.conf (by its name)"""
    main = conf_path()
    want = (spec.get("file") or "").strip()
    if not want or want == main or os.path.basename(want) == os.path.basename(main):
        return main
    name = os.path.basename(want)
    if not re.fullmatch(r"[A-Za-z0-9_.-]+\.conf", name):
        fail(f"not a pgBackRest config file name: {want}")
    if not br_found()["config-include-path"]:
        fail(f"pgBackRest here reads only {main} (--config without --config-include-path): edit that file")
    return os.path.join(br_found()["config-include-path"], name)


def unmask(text, path):
    """the hidden secrets of an edited config (shown as ********) get their values back from this node's config"""
    if MASK not in text:
        return text
    mine = read_conf(path, only=True) if os.path.exists(path) else None
    merged = read_conf(conf_path())
    out, sec = [], ""
    for line in text.splitlines():
        m = re.match(r"^\s*\[([^\]]+)\]", line)
        if m:
            sec = m.group(1).strip()
        m = re.match(r"^(\s*)([A-Za-z0-9-]+)(\s*=\s*)\*{8}\s*$", line)
        if m:
            k = m.group(2)
            v = next((c.get(x, k) for c in (mine, merged) if c for x in (sec, "global") if c.has_section(x) and c.has_option(x, k)), None)
            if v is None:
                fail(f"[{sec}] {k} is hidden (********) but this node has no value for it: type the value")
            line = f"{m.group(1)}{k}{m.group(3)}{v}"
        out.append(line)
    return "\n".join(out) + ("\n" if text.endswith("\n") else "")


def config_apply(spec):
    text = base64.b64decode(spec.get("content_b64", "")).decode()
    text = unmask(text, target_file(spec))
    try:
        test = configparser.RawConfigParser(strict=False, interpolation=None)
        test.read_string(text)
    except configparser.Error as e:
        fail(f"the new config is not valid: {e}")
    path = target_file(spec)
    # with the other files (conf.d) there must still be a stanza
    others = [f for f in conf_files() if os.path.realpath(f) != os.path.realpath(path)]
    allc = configparser.RawConfigParser(strict=False, interpolation=None)
    for f in others:
        try:
            allc.read_string(open(f, errors="ignore").read(), source=f)
        except (OSError, configparser.Error):
            pass
    if not stanzas(test) and not stanzas(allc):
        fail("no stanza section (e.g. [main]) in the new config or in conf.d")
    OUT["path"] = path
    old = open(path, errors="ignore").read() if os.path.exists(path) else ""
    if spec.get("keep_local", True) and old:
        text, kept = merge_local(text, read_conf(path, only=True))
        OUT["kept_local"] = kept
    saved = f"{path}.pgm-{spec.get('run_id', 0)}"
    if old and not os.path.exists(saved):
        shutil.copy2(path, saved)
    OUT["saved"] = saved if old else ""
    if not old:
        open(new_marker(path, spec), "w").close()  # remember it was new: undo removes it
    st = os.stat(path) if os.path.exists(path) else None
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".pgm-new", "w") as f:
        f.write(text)
    if st:
        os.chmod(path + ".pgm-new", st.st_mode & 0o777)
        try:
            os.chown(path + ".pgm-new", st.st_uid, st.st_gid)
        except PermissionError:
            pass
    else:
        os.chmod(path + ".pgm-new", 0o640)
        sh(["chown", "postgres:postgres", path + ".pgm-new"])
    os.replace(path + ".pgm-new", path)
    OUT["changed"] = old != text
    OUT["config"] = text


def new_marker(path, spec):
    os.makedirs(STATE_DIR, exist_ok=True)
    return os.path.join(STATE_DIR, f"new-{spec.get('run_id', 0)}-{os.path.basename(path)}")


def config_undo(spec):
    undo_file(target_file(spec), spec)


def undo_file(path, spec):
    saved = f"{path}.pgm-{spec.get('run_id', 0)}"
    marker = new_marker(path, spec)
    if os.path.exists(marker):
        if os.path.exists(path):
            os.remove(path)
        os.remove(marker)
        OUT["removed"] = path
        return
    if not os.path.exists(saved):
        OUT["warnings"].append("no saved config for this run (nothing to put back)")
        return
    shutil.copy2(saved, path)
    OUT["restored"] = saved


# ---------------------------------------------------------------- repositories (a second disk, S3, Azure, GCS, SFTP)
# A repository added here is written as its own file, <include path>/pgm-repo<N>.conf ([global] repoN-...), on every
# node, so the main config is not touched and removing it is just removing that file. Database nodes of a layout with
# a repository server reach a disk repository through that server (repoN-host); S3 / Azure / GCS / SFTP are reached
# directly by every node (WAL is pushed from the primary, backups run on the repository server or the primary).

REPO_FIELDS = {
    "posix": {"path": "path"},
    "cifs": {"path": "path"},
    "s3": {"path": "path", "bucket": "s3-bucket", "endpoint": "s3-endpoint", "region": "s3-region", "key": "s3-key",
           "secret": "s3-key-secret", "uri_style": "s3-uri-style", "key_type": "s3-key-type", "port": "storage-port",
           "ca_file": "storage-ca-file"},
    "azure": {"path": "path", "account": "azure-account", "key": "azure-key", "container": "azure-container",
              "endpoint": "azure-endpoint", "key_type": "azure-key-type", "uri_style": "azure-uri-style", "port": "storage-port"},
    "gcs": {"path": "path", "bucket": "gcs-bucket", "key": "gcs-key", "key_type": "gcs-key-type", "endpoint": "gcs-endpoint"},
    "sftp": {"path": "path", "host": "sftp-host", "port": "sftp-host-port", "user": "sftp-host-user",
             "private_key": "sftp-private-key-file", "host_key_check": "sftp-host-key-check-type"},
}


def repo_file(n):
    """its own file in conf.d, or '' when pgBackRest reads only the main config here (then it is a marked block there)"""
    d = br_found()["config-include-path"]
    return os.path.join(d, f"pgm-repo{int(n)}.conf") if d else ""


def block_marks(n):
    return f"# >>> autoNOMIC repository {int(n)}", f"# <<< autoNOMIC repository {int(n)}"


def repo_managed(n):
    f = repo_file(n)
    if f:
        return os.path.isfile(f)
    try:
        return block_marks(n)[0] in open(conf_path(), errors="ignore").read()
    except OSError:
        return False


def drop_block(text, n):
    a, b = block_marks(n)
    return re.sub(rf"\n?{re.escape(a)}\n.*?{re.escape(b)}\n?", "\n", text, flags=re.S)


def put_block(text, n, body):
    """the repository's lines inside the main config's [global] section (made if there is none)"""
    a, b = block_marks(n)
    lines = [x for x in body.splitlines() if x and not x.startswith("[") and not x.startswith("#")]
    block = "\n".join([a, *lines, b])
    text = drop_block(text, n)
    m = re.search(r"^\[global\]\s*$", text, re.M)
    if m:
        return text[:m.end()] + "\n" + block + text[m.end():]
    return "[global]\n" + block + "\n\n" + text


def repo_text(d, n, cp, st, remote_server):
    """the [global] lines of repository n on this node"""
    t = d.get("type", "posix")
    if t not in REPO_FIELDS:
        fail(f"unknown repository type {t}")
    lines = [] if t == "posix" else [f"repo{n}-type={t}"]

    def put(k, v):
        v = str(v if v is not None else "").strip()
        if v:
            if "\n" in v or "\r" in v:
                fail(f"repo{n}-{k}: one line only")
            lines.append(f"repo{n}-{k}={v}")
    if t in ("posix", "cifs") and remote_server:
        # a database node reaches the disk of the repository server, like it does for repo1
        put("host", remote_server)
        for k, v in sorted({k: cp.get(sec, k) for sec in ("global", st) if sec and cp.has_section(sec) for k in cp.options(sec)}.items()):
            m = re.match(r"repo1-(host-.+)$", k)
            if m:
                put(m.group(1), v)
        if not any(x.startswith(f"repo{n}-host-user=") for x in lines):
            put("host-user", d.get("host_user") or "postgres")
    for field, key in REPO_FIELDS[t].items():
        if field == "verify_tls":
            continue
        put(key, d.get(field))
    if t in ("s3", "azure", "gcs") and str(d.get("verify_tls", "y")).lower() in ("n", "no", "false", "0"):
        put("storage-verify-tls", "n")
    if t in ("posix", "cifs", "sftp") and not str(d.get("path", "")).startswith("/"):
        fail("the repository path must be absolute (e.g. /backup/pgbackrest)")
    if t == "s3" and not (d.get("bucket") and d.get("endpoint") and d.get("region")):
        fail("S3 needs the bucket, the endpoint and the region")
    if t == "s3" and d.get("key_type", "shared") == "shared" and not (d.get("key") and d.get("secret")):
        fail("S3 needs the access key and the secret key (or key type auto)")
    if t == "azure" and not (d.get("account") and d.get("container") and d.get("key")):
        fail("Azure needs the storage account, the container and the key")
    if t == "gcs" and not d.get("bucket"):
        fail("GCS needs the bucket")
    if t == "sftp" and not (d.get("host") and d.get("user") and d.get("private_key")):
        fail("SFTP needs the host, the user and the private key file")
    for k in ("retention_full", "retention_diff"):
        if str(d.get(k) or "").strip():
            if not str(d[k]).strip().isdigit():
                fail(f"{k.replace('_', ' ')} must be a number")
            put(k.replace("_", "-"), d[k])
    if d.get("cipher_pass"):
        put("cipher-type", "aes-256-cbc")
        put("cipher-pass", d["cipher_pass"])
    return "[global]\n" + "\n".join(lines) + "\n"


def repo_add(spec):
    d = spec.get("repo_def") or {}
    n = int(spec.get("index") or 0)
    if not 2 <= n <= 256:
        fail("the new repository needs a number from 2 to 256")
    cp = read_conf(conf_path())
    st = pick_stanza(spec, cp)
    taken = {int(m.group(1)) for sec in cp.sections() for k in cp.options(sec) for m in [re.match(r"repo(\d+)-", k)] if m}
    path = repo_file(n)
    if n in taken and not os.path.exists(path):
        fail(f"repo{n} is already in this node's pgBackRest config")
    here_repo_server = bool(pg_of(cp, st).get("host"))
    # a database node reaches the repository server the way it does for repo1 (same name / address)
    server = conf_get(cp, st, "repo1-host") or (spec.get("repo_server") or "").strip()
    remote = server if (server and not here_repo_server and d.get("type", "posix") in ("posix", "cifs")) else ""
    text = repo_text(d, n, cp, st, remote)
    if d.get("type", "posix") in ("posix", "cifs") and not remote:
        # the directory, owned by the user pgBackRest runs as (on a repository server, or a disk all nodes share)
        rp = d["path"]
        if not os.path.isdir(rp):
            os.makedirs(rp, mode=0o750, exist_ok=True)
            sh(["chown", "postgres:postgres", rp])
            OUT["created_dir"] = rp
        if not here_repo_server and not server:
            OUT["warnings"].append(f"{rp} must be the same storage on every database node (NFS or similar): "
                                   "after a failover the new primary writes there too")
    if path:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        body = f"# autoNOMIC: repository {n} ({d.get('type', 'posix')}), added from the Backup & Restore page\n" + text
    else:
        path = conf_path()  # pgBackRest reads only this file here: a marked block in its [global] section
        body = put_block(open(path, errors="ignore").read() if os.path.exists(path) else "", n, text)
    write_kept(path, body, spec)
    OUT["path"] = path
    OUT["repo"] = n
    OUT["remote"] = remote
    OUT["config"] = mask(text)


def write_kept(path, body, spec):
    """write a config file; the old one is kept as <file>.pgm-<run> (or remembered as new) for undo"""
    if os.path.exists(path):
        saved = f"{path}.pgm-{spec.get('run_id', 0)}"
        if not os.path.exists(saved):
            shutil.copy2(path, saved)
        st = os.stat(path)
        mode, owner = st.st_mode & 0o777, (st.st_uid, st.st_gid)
    else:
        open(new_marker(path, spec), "w").close()
        mode, owner = 0o640, None
    with open(path + ".pgm-new", "w") as f:
        f.write(body)
    os.chmod(path + ".pgm-new", mode)
    if owner:
        try:
            os.chown(path + ".pgm-new", *owner)
        except PermissionError:
            pass
    else:
        sh(["chown", "postgres:postgres", path + ".pgm-new"])
    os.replace(path + ".pgm-new", path)


def repo_remove(spec):
    """remove a repository added here (its file or block); with undo=true put back what this run changed"""
    n = int(spec.get("index") or 0)
    path = repo_file(n) or conf_path()
    if spec.get("undo"):
        undo_file(path, spec)
        return
    if not repo_file(n):
        text = open(path, errors="ignore").read()
        if block_marks(n)[0] not in text:
            fail(f"repo{n} was not added from this page: remove its lines in Configuration")
        write_kept(path, drop_block(text, n), spec)
        OUT["removed"] = f"repo{n} from {path}"
        return
    if not os.path.exists(path):
        cp = read_conf(conf_path())
        if any(re.match(rf"repo{n}-", k) for sec in cp.sections() for k in cp.options(sec)):
            fail(f"repo{n} was not added from this page: remove its lines in Configuration")
        OUT["warnings"].append(f"repo{n} is not configured on this node")
        return
    shutil.copy2(path, f"{path}.pgm-{spec.get('run_id', 0)}")
    os.remove(path)
    OUT["removed"] = path


CRON_FIELD = re.compile(r"^(\*|\d{1,2}(-\d{1,2})?(,\d{1,2}(-\d{1,2})?)*)(/\d{1,2})?$")


def cron_ok(field, lo, hi):
    if not CRON_FIELD.match(field):
        return False
    nums = [int(n) for n in re.findall(r"\d+", field.split("/")[0])]
    step = field.split("/")[1] if "/" in field else None
    return all(lo <= n <= hi for n in nums) and (step is None or 1 <= int(step) <= hi)


def schedule(spec):
    entries = spec.get("entries") or []
    if spec.get("remove") or not entries:
        if os.path.exists(CRON_FILE):
            os.remove(CRON_FILE)
        OUT["cron"] = []
        OUT["removed"] = True
        return
    cp = read_conf(conf_path())
    st = need_stanza(pick_stanza(spec, cp))
    pg = pg_of(cp, st)
    exe = which("pgbackrest") or "pgbackrest"
    psql_exe = (os.path.join(pg["bin"], "psql") if pg.get("bin") else "") or pg_tool("psql") or "psql"
    sock = f"-h {pg['socket']} " if pg.get("socket") else ""
    # on a database node, only the primary backs up (after a failover the new primary takes over)
    guard = "" if pg.get("host") else f"[ \"$({psql_exe} -XAt {sock}-p {pg['port']} -d postgres -c 'select pg_is_in_recovery()' 2>/dev/null)\" = \"f\" ] && "
    lines = ["# autoNOMIC: pgBackRest schedule (managed from the Backup & Restore page - changes here are overwritten)",
             "SHELL=/bin/sh", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"]
    for e in entries:
        t = e.get("type")
        if t not in ("full", "diff", "incr"):
            fail(f"unknown backup type {t}")
        f = [str(e.get(k, "*")).strip() or "*" for k in ("minute", "hour", "dom", "month", "dow")]
        if not all(cron_ok(x, lo, hi) for x, (lo, hi) in zip(f, ((0, 59), (0, 23), (1, 31), (1, 12), (0, 7)))):
            fail(f"not a valid cron time: {' '.join(f)} (minute 0-59, hour 0-23, day 1-31, month 1-12, weekday 0-7)")
        rp = str(e.get("repo") or "").replace("repo", "")
        if rp and not (rp.isdigit() and 1 <= int(rp) <= 256):
            fail(f"not a repository number: {e.get('repo')}")
        opts = br_found()["opts"]
        lines.append(f"{' '.join(f)} postgres {guard}{exe} {opts + ' ' if opts else ''}--stanza={st}{' --repo=' + rp if rp else ''} "
                     f"--type={t} backup >> /var/log/pgbackrest/pg_mantra-cron.log 2>&1")
    with open(CRON_FILE + ".tmp", "w") as fh:
        fh.write("\n".join(lines) + "\n")
    os.chmod(CRON_FILE + ".tmp", 0o644)
    os.replace(CRON_FILE + ".tmp", CRON_FILE)
    os.makedirs("/var/log/pgbackrest", exist_ok=True)
    sh(["chown", "postgres", "/var/log/pgbackrest"])
    OUT["cron"] = lines[3:]


def stop(spec):
    cp = read_conf(conf_path())
    pg = pg_of(cp, pick_stanza(spec, cp))
    pat = patroni_state()
    # remember how this server runs, for restore / start (it cannot be asked once it is down)
    now = pg_state(pg)
    cfg = (now.get("files") or {}).get("config_file") or ""
    br_ = br_found()
    keep = {"data_dir": pg.get("data_dir", ""), "port": pg.get("port"), "socket": pg.get("socket", ""), "bin": pg.get("bin", ""),
            "config_dir": os.path.dirname(cfg) if cfg else "", "config_files": now.get("files") or {},
            "br": {k: br_[k] for k in ("config", "config-path", "config-include-path", "source")}}
    what = {}
    if pat and (pat.get("running") or os.path.exists(pat["config"])):
        unit = patroni_unit()
        rc, o, e = sh(["systemctl", "stop", unit], timeout=900)
        if rc != 0:
            fail(f"could not stop Patroni ({unit}): {(e or o).strip()}")
        what = {"patroni": unit, "scope": pat.get("scope"), "config": pat.get("config")}
        # Patroni stops PostgreSQL; make sure it is down
        t0 = time.time()
        while pg_state(pg).get("running") and time.time() - t0 < 300:
            time.sleep(2)
        if pg_state(pg).get("running"):
            pg_ctl(pg, "stop")
    else:
        units = pg_units()
        inst = next((i for i in pg_instances() if i["data_dir"] and pg.get("data_dir") and
                     os.path.realpath(i["data_dir"]) == os.path.realpath(pg["data_dir"])), None)
        if inst and units:
            # only the service that runs this server (a node may run several)
            mine = [u for u in units if sh(["systemctl", "show", "-p", "MainPID", "--value", u])[1].strip() == str(inst["pid"])]
            units = mine
        if units:
            for u in units:
                rc, o, e = sh(["systemctl", "stop", u], timeout=900)
                if rc != 0:
                    fail(f"could not stop {u}: {(e or o).strip()}")
            what = {"units": units}
        else:
            pg_ctl(pg, "stop")
            what = {"pg_ctl": True}
    save_state(spec, {**keep, **what})
    OUT["stopped"] = what


def lsn(v):
    hi, _, lo = (v or "0/0").partition("/")
    return (int(hi, 16) << 32) | int(lo or "0", 16)


def timelines(st, info):
    """the newest timeline in the repository and where each of its ancestors ended: (tl, {ancestor_tl: switch lsn})"""
    try:
        arch_id = info["archive"][-1]["id"]
    except (KeyError, IndexError, TypeError):
        return 1, {}
    rc, o, _ = as_postgres(br(f"--stanza={q(st)} repo-ls archive/{q(st)}/{q(arch_id)}"), timeout=120)
    tls = [int(m.group(1), 16) for m in re.finditer(r"^([0-9A-F]{8})\.history$", o, re.M)] if rc == 0 else []
    if not tls:
        return 1, {}
    tl = max(tls)
    rc, o, _ = as_postgres(br(f"--stanza={q(st)} repo-get archive/{q(st)}/{q(arch_id)}/{tl:08X}.history"), timeout=120)
    hist = {}
    for line in o.splitlines() if rc == 0 else []:
        f = line.split()
        if len(f) >= 2 and f[0].isdigit():
            hist[int(f[0])] = lsn(f[1])
    return tl, hist


def usable_sets(st, info, before_epoch=None, repo=None):
    """backup sets that can reach the newest timeline (newest first); a set from an old timeline counts only if it
    ended before that timeline was left - after a point-in-time restore, later backups of the old timeline cannot"""
    tl, hist = timelines(st, info)
    out = []
    for b in reversed(info.get("backup") or []):
        try:
            btl = int(b["archive"]["stop"][:8], 16)
            end = lsn(b["lsn"]["stop"])
        except (KeyError, ValueError, TypeError):
            continue
        ok = btl == tl or (btl in hist and end <= hist[btl])
        if repo and str((b.get("database") or {}).get("repo-key", "")) != str(repo):
            continue
        if ok and (before_epoch is None or b["timestamp"]["stop"] <= before_epoch):
            out.append(b["label"])
    return out, tl


def stanza_info(st):
    rc, o, _ = as_postgres(br(f"--stanza={q(st)} --output=json info"), timeout=120)
    try:
        return json.loads(o)[0] if rc == 0 else {}
    except (ValueError, IndexError):
        return {}


def epoch_of(t):
    import datetime
    s = str(t).strip().replace("T", " ")
    s = re.sub(r"([+-]\d\d)$", r"\1:00", s)
    try:
        d = datetime.datetime.fromisoformat(s)
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.astimezone()
    return int(d.timestamp())


NODE_FILES = ("postgresql.conf", "pg_hba.conf", "pg_ident.conf", "postgresql.base.conf")


def conf_file_value(path, key, bare=False):
    """a setting from a postgresql.conf-style file (the last one wins); bare: unquoted values too (port = 5433)"""
    try:
        lines = open(path, errors="ignore").readlines()
    except OSError:
        return ""
    val = ""
    for line in lines:
        m = re.match(rf"^\s*{key}\s*=\s*'((?:[^']|'')*)'", line)
        if m:
            val = m.group(1).replace("''", "'")
        elif bare:
            m = re.match(rf"^\s*{key}\s*=\s*([^\s#']+)", line)
            if m:
                val = m.group(1)
    return val


def auto_conf_value(data_dir, key):
    """a setting from postgresql.auto.conf (e.g. primary_conninfo), or ''"""
    f = os.path.join(data_dir, "postgresql.auto.conf")
    if not os.path.exists(f):
        return ""
    val = ""
    for line in open(f, errors="ignore"):
        m = re.match(rf"^\s*{key}\s*=\s*'((?:[^']|'')*)'", line)
        if m:
            val = m.group(1).replace("''", "'")
    return val


def restore(spec):
    cp = read_conf(conf_path())
    st = need_stanza(pick_stanza(spec, cp))
    pg = pg_of(cp, st)
    if pg_state(pg).get("running"):
        fail("PostgreSQL is still running on this node: stop it first")
    kind = spec.get("type", "latest")
    data = pg.get("data_dir") or ""
    args = [f"--stanza={q(st)}", "--delta"]
    repo = repo_opt(spec).strip()
    if data:
        args.append(f"--pg1-path={q(data)}")
    chosen = spec.get("set") or ""
    if not chosen and kind in ("latest", "time"):
        # pgBackRest takes the newest set (before the target); make sure it can reach the newest timeline
        info = stanza_info(st)
        rk = repo.replace("--repo=", "") if repo else None
        sets, tl = usable_sets(st, info, epoch_of(spec.get("target_time")) if kind == "time" else None, rk)
        newest = [b["label"] for b in reversed(info.get("backup") or []) if not rk or str((b.get("database") or {}).get("repo-key")) == rk]
        if not sets:
            fail("no backup can be used for this restore (none on the current timeline" +
                 (" before that time)" if kind == "time" else ")"))
        if newest and sets[0] != newest[0]:
            OUT["warnings"].append(f"backup {newest[0]} is on an older timeline (taken after a previous restore point); using {sets[0]}")
        chosen = sets[0]
        OUT["timeline"] = tl
    if chosen:
        args.append(f"--set={q(chosen)}")
        # a set lives in one repository: restore it from there
        if not repo:
            info = stanza_info(st)
            rk = next(((b.get("database") or {}).get("repo-key") for b in info.get("backup") or [] if b.get("label") == chosen), None)
            repo = f"--repo={rk}" if rk else ""
    if repo:
        args.append(repo)
    if kind == "time":
        if not spec.get("target_time"):
            fail("give the time to restore to")
        args += ["--type=time", f"--target={q(spec['target_time'])}", "--target-action=promote"]
    elif kind == "immediate":
        args += ["--type=immediate", "--target-action=promote"]
    elif kind == "standby":
        args += ["--type=standby"]
        # a replica keeps how it reaches the primary (Patroni sets it again anyway)
        for key in ("primary_conninfo", "primary_slot_name"):
            v = auto_conf_value(data, key) if data else ""
            if v:
                args.append(f"--recovery-option={q(key + '=' + v)}")
    # latest: --type=default (replay every archived WAL, then promote)
    # this node's own config files (listen address, access rules ...) are kept, not taken from the backup
    keep = {}
    names = list(NODE_FILES)
    for v in (load_state(spec).get("config_files") or {}).values():
        # the server's own config / hba / ident files, whatever their names, when they live in the data directory
        if isinstance(v, str) and v.startswith("/") and data and os.path.dirname(v) == data.rstrip("/"):
            names.append(os.path.basename(v))
    if data:
        for f in dict.fromkeys(names):
            p = os.path.join(data, f)
            if os.path.isfile(p):
                keep[f] = (open(p, "rb").read(), os.stat(p))
    rc, o, e = pgbackrest(" ".join(args) + " restore", timeout=86400)
    if rc != 0:
        fail(f"restore failed: {(e or o).strip()[-1500:]}")
    for f, (body, stt) in keep.items():
        p = os.path.join(data, f)
        with open(p, "wb") as fh:
            fh.write(body)
        os.chmod(p, stt.st_mode & 0o777)
        try:
            os.chown(p, stt.st_uid, stt.st_gid)
        except PermissionError:
            pass
    m = re.search(r"restore backup set (\S+)", o + e)
    OUT["set"] = m.group(1).rstrip(",") if m else spec.get("set", "")
    OUT["kept_files"] = sorted(keep)
    OUT["restored"] = {"type": kind, "target": spec.get("target_time") or spec.get("set") or "latest", "data_dir": data,
                       "set": OUT["set"]}


def promote(spec):
    """the restored primary: let PostgreSQL finish the recovery, then hand it back to Patroni / its service"""
    cp = read_conf(conf_path())
    pg = pg_of(cp, pick_stanza(spec, cp))
    stopped = load_state(spec)
    pg_ctl(pg, "start")
    s = wait_pg(pg, want_primary=True, timeout=int(spec.get("timeout", 7200)))
    OUT["recovered"] = {"lsn": s.get("lsn"), "at": s.get("now")}
    pg_ctl(pg, "stop")
    if stopped.get("patroni"):
        conf = stopped.get("config") or patroni_conf()
        scope = stopped.get("scope") or (patroni_state() or {}).get("scope")
        ctl = which("patronictl")
        if ctl and conf and scope:
            # the DCS still describes the old cluster (timeline, leader): clear it so this node starts it again
            rc, o, e = sh([ctl, "-c", conf, "remove", scope], input=f"{scope}\nYes I am aware\n", timeout=120)
            OUT["dcs"] = (o + e).strip()[-400:]
        rc, o, e = sh(["systemctl", "start", stopped["patroni"]], timeout=900)
        if rc != 0:
            fail(f"could not start Patroni: {(e or o).strip()}")
        OUT["patroni"] = wait_patroni(("leader", "master", "primary"), timeout=900)
    elif stopped.get("units"):
        for u in stopped["units"]:
            sh(["systemctl", "start", u], timeout=900)
        wait_pg(pg, want_primary=True, timeout=900)
    else:
        pg_ctl(pg, "start")
        wait_pg(pg, want_primary=True, timeout=900)


def start(spec):
    cp = read_conf(conf_path())
    pg = pg_of(cp, pick_stanza(spec, cp))
    stopped = load_state(spec)
    if stopped.get("patroni"):
        rc, o, e = sh(["systemctl", "start", stopped["patroni"]], timeout=900)
        if rc != 0:
            fail(f"could not start Patroni: {(e or o).strip()}")
        OUT["patroni"] = wait_patroni(timeout=int(spec.get("timeout", 3600)))
    elif stopped.get("units"):
        for u in stopped["units"]:
            sh(["systemctl", "start", u], timeout=900)
    else:
        pg_ctl(pg, "start")
    OUT["pg"] = wait_pg(pg, timeout=int(spec.get("timeout", 3600)))


def slots(spec):
    """the physical replication slots the replicas use (not in backups; Patroni recreates its own)"""
    cp = read_conf(conf_path())
    pg = pg_of(cp, pick_stanza(spec, cp))
    made = []
    for name in sorted({n for n in spec.get("slots") or [] if re.fullmatch(r"[a-z0-9_]{1,63}", n or "")}):
        ok, rows = psql(pg, f"select count(*) from pg_replication_slots where slot_name = '{name}'")
        if ok and rows and rows[0][0] == "0":
            ok, rows = psql(pg, f"select pg_create_physical_replication_slot('{name}', true)")
            if not ok:
                fail(f"could not create the replication slot {name}: {rows}")
            made.append(name)
    OUT["created_slots"] = made


def health(spec):
    cp = read_conf(conf_path())
    pg = pg_of(cp, pick_stanza(spec, cp))
    OUT["pg"] = wait_pg(pg, timeout=int(spec.get("timeout", 300)))
    OUT["patroni"] = patroni_state()


def main():
    if len(sys.argv) < 2:
        fail("usage: pgm_backup.py <action> [base64 json spec]")
    action = sys.argv[1]
    spec = json.loads(base64.b64decode(sys.argv[2]).decode()) if len(sys.argv) > 2 and sys.argv[2] else {}
    OUT["action"] = action
    OUT["host"] = os.uname().nodename
    try:
        fn = {"status": status, "backup": backup, "check": check, "stanza-create": lambda s: check(s, create=True),
              "config-apply": config_apply, "config-undo": config_undo, "schedule": schedule, "stop": stop,
              "restore": restore, "promote": promote, "start": start, "health": health, "slots": slots,
              "activity": activity, "repo-add": repo_add, "repo-remove": repo_remove}[action]
    except KeyError:
        fail(f"unknown action {action}")
    SPEC.update(spec)
    try:
        fn(spec)
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001 - report it as the result
        fail(f"{type(e).__name__}: {e}")
    done(0)


if __name__ == "__main__":
    main()
