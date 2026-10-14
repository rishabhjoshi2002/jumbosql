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


# ---------------------------------------------------------------- pgBackRest config

def conf_path():
    for f in ("/etc/pgbackrest/pgbackrest.conf", "/etc/pgbackrest.conf"):
        if os.path.exists(f):
            return f
    return "/etc/pgbackrest/pgbackrest.conf"


def read_conf(path):
    cp = configparser.RawConfigParser(strict=False, interpolation=None)
    cp.optionxform = str
    try:
        cp.read_string(open(path, errors="ignore").read())
    except (OSError, configparser.Error) as e:
        OUT["warnings"].append(f"{path}: {e}")
    return cp


def stanzas(cp):
    return [s for s in cp.sections() if not s.startswith("global")]


def conf_get(cp, stanza, key, default=""):
    for sec in (stanza, "global"):
        if sec and cp.has_section(sec) and cp.has_option(sec, key):
            return cp.get(sec, key)
    return default


def pick_stanza(spec, cp):
    st = spec.get("stanza") or ""
    names = stanzas(cp)
    if st:
        return st
    if len(names) >= 1:
        return names[0]
    return ""


def pg_of(cp, stanza):
    """this node's PostgreSQL as pgBackRest sees it (pg1-*)"""
    return {"data_dir": conf_get(cp, stanza, "pg1-path"), "port": int(conf_get(cp, stanza, "pg1-port", "5432") or 5432),
            "socket": conf_get(cp, stanza, "pg1-socket-path"), "host": conf_get(cp, stanza, "pg1-host"),
            "user": conf_get(cp, stanza, "pg1-user", "postgres") or "postgres"}


def pg_tool(name):
    for p in sorted(glob.glob(f"/usr/pgsql-*/bin/{name}") + glob.glob(f"/usr/lib/postgresql/*/bin/{name}"), reverse=True):
        return p
    return which(name)


def psql(pg, sql, timeout=30):
    """one query on the local PostgreSQL through its socket; (ok, rows of fields)"""
    exe = pg_tool("psql")
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
                        "% pg_size_bytes(current_setting('wal_segment_size')) end, pg_size_bytes(current_setting('wal_segment_size')) "
                        "from pg_stat_archiver a")
    if not ok:
        return {"running": False, "error": rows if isinstance(rows, str) else ""}
    r = rows[0] + [""] * 20
    return {"running": True, "role": "replica" if r[0] == "t" else "primary", "archive_mode": r[1], "archive_command": r[2],
            "last_archived_wal": r[3], "last_archived_time": r[4], "last_failed_wal": r[5], "last_failed_time": r[6],
            "archived_count": int(r[7] or 0), "failed_count": int(r[8] or 0), "now": r[9], "version": r[10],
            "data_directory": r[11], "lsn": r[12], "primary_slot_name": r[13],
            "slots": [x for x in r[14].split(",") if x], "archive_timeout": r[15], "current_wal": r[16],
            "pending_wal_bytes": pending_wal(r[16], r[3], r[17], r[18])}


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
    _, o, _ = sh("ps -eo args")
    for line in o.splitlines():
        f = line.split()
        if f and "patroni" in line and "patronictl" not in line and f[-1].endswith((".yml", ".yaml")) and os.path.exists(f[-1]):
            return f[-1]
    for f in ("/etc/patroni/patroni.yml", "/etc/patroni.yml", "/etc/patroni/config.yml", *sorted(glob.glob("/etc/patroni/*.yml"))):
        if os.path.exists(f):
            return f
    return None


def patroni_state():
    conf = patroni_conf()
    if not conf:
        return None
    txt = open(conf, errors="ignore").read()
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
    exe = pg_tool("pg_ctl")
    if not exe or not pg.get("data_dir"):
        fail("pg_ctl or the data directory (pg1-path) was not found")
    log = f"/tmp/pg_mantra_pg_{pg['port']}.log"
    extra = f"-l {log} -t {timeout}" if what == "start" else "-m fast -t 600"
    rc, o, e = as_postgres(f"{exe} -D {q(pg['data_dir'])} -w {extra} {what}", timeout=timeout + 60)
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
    exe = which("pgbackrest")
    if not exe:
        fail("pgbackrest is not installed on this node")
    rc, o, e = as_postgres(f"{exe} {args}", timeout=timeout)
    OUT.setdefault("commands", []).append(f"pgbackrest {args}")
    OUT["output"] = (o + e).strip()[-3000:]
    return rc, o, e


def status(spec):
    path = conf_path()
    OUT["config_path"] = path
    OUT["config"] = open(path, errors="ignore").read() if os.path.exists(path) else ""
    exe = which("pgbackrest")
    OUT["installed"] = bool(exe)
    if exe:
        _, o, _ = sh([exe, "version"])
        OUT["version"] = o.strip().replace("pgBackRest ", "")
    cp = read_conf(path)
    st = pick_stanza(spec, cp)
    OUT["stanzas"] = stanzas(cp)
    OUT["stanza"] = st
    pg = pg_of(cp, st)
    OUT["pg_conf"] = pg
    OUT["repo_host"] = bool(pg.get("host"))  # this node backs up a remote PostgreSQL (a repository server)
    OUT["repos"] = [{"key": k.split("-")[0], "type": conf_get(cp, st, f"{k.split('-')[0]}-type", "posix"),
                     "path": conf_get(cp, st, k), "retention_full": conf_get(cp, st, f"{k.split('-')[0]}-retention-full"),
                     "retention_diff": conf_get(cp, st, f"{k.split('-')[0]}-retention-diff"),
                     "host": conf_get(cp, st, f"{k.split('-')[0]}-host"),
                     "bucket": conf_get(cp, st, f"{k.split('-')[0]}-s3-bucket") or conf_get(cp, st, f"{k.split('-')[0]}-gcs-bucket")
                     or conf_get(cp, st, f"{k.split('-')[0]}-azure-container")}
                    for k in sorted({k for s in ["global", st] if cp.has_section(s) for k in cp.options(s)
                                     if re.fullmatch(r"repo\d+-path", k)})]
    for r in OUT["repos"]:
        if r["type"] == "posix" and r["path"] and os.path.isdir(r["path"]):
            s = os.statvfs(r["path"])
            r["free_bytes"] = s.f_bavail * s.f_frsize
            r["total_bytes"] = s.f_blocks * s.f_frsize
    if exe:
        rc, o, e = as_postgres(f"{exe} --output=json info", timeout=120)
        try:
            OUT["info"] = json.loads(o) if rc == 0 else []
        except ValueError:
            OUT["info"] = []
        if rc != 0:
            OUT["info_error"] = (e or o).strip()[-800:]
    if exe and st and OUT.get("info"):
        cur = next((x for x in OUT["info"] if x.get("name") == st), None)
        if cur:
            OUT["usable_sets"], OUT["timeline"] = usable_sets(st, cur)
    OUT["pg"] = pg_state(pg) if not pg.get("host") else {"running": False, "remote": pg["host"]}
    # a stopped replica: which slot it streams from, read from its config (a restore recreates it)
    data = pg.get("data_dir") or ""
    if not pg.get("host") and data and not OUT["pg"].get("primary_slot_name"):
        for f in ("postgresql.auto.conf", "postgresql.conf"):
            v = conf_file_value(os.path.join(data, f), "primary_slot_name")
            if v:
                OUT["pg"]["primary_slot_name"] = v
                break
    OUT["patroni"] = patroni_state()
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
    seen, OUT["cron"] = set(), []
    for c in cron:
        if (c["file"], c["line"]) not in seen:
            seen.add((c["file"], c["line"]))
            OUT["cron"].append(c)


def backup(spec):
    cp = read_conf(conf_path())
    st = pick_stanza(spec, cp)
    t = spec.get("type", "incr")
    if t not in ("full", "diff", "incr"):
        fail(f"unknown backup type {t}")
    pg = pg_of(cp, st)
    if not pg.get("host"):
        s = pg_state(pg)
        if s.get("role") == "replica" and conf_get(cp, st, "backup-standby", "n") not in ("y", "yes"):
            fail("this node is a standby; backups run on the primary (or set backup-standby=y)")
    rc, o, e = pgbackrest(f"--stanza={q(st)} --type={t} backup")
    if rc != 0:
        fail(f"backup failed: {(e or o).strip()[-1200:]}")
    rc, o, _ = as_postgres(f"{which('pgbackrest')} --stanza={q(st)} --output=json info", timeout=120)
    try:
        b = json.loads(o)[0]["backup"][-1]
        OUT["backup"] = {"label": b["label"], "type": b["type"], "size": b.get("info", {}).get("size"),
                         "repo_size": b.get("info", {}).get("repository", {}).get("delta"),
                         "start": b["timestamp"]["start"], "stop": b["timestamp"]["stop"]}
    except (ValueError, KeyError, IndexError):
        pass


def check(spec, create=False):
    cp = read_conf(conf_path())
    st = pick_stanza(spec, cp)
    if not st:
        fail("no stanza in the pgBackRest config")
    if create:
        rc, o, e = pgbackrest(f"--stanza={q(st)} stanza-create", timeout=600)
        if rc != 0:
            fail(f"stanza-create failed: {(e or o).strip()[-1200:]}")
    rc, o, e = pgbackrest(f"--stanza={q(st)} check", timeout=600)
    if rc != 0:
        fail(f"check failed: {(e or o).strip()[-1200:]}")
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


def config_apply(spec):
    text = base64.b64decode(spec.get("content_b64", "")).decode()
    try:
        test = configparser.RawConfigParser(strict=False, interpolation=None)
        test.read_string(text)
    except configparser.Error as e:
        fail(f"the new config is not valid: {e}")
    if not stanzas(test):
        fail("the new config has no stanza section (e.g. [main])")
    path = conf_path()
    old = open(path, errors="ignore").read() if os.path.exists(path) else ""
    if spec.get("keep_local", True) and old:
        text, kept = merge_local(text, read_conf(path))
        OUT["kept_local"] = kept
    saved = f"{path}.pgm-{spec.get('run_id', 0)}"
    if old and not os.path.exists(saved):
        shutil.copy2(path, saved)
    OUT["saved"] = saved if old else ""
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


def config_undo(spec):
    path = conf_path()
    saved = f"{path}.pgm-{spec.get('run_id', 0)}"
    if not os.path.exists(saved):
        OUT["warnings"].append("no saved config for this run (nothing to put back)")
        return
    shutil.copy2(saved, path)
    OUT["restored"] = saved


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
    st = pick_stanza(spec, cp)
    pg = pg_of(cp, st)
    exe = which("pgbackrest") or "pgbackrest"
    psql_exe = pg_tool("psql") or "psql"
    sock = f"-h {pg['socket']} " if pg.get("socket") else ""
    # on a database node, only the primary backs up (after a failover the new primary takes over)
    guard = "" if pg.get("host") else f"[ \"$({psql_exe} -XAt {sock}-p {pg['port']} -d postgres -c 'select pg_is_in_recovery()' 2>/dev/null)\" = \"f\" ] && "
    lines = ["# pg_MANTRA: pgBackRest schedule (managed from the Backups page - changes here are overwritten)",
             "SHELL=/bin/sh", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"]
    for e in entries:
        t = e.get("type")
        if t not in ("full", "diff", "incr"):
            fail(f"unknown backup type {t}")
        f = [str(e.get(k, "*")).strip() or "*" for k in ("minute", "hour", "dom", "month", "dow")]
        if not all(cron_ok(x, lo, hi) for x, (lo, hi) in zip(f, ((0, 59), (0, 23), (1, 31), (1, 12), (0, 7)))):
            fail(f"not a valid cron time: {' '.join(f)} (minute 0-59, hour 0-23, day 1-31, month 1-12, weekday 0-7)")
        lines.append(f"{' '.join(f)} postgres {guard}{exe} --stanza={st} --type={t} backup >> /var/log/pgbackrest/pg_mantra-cron.log 2>&1")
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
        if units:
            for u in units:
                rc, o, e = sh(["systemctl", "stop", u], timeout=900)
                if rc != 0:
                    fail(f"could not stop {u}: {(e or o).strip()}")
            what = {"units": units}
        else:
            pg_ctl(pg, "stop")
            what = {"pg_ctl": True}
    save_state(spec, what)
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
    exe = which("pgbackrest")
    rc, o, _ = as_postgres(f"{exe} --stanza={q(st)} repo-ls archive/{q(st)}/{q(arch_id)}", timeout=120)
    tls = [int(m.group(1), 16) for m in re.finditer(r"^([0-9A-F]{8})\.history$", o, re.M)] if rc == 0 else []
    if not tls:
        return 1, {}
    tl = max(tls)
    rc, o, _ = as_postgres(f"{exe} --stanza={q(st)} repo-get archive/{q(st)}/{q(arch_id)}/{tl:08X}.history", timeout=120)
    hist = {}
    for line in o.splitlines() if rc == 0 else []:
        f = line.split()
        if len(f) >= 2 and f[0].isdigit():
            hist[int(f[0])] = lsn(f[1])
    return tl, hist


def usable_sets(st, info, before_epoch=None):
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
        if ok and (before_epoch is None or b["timestamp"]["stop"] <= before_epoch):
            out.append(b["label"])
    return out, tl


def stanza_info(st):
    rc, o, _ = as_postgres(f"{which('pgbackrest')} --stanza={q(st)} --output=json info", timeout=120)
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


def conf_file_value(path, key):
    if not os.path.exists(path):
        return ""
    val = ""
    for line in open(path, errors="ignore"):
        m = re.match(rf"^\s*{key}\s*=\s*'((?:[^']|'')*)'", line)
        if m:
            val = m.group(1).replace("''", "'")
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
    st = pick_stanza(spec, cp)
    pg = pg_of(cp, st)
    if pg_state(pg).get("running"):
        fail("PostgreSQL is still running on this node: stop it first")
    kind = spec.get("type", "latest")
    data = pg.get("data_dir") or ""
    args = [f"--stanza={q(st)}", "--delta"]
    if data:
        args.append(f"--pg1-path={q(data)}")
    chosen = spec.get("set") or ""
    if not chosen and kind in ("latest", "time"):
        # pgBackRest takes the newest set (before the target); make sure it can reach the newest timeline
        info = stanza_info(st)
        sets, tl = usable_sets(st, info, epoch_of(spec.get("target_time")) if kind == "time" else None)
        newest = [b["label"] for b in reversed(info.get("backup") or [])]
        if not sets:
            fail("no backup can be used for this restore (none on the current timeline" +
                 (" before that time)" if kind == "time" else ")"))
        if newest and sets[0] != newest[0]:
            OUT["warnings"].append(f"backup {newest[0]} is on an older timeline (taken after a previous restore point); using {sets[0]}")
        chosen = sets[0]
        OUT["timeline"] = tl
    if chosen:
        args.append(f"--set={q(chosen)}")
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
    if data:
        for f in NODE_FILES:
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
        {"status": status, "backup": backup, "check": check, "stanza-create": lambda s: check(s, create=True),
         "config-apply": config_apply, "config-undo": config_undo, "schedule": schedule, "stop": stop,
         "restore": restore, "promote": promote, "start": start, "health": health, "slots": slots}[action](spec)
    except KeyError:
        fail(f"unknown action {action}")
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001 - report it as the result
        fail(f"{type(e).__name__}: {e}")
    done(0)


if __name__ == "__main__":
    main()
