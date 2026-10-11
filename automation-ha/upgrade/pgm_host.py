#!/usr/bin/env python3
"""
pgm_host.py - pg_mantra upgrades: what runs on one machine. Ansible copies it to each node and calls it with
an action and a base64 JSON spec; it prints one JSON object (the last line of its output).

Actions
  detect     installed packages / pip / binaries, versions available, services, Patroni role, free disk
  preserve   keep what is installed now: package files (.rpm / .deb), pip wheel, binaries, config files,
             and a manifest - under <base>/<run_id>/<component>/
  upgrade    install the new version (all packages of the component in one transaction)
  rollback   put back the versions of the manifest (saved files first, else the repository)
  restart    restart the component (PostgreSQL through Patroni)
  health     wait until the component is healthy again
  patroni    pause | resume | switchover (helpers for the playbook)

Nothing here runs without being asked: detect only reads (it may refresh the package metadata).
"""
import base64
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request

OUT = {"ok": True, "warnings": []}


def done(code=0):
    OUT["ok"] = code == 0
    print(json.dumps(OUT, default=str))
    sys.exit(code)


def fail(msg):
    OUT["error"] = msg
    try:
        remove_repo()
    except Exception:  # noqa: BLE001
        pass
    done(2)


def sh(cmd, check=False, timeout=900, env=None):
    e = dict(os.environ, LC_ALL="C", DEBIAN_FRONTEND="noninteractive")
    if env:
        e.update(env)
    p = subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True, text=True, timeout=timeout, env=e)
    if check and p.returncode != 0:
        fail(f"{cmd if isinstance(cmd, str) else ' '.join(cmd)} failed: {(p.stderr or p.stdout).strip()[-800:]}")
    return p.returncode, p.stdout, p.stderr


def which(*names):
    for n in names:
        p = shutil.which(n) or next((x for x in (f"/usr/local/bin/{n}", f"/usr/bin/{n}", f"/usr/sbin/{n}") if os.path.exists(x)), None)
        if p:
            return p
    return None


PM = "dnf" if which("dnf") else "yum" if which("yum") else "apt" if which("apt-get") else None
FAMILY = "rpm" if PM in ("dnf", "yum") else "deb" if PM == "apt" else None
REPO_ARGS = []  # dnf/yum: --disablerepo=* --enablerepo=pg_mantra-upgrade when "use only this repository"
REPO_FILE = "/etc/yum.repos.d/pg_mantra-upgrade.repo" if FAMILY == "rpm" else "/etc/apt/sources.list.d/pg_mantra-upgrade.list"


def pm(*args):
    """the package manager command, limited to the private repository when asked"""
    return [PM, *REPO_ARGS, *args]


def add_repo(spec):
    """your private repository, for this action only (removed again when it ends)"""
    r = spec.get("repo") or {}
    url = (r.get("url") or "").strip()
    if not url:
        return
    if FAMILY == "rpm":
        lines = ["[pg_mantra-upgrade]", "name=pg_mantra upgrade repository", f"baseurl={url}", "enabled=1",
                 f"gpgcheck={1 if r.get('gpgcheck') else 0}", "repo_gpgcheck=0", "module_hotfixes=1"]
        if r.get("gpgkey"):
            lines.append(f"gpgkey={r['gpgkey']}")
        with open(REPO_FILE, "w") as f:
            f.write("\n".join(lines) + "\n")
        if r.get("only"):
            REPO_ARGS[:] = ["--disablerepo=*", "--enablerepo=pg_mantra-upgrade"]
        sh(pm("-q", "makecache"), timeout=600)
    elif FAMILY == "deb":
        line = url if url.startswith("deb ") else f"deb [trusted=yes] {url} ./"
        with open(REPO_FILE, "w") as f:
            f.write(line + "\n")
        rc, _, e = sh(["apt-get", "update", "-q"], timeout=600)
        if rc != 0:
            OUT["warnings"].append("apt-get update: " + e.strip()[-200:])
        if r.get("only"):
            OUT["warnings"].append("'only this repository' works with dnf / yum; apt uses all its sources")
    OUT["repo"] = url


def remove_repo():
    if os.path.exists(REPO_FILE) and OUT.get("repo"):
        os.remove(REPO_FILE)


# ---------------------------------------------------------------- versions

def vercmp(a, b):
    """-1 / 0 / 1, the way the package manager compares"""
    if a == b:
        return 0
    if FAMILY == "deb":
        if sh(["dpkg", "--compare-versions", a, "gt", b])[0] == 0:
            return 1
        return -1
    try:
        import rpm  # python3-rpm, on every RHEL
        def evr(v):
            e, _, rest = v.rpartition(":")
            ver, _, rel = rest.partition("-")
            return (e or "0", ver, rel)
        return rpm.labelCompare(evr(a), evr(b))
    except ImportError:
        pa = [int(x) if x.isdigit() else x for x in re.split(r"[.\-:~+]", a)]
        pb = [int(x) if x.isdigit() else x for x in re.split(r"[.\-:~+]", b)]
        try:
            return (pa > pb) - (pa < pb)
        except TypeError:
            return (a > b) - (a < b)


def matches(v, target):
    """target '4.1' matches 4.1.x; '17.6' matches 17.6-1PGDG...; empty = any"""
    if not target:
        return True
    plain = v.split(":")[-1]
    return plain == target or plain.startswith(target + ".") or plain.startswith(target + "-") or plain.startswith(target + "~")


def installed_packages(names):
    out = []
    for n in names:
        if FAMILY == "rpm":
            rc, o, _ = sh(["rpm", "-q", "--qf", "%{NAME}\t%{EPOCHNUM}:%{VERSION}-%{RELEASE}\t%{ARCH}\n", n])
            if rc == 0:
                for line in o.splitlines():
                    name, ver, arch = line.split("\t")
                    out.append({"name": name, "installed": ver[2:] if ver.startswith("0:") else ver, "arch": arch})
        elif FAMILY == "deb":
            rc, o, _ = sh(["dpkg-query", "-W", "-f=${db:Status-Abbrev}\t${Package}\t${Version}\t${Architecture}\n", n])
            if rc == 0:
                for line in o.splitlines():
                    st, name, ver, arch = line.split("\t")
                    if st.startswith("ii"):
                        out.append({"name": name, "installed": ver, "arch": arch})
    return out


def available_versions(name):
    vs = []
    if FAMILY == "rpm":
        rc, o, _ = sh(pm("-q", "list", "--showduplicates", "--available", name), timeout=300)
        for line in o.splitlines():
            f = line.split()
            if len(f) >= 2 and f[0].split(".")[0] == name:
                vs.append(f[1][2:] if f[1].startswith("0:") else f[1])
    elif FAMILY == "deb":
        rc, o, _ = sh(["apt-cache", "madison", name])
        for line in o.splitlines():
            f = [x.strip() for x in line.split("|")]
            if len(f) >= 2 and f[0] == name:
                vs.append(f[1])
    uniq = []
    for v in vs:
        if v not in uniq:
            uniq.append(v)
    try:
        import functools
        uniq.sort(key=functools.cmp_to_key(vercmp), reverse=True)
    except Exception:
        pass
    return uniq


def expand_names(spec):
    names = spec.get(f"packages_{FAMILY}") or []
    if spec["component"] == "postgres":
        # the PostgreSQL major(s) installed: postgresql17-server / postgresql-17
        majors = set()
        if FAMILY == "rpm":
            _, o, _ = sh("rpm -qa --qf '%{NAME}\\n' 'postgresql*-server'")
            majors = {m.group(1) for m in re.finditer(r"postgresql(\d+)-server", o)}
        elif FAMILY == "deb":
            _, o, _ = sh("dpkg-query -W -f='${db:Status-Abbrev} ${Package}\\n' 'postgresql-[0-9]*'")
            majors = {m.group(1) for m in re.finditer(r"^ii\s+postgresql-(\d+)$", o, re.M)}
        names = [n.replace("{major}", m) for m in sorted(majors) for n in names]
        OUT["pg_majors"] = sorted(majors)
    return [n for n in names if "{" not in n]


# ---------------------------------------------------------------- pip and binaries

def pip_python(binary):
    """the python that runs a pip-installed program (from its #! line)"""
    p = which(binary)
    if not p:
        return None
    try:
        with open(p) as f:
            first = f.readline()
        if first.startswith("#!") and "python" in first:
            return first[2:].strip().split()[0]
    except (OSError, UnicodeDecodeError):
        pass
    return None


def pip_info(spec):
    pip = spec.get("pip")
    if not pip:
        return None
    py = pip_python(pip.get("binary", pip["name"]))
    if not py:
        return None
    rc, o, _ = sh([py, "-m", "pip", "show", pip["name"]])
    if rc != 0:
        return None
    ver = re.search(r"^Version:\s*(\S+)", o, re.M)
    info = {"name": pip["name"], "python": py, "installed": ver.group(1) if ver else ""}
    rc, o, _ = sh([py, "-m", "pip", "index", "versions", pip["name"]], timeout=120)
    m = re.search(r"Available versions:\s*(.+)", o)
    info["versions"] = [v.strip() for v in m.group(1).split(",")][:15] if m else []
    if rc != 0:
        OUT["warnings"].append("pip could not list the available versions (no access to the package index?)")
    return info


def binary_info(spec):
    b = spec.get("binary")
    if not b:
        return None
    files = []
    for path in b.get("paths", []):
        if os.path.isfile(path):
            owned = FAMILY == "rpm" and sh(["rpm", "-qf", path])[0] == 0 or FAMILY == "deb" and sh(["dpkg", "-S", path])[0] == 0
            if owned:
                continue  # comes from a package: handled as a package
            _, o, e = sh([path, "--version"])
            m = re.search(r"\d+\.\d+\.\d+", o + e)
            files.append({"path": path, "version": m.group(0) if m else ""})
    if not files:
        return None
    return {"files": files, "installed": files[0]["version"], "url": b.get("url", "")}


# ---------------------------------------------------------------- Patroni

def patroni_conf():
    # the config the running Patroni was started with, else the usual places
    _, o, _ = sh("ps -eo args")
    for line in o.splitlines():
        f = line.split()
        if f and "patroni" in line and not "patronictl" in line and f[-1].endswith((".yml", ".yaml")) and os.path.exists(f[-1]):
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
            "api": api.group(1) if api else "127.0.0.1:8008"}
    for addr in (info["api"], "127.0.0.1:8008"):
        try:
            with urllib.request.urlopen(f"http://{addr}/patroni", timeout=5) as r:
                j = json.loads(r.read().decode())
                info.update(role=j.get("role", ""), state=j.get("state", ""), version=j.get("patroni", {}).get("version", ""),
                            pending_restart=j.get("pending_restart", False))
                info["api"] = addr
                break
        except Exception as e:  # noqa: BLE001 - try the next address
            info["api_error"] = str(e)
    return info


def patronictl(*args):
    p = which("patronictl")
    conf = patroni_conf()
    if not p or not conf:
        fail("patronictl or the Patroni config was not found on this node")
    return sh([p, "-c", conf, *args], timeout=600)


def wait_patroni(want_role=None, timeout=300):
    t0 = time.time()
    while time.time() - t0 < timeout:
        st = patroni_state() or {}
        if st.get("state") == "running" and (not want_role or st.get("role") in want_role):
            return st
        time.sleep(3)
    fail(f"Patroni did not report a running {want_role or 'member'} within {timeout}s (last: {patroni_state()})")


# ---------------------------------------------------------------- PostgreSQL without Patroni

def pg_tool(name):
    for p in sorted(glob.glob(f"/usr/pgsql-*/bin/{name}") + glob.glob(f"/usr/lib/postgresql/*/bin/{name}"), reverse=True):
        return p
    return which(name)


def pg_local_role(port):
    psql = pg_tool("psql")
    if not psql:
        return ""
    rc, o, _ = sh(["su", "-", "postgres", "-s", "/bin/sh", "-c", f"{psql} -XAt -p {port} -c 'select pg_is_in_recovery()'"])
    return {"t": "replica", "f": "primary"}.get(o.strip(), "") if rc == 0 else ""


def pg_units():
    _, o, _ = sh(["systemctl", "list-units", "--type=service", "--state=active", "--plain", "--no-legend", "postgresql*"])
    return [line.split()[0] for line in o.splitlines() if line.strip()]


# ---------------------------------------------------------------- services

def services(spec):
    out = []
    for s in spec.get("services", []):
        rc, o, _ = sh(["systemctl", "show", "-p", "LoadState,ActiveState,UnitFileState", s])
        kv = dict(line.split("=", 1) for line in o.splitlines() if "=" in line)
        if kv.get("LoadState") == "loaded":
            out.append({"name": s, "active": kv.get("ActiveState") == "active", "enabled": kv.get("UnitFileState", "")})
    return out


def port_open(port, host="127.0.0.1"):
    import socket
    for h in (host, "127.0.0.1"):
        try:
            socket.create_connection((h, port), timeout=3).close()
            return True
        except OSError:
            pass
    rc, o, _ = sh(["ss", "-Hltn", f"sport = :{port}"])
    return rc == 0 and bool(o.strip())


# ---------------------------------------------------------------- actions

def detect(spec):
    if spec.get("refresh") and FAMILY == "deb":
        rc, _, e = sh(["apt-get", "update", "-q"], timeout=600)
        if rc != 0:
            OUT["warnings"].append("apt-get update failed: " + e.strip()[-200:])
    OUT["family"], OUT["pm"] = FAMILY, PM
    target = spec.get("target", "")
    pkgs = installed_packages(expand_names(spec))
    for p in pkgs:
        vs = available_versions(p["name"])
        p["versions"] = vs[:15]
        newer = [v for v in vs if vercmp(v, p["installed"]) > 0 and matches(v, target)]
        p["candidate"] = newer[0] if newer else ""
        if target and not newer and not matches(p["installed"], target):
            OUT["warnings"].append(f"{p['name']}: no version {target} in the configured repositories")
    OUT["packages"] = pkgs
    pi = pip_info(spec)
    if pi:
        newer = [v for v in pi["versions"] if vercmp(v, pi["installed"]) > 0 and matches(v, target)]
        pi["candidate"] = (target if target and vercmp(target, pi["installed"]) > 0 else "") or (newer[0] if newer else "")
        OUT["pip"] = pi
    bi = binary_info(spec)
    if bi:
        bi["candidate"] = target if target and vercmp(target, bi["installed"]) > 0 else ""
        if not target:
            OUT["warnings"].append("installed as plain binaries: give the target version to upgrade")
        OUT["binary"] = bi
    OUT["method"] = "package" if pkgs else "pip" if pi else "binary" if bi else "none"
    OUT["services"] = services(spec)
    if spec["component"] in ("postgres", "patroni"):
        OUT["patroni"] = patroni_state()
    if spec["component"] == "postgres" and not (OUT.get("patroni") or {}).get("role"):
        OUT["pg_role"] = pg_local_role((spec.get("ports") or [5432])[0])
        OUT["pg_units"] = pg_units()
    base = spec.get("base", "/var/lib/pg_mantra/upgrade")
    probe = base
    while not os.path.exists(probe):
        probe = os.path.dirname(probe) or "/"
    st = os.statvfs(probe)
    OUT["free_bytes"] = st.f_bavail * st.f_frsize
    OUT["to_upgrade"] = [p["name"] for p in pkgs if p["candidate"]] + ([pi["name"]] if pi and pi["candidate"] else []) + \
        (["binaries"] if bi and bi["candidate"] else [])
    if OUT["method"] == "none":
        OUT["warnings"].append(f"{spec['component']} is not installed here")
    return OUT


def run_dir(spec):
    return os.path.join(spec.get("base", "/var/lib/pg_mantra/upgrade"), str(spec["run_id"]), spec["component"])


def preserve(spec):
    info = detect(dict(spec, refresh=False))
    d = run_dir(spec)
    if os.path.isdir(d):
        shutil.rmtree(d)  # a leftover with the same run id (never mix two runs' files)
    os.makedirs(d, exist_ok=True)
    os.chmod(os.path.dirname(d), 0o700)
    saved, unsaved = [], []
    for p in info["packages"]:
        if not p["candidate"]:
            continue
        name, ver = p["name"], p["installed"]
        before = set(os.listdir(d))
        if FAMILY == "rpm":
            nv = f"{name}-{ver.split(':')[-1]}"
            rc, _, e = sh(pm("-q", "download", "--destdir", d, f"{nv}.{p['arch']}"), timeout=600)
            if rc != 0:
                for f in glob.glob(f"/var/cache/{PM}/**/{nv}.{p['arch']}.rpm", recursive=True):
                    shutil.copy2(f, d)
        else:
            rc, _, e = sh(f"cd {d} && apt-get download {name}={ver}", timeout=600)
            if rc != 0:
                ev = ver.replace(":", "%3a")
                for f in glob.glob(f"/var/cache/apt/archives/{name}_{ev}_*.deb"):
                    shutil.copy2(f, d)
            if not (set(os.listdir(d)) - before) and which("dpkg-repack"):
                sh(f"cd {d} && dpkg-repack {name}", timeout=600)
        pattern = f"{name}-{ver.split(':')[-1]}.{p['arch']}.rpm" if FAMILY == "rpm" else f"{name}_*.deb"
        new = sorted(set(os.path.basename(f) for f in glob.glob(os.path.join(d, pattern))) - before)
        (saved if new else unsaved).append({"name": name, "version": ver, "files": new})
    pi = info.get("pip")
    if pi and pi["candidate"]:
        rc, _, e = sh([pi["python"], "-m", "pip", "download", "--no-deps", "-d", os.path.join(d, "pip"), f"{pi['name']}=={pi['installed']}"], timeout=600)
        (saved if rc == 0 else unsaved).append({"name": pi["name"], "version": pi["installed"], "files": ["pip/"] if rc == 0 else []})
    bi = info.get("binary")
    if bi and bi["candidate"]:
        os.makedirs(os.path.join(d, "bin"), exist_ok=True)
        for f in bi["files"]:
            shutil.copy2(f["path"], os.path.join(d, "bin", os.path.basename(f["path"])))
        saved.append({"name": "binaries", "version": bi["installed"], "files": [f["path"] for f in bi["files"]]})
    cfgs = [c for c in spec.get("configs", []) if os.path.exists(c)]
    if cfgs:
        with tarfile.open(os.path.join(d, "config.tgz"), "w:gz") as t:
            for c in cfgs:
                t.add(c)
    manifest = {"component": spec["component"], "run_id": spec["run_id"], "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "family": FAMILY, "packages": info["packages"], "pip": pi, "binary": bi, "saved": saved, "unsaved": unsaved,
                "configs": cfgs}
    with open(os.path.join(d, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    OUT.update(dir=d, saved=saved, unsaved=unsaved, configs=cfgs)
    if unsaved and not spec.get("allow_unsaved"):
        fail("the installed version of " + ", ".join(u["name"] for u in unsaved) + " could not be saved (not in the repository "
             "or package cache), so a rollback could not put it back. Nothing was changed. Allow 'upgrade without a saved copy' to go on.")
    return OUT


def versions_now(spec):
    out = {p["name"]: p["installed"] for p in installed_packages(expand_names(spec))}
    pi = pip_info(dict(spec))
    if pi:
        out[pi["name"]] = pi["installed"]
    bi = binary_info(spec)
    if bi:
        out["binaries"] = bi["installed"]
    return out


def upgrade(spec):
    info = detect(dict(spec, refresh=False))
    OUT["before"] = versions_now(spec)
    todo = [p for p in info["packages"] if p["candidate"]]
    if todo:
        if FAMILY == "rpm":
            sh(pm("-y", "install", *[f"{p['name']}-{p['candidate'].split(':')[-1]}" for p in todo]), check=True, timeout=1800)
        else:
            sh(["apt-get", "install", "-y", "--only-upgrade", "-o", "Dpkg::Options::=--force-confold", "-o", "Dpkg::Options::=--force-confdef"]
               + [f"{p['name']}={p['candidate']}" for p in todo], check=True, timeout=1800)
    pi = info.get("pip")
    if pi and pi["candidate"]:
        sh([pi["python"], "-m", "pip", "install", "--upgrade", f"{pi['name']}=={pi['candidate']}"], check=True, timeout=1800)
    bi = info.get("binary")
    if bi and bi["candidate"]:
        url = (spec.get("binary") or {}).get("url", "").replace("{version}", bi["candidate"])
        if not url:
            fail("no download address for the binaries")
        tmp = os.path.join(run_dir(spec), "download")
        os.makedirs(tmp, exist_ok=True)
        tgz = os.path.join(tmp, os.path.basename(url))
        urllib.request.urlretrieve(url, tgz)
        with tarfile.open(tgz) as t:
            t.extractall(tmp)
        for f in bi["files"]:
            found = glob.glob(os.path.join(tmp, "**", os.path.basename(f["path"])), recursive=True)
            if not found:
                fail(f"{os.path.basename(f['path'])} is not in {url}")
            shutil.copy2(found[0], f["path"] + ".pgm-new")
            os.replace(f["path"] + ".pgm-new", f["path"])
    if not (todo or (pi and pi["candidate"]) or (bi and bi["candidate"])):
        OUT["warnings"].append("already at the newest allowed version: nothing to install")
    OUT["after"] = versions_now(spec)
    return OUT


def rollback(spec):
    d = run_dir(spec)
    mf = os.path.join(d, "manifest.json")
    if not os.path.exists(mf):
        fail(f"no saved state for run {spec['run_id']} on this node ({mf}): it was not upgraded")
    m = json.load(open(mf))
    OUT["before"] = versions_now(spec)
    now = {p["name"]: p["installed"] for p in installed_packages([p["name"] for p in m["packages"]])}
    back = [p for p in m["packages"] if p.get("candidate") and now.get(p["name"]) != p["installed"]]
    if back:
        files = [os.path.join(d, f) for s in m["saved"] for f in s["files"] if f.endswith((".rpm", ".deb"))]
        if FAMILY == "rpm":
            args = files or [f"{p['name']}-{p['installed'].split(':')[-1]}" for p in back]
            sh(pm("-y", "downgrade", *args), check=True, timeout=1800)
        else:
            args = files or [f"{p['name']}={p['installed']}" for p in back]
            sh(["apt-get", "install", "-y", "--allow-downgrades", "-o", "Dpkg::Options::=--force-confold",
                "-o", "Dpkg::Options::=--force-confdef"] + args, check=True, timeout=1800)
    pi = m.get("pip")
    if pi and pi.get("candidate"):
        wheels = glob.glob(os.path.join(d, "pip", "*"))
        sh([pi["python"], "-m", "pip", "install", "--no-deps", "--force-reinstall"] + (wheels or [f"{pi['name']}=={pi['installed']}"]), check=True, timeout=1800)
    bi = m.get("binary")
    if bi and bi.get("candidate"):
        for f in bi["files"]:
            src = os.path.join(d, "bin", os.path.basename(f["path"]))
            shutil.copy2(src, f["path"] + ".pgm-old")
            os.replace(f["path"] + ".pgm-old", f["path"])
    if spec.get("restore_config") and os.path.exists(os.path.join(d, "config.tgz")):
        with tarfile.open(os.path.join(d, "config.tgz")) as t:
            t.extractall("/")
        OUT["config_restored"] = m.get("configs", [])
    OUT["after"] = versions_now(spec)
    OUT["dir"] = d
    return OUT


def restart(spec):
    comp = spec["component"]
    if comp == "postgres" and not (patroni_state() or {}).get("role"):
        units = pg_units()  # no Patroni: restart the PostgreSQL service itself
        if not units:
            fail("no running postgresql service found to restart")
        for u in units:
            sh(["systemctl", "restart", u], check=True, timeout=600)
        OUT["restarted"] = units
        return OUT
    if comp == "postgres":
        st = patroni_state() or {}
        rc, o, e = patronictl("restart", st.get("scope", ""), st.get("member", ""), "--force")
        if rc != 0:
            fail("patronictl restart failed: " + (e or o).strip()[-500:])
        OUT["restarted"] = ["postgresql (through Patroni)"]
        return OUT
    done_ = []
    for s in services(spec):
        if s["active"] or s["enabled"] == "enabled":
            sh(["systemctl", "daemon-reload"])
            sh(["systemctl", "restart", s["name"]], check=True, timeout=600)
            done_.append(s["name"])
    OUT["restarted"] = done_
    return OUT


def health(spec):
    comp, t0, timeout = spec["component"], time.time(), int(spec.get("health_timeout", 300))
    if comp == "postgres" and not (patroni_state() or {}).get("role"):
        ready = pg_tool("pg_isready")
        port = (spec.get("ports") or [5432])[0]
        while time.time() - t0 < timeout:
            if ready and sh([ready, "-q", "-h", "127.0.0.1", "-p", str(port)])[0] == 0 or not ready and port_open(port):
                OUT["healthy"] = True
                return OUT
            time.sleep(3)
        fail(f"PostgreSQL does not accept connections on port {port} after {timeout}s")
    if comp in ("postgres", "patroni"):
        OUT["patroni"] = wait_patroni(timeout=timeout)
        return OUT
    last = ""
    while time.time() - t0 < timeout:
        bad = [s["name"] for s in services(spec) if (s["enabled"] == "enabled") and not s["active"]]
        ports = [p for p in spec.get("ports", []) if not port_open(p)]
        if comp == "etcd" and not bad:
            etcdctl = which("etcdctl")
            rc, o, e = sh([etcdctl, "endpoint", "health"]) if etcdctl else (0, "", "")
            if rc != 0:
                bad.append("etcd endpoint health: " + (e or o).strip()[-200:])
        if not bad and not ports:
            OUT["healthy"] = True
            return OUT
        last = f"not active: {bad}, ports closed: {ports}"
        time.sleep(3)
    fail(f"{comp} is not healthy after {timeout}s ({last})")


def patroni_action(spec, what):
    if what == "pause":
        rc, o, e = patronictl("pause", "--wait")
        if rc != 0 and "already paused" not in (o + e).lower():
            fail("patronictl pause failed: " + (e or o).strip()[-400:])
    elif what == "resume":
        rc, o, e = patronictl("resume", "--wait")
        if rc != 0 and "not paused" not in (o + e).lower():
            fail("patronictl resume failed: " + (e or o).strip()[-400:])
    elif what == "switchover":
        st = patroni_state() or {}
        cand = spec.get("candidate", "")
        args = ["switchover", st.get("scope", ""), "--leader", st.get("member", ""), "--force"]
        if cand:
            args += ["--candidate", cand]
        rc, o, e = patronictl(*args)
        if rc != 0:
            fail("patronictl switchover failed: " + (e or o).strip()[-500:])
        OUT["patroni"] = wait_patroni(want_role=("replica", "standby", "sync_standby"), timeout=300)
    OUT["done"] = what
    return OUT


def main():
    if len(sys.argv) < 3:
        fail("usage: pgm_host.py ACTION BASE64_JSON_SPEC")
    action = sys.argv[1]
    try:
        spec = json.loads(base64.b64decode(sys.argv[2]).decode())
    except Exception as e:  # noqa: BLE001
        fail(f"bad spec: {e}")
    if FAMILY is None and action in ("detect", "preserve", "upgrade", "rollback"):
        fail("no dnf / yum / apt on this machine")
    OUT.update(action=action, component=spec.get("component"), host=os.uname().nodename)
    acts = {"detect": detect, "preserve": preserve, "upgrade": upgrade, "rollback": rollback, "restart": restart, "health": health}
    try:
        if action in ("detect", "preserve", "upgrade", "rollback"):
            add_repo(spec)
        if action in acts:
            acts[action](spec)
        elif action.startswith("patroni-"):
            patroni_action(spec, action.split("-", 1)[1])
        else:
            fail(f"unknown action {action}")
    except subprocess.TimeoutExpired as e:
        fail(f"timed out: {e}")
    except Exception as e:  # noqa: BLE001 - report, never a traceback the console cannot read
        remove_repo()
        fail(f"{type(e).__name__}: {e}")
    remove_repo()
    done(0)


if __name__ == "__main__":
    main()
