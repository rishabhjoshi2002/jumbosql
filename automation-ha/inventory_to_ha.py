#!/usr/bin/env python3
"""
inventory_to_ha.py - JumboSQL: write the console's HA inventory as YAML and pick the HA variables.

The JumboSQL console builds the inventory in the HA layout already (see
console/ui/src/shared/lib/haInventory.ts): etcd_cluster, patroni_cluster, haproxy_cluster,
pgbouncer_cluster, backrest_cluster and, optionally, prometheus/alertmanager/grafana_cluster.
It also adds `master` / `replica`, which only the console uses; they are dropped here.

The layout is checked again here, so a request sent straight to the API can't start a broken deployment.

Usage: inventory_to_ha.py INVENTORY_JSON EXTRA_VARS_JSON OUT_INVENTORY_YML OUT_EXTRA_VARS_JSON
"""
import glob
import json
import os
import re
import sys

HA_GROUPS = [
    "etcd_cluster", "patroni_cluster", "backrest_cluster", "haproxy_cluster", "pgbouncer_cluster",
    "prometheus_cluster", "alertmanager_cluster", "grafana_cluster", "pgmonitor_cluster",
]
CONSOLE_ONLY_HOSTVARS = {"hostname", "bind_address", "server_location", "postgresql_exists"}


def die(msg):
    print(f"[jumbosql] ERROR: {msg}", file=sys.stderr)
    sys.exit(2)


def hosts(children, group):
    return list(((children.get(group) or {}).get("hosts") or {}).keys())


def check_layout(children):
    problems = []
    etcd, patroni = hosts(children, "etcd_cluster"), hosts(children, "patroni_cluster")
    haproxy, pgb, backrest = (hosts(children, g) for g in ("haproxy_cluster", "pgbouncer_cluster", "backrest_cluster"))
    if len(etcd) < 3 or len(etcd) % 2 == 0:
        problems.append(f"etcd needs an odd number of members, at least 3 (got {len(etcd)})")
    if len(patroni) < 2:
        problems.append(f"PostgreSQL + Patroni needs at least 2 servers (got {len(patroni)})")
    if not haproxy:
        problems.append("HAProxy needs at least 1 server")
    if not pgb:
        problems.append("PgBouncer needs at least 1 server")
    if len(backrest) != 1:
        problems.append(f"pgBackRest repo must be exactly 1 server (got {len(backrest)})")
    mon = {g: hosts(children, g) for g in ("prometheus_cluster", "alertmanager_cluster", "grafana_cluster")}
    for g, h in mon.items():
        if len(h) > 1:
            problems.append(f"{g.split('_')[0]} can be on 1 server at most (got {len(h)})")
    if any(mon.values()) and not all(mon.values()):
        problems.append("Prometheus, Alertmanager and Grafana go together: give each one a VM, or none")
    clash = sorted(set(haproxy) & set(patroni))
    if clash:
        problems.append(f"HAProxy and PostgreSQL can't share a server (port 5432): {', '.join(clash)}")
    return problems


def supported_pg_versions(root="/ha/collections/ansible_collections"):
    """PostgreSQL major versions in the HA automation's package list (roles/pkgmgr), e.g. {13, 14, 15, 16, 17}.
    Read from the collection itself, so a newer automation bundle brings its own list. Empty set = unknown."""
    found = set()
    pat = re.compile(r"\b(?:PG|pg|postgresql)[_-]?(1[0-9])\b|\bpostgresql(1[0-9])-server\b")
    for f in glob.glob(os.path.join(root, "*", "*", "roles", "pkgmgr", "**", "*"), recursive=True):
        if not os.path.isfile(f) or os.path.getsize(f) > 5_000_000:
            continue
        try:
            with open(f, errors="ignore") as fh:
                for m in pat.finditer(fh.read()):
                    found.add(int(m.group(1) or m.group(2)))
        except OSError:
            pass
    return found


def check_pg_version(version):
    if version in (None, "") or os.environ.get("JUMBOSQL_SKIP_VERSION_CHECK") == "1":
        return
    try:
        major = int(str(version).split(".")[0])
    except ValueError:
        die(f"PostgreSQL version '{version}' is not a number")
    known = supported_pg_versions()
    if known and major not in known:
        die(f"PostgreSQL {major} is not in this HA automation's package list (it has: "
            f"{', '.join(str(v) for v in sorted(known))}). Choose one of those versions in the cluster form.")


NAME_VARS = ("etcd_name", "patroni_name", "node_jobname")
SHORT = {"etcd_cluster": "etcd", "patroni_cluster": "pg", "backrest_cluster": "util", "haproxy_cluster": "haproxy",
         "pgbouncer_cluster": "pgbouncer", "prometheus_cluster": "prometheus",
         "alertmanager_cluster": "alertmanager", "grafana_cluster": "grafana"}


def add_node_jobnames(children):
    """Every host needs a name variable: the HA preflight builds per-host names from etcd_name / patroni_name /
    node_jobname and crashes ("'NoneType' object has no attribute 'split'") on a host with none of them, which
    happens when HAProxy, PgBouncer or a monitoring tool has a VM of its own."""
    named = set()
    for g in HA_GROUPS:
        for host, hv in ((children.get(g) or {}).get("hosts") or {}).items():
            if any((hv or {}).get(k) for k in NAME_VARS):
                named.add(host)
    for g in HA_GROUPS:
        hosts_ = (children.get(g) or {}).get("hosts") or {}
        for host in list(hosts_):
            if host in named:
                continue
            hv = hosts_[host] = dict(hosts_[host] or {})
            hv["node_jobname"] = f"ip{str(host).split('.')[-1]}_{SHORT.get(g, 'node')}"
            named.add(host)


def yaml_scalar(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    return json.dumps(str(v))


def emit_group(lines, name, group, indent):
    pad = "  " * indent
    lines.append(f"{pad}{name}:")
    if group.get("hosts"):
        lines.append(f"{pad}  hosts:")
        for host, hv in group["hosts"].items():
            lines.append(f"{pad}    {host}:")
            for k, v in (hv or {}).items():
                if k not in CONSOLE_ONLY_HOSTVARS:
                    lines.append(f"{pad}      {k}: {yaml_scalar(v)}")
    if group.get("children"):
        lines.append(f"{pad}  children:")
        for child, g in group["children"].items():
            if g:
                emit_group(lines, child, g, indent + 2)
            else:
                lines.append(f"{pad}    {child}:")


def main():
    if len(sys.argv) != 5:
        die(__doc__)
    inv_path, ev_path, out_inv, out_ev = sys.argv[1:]
    with open(inv_path) as f:
        inv = json.load(f)
    try:
        with open(ev_path) as f:
            ev = json.load(f) or {}
    except (OSError, ValueError):
        ev = {}
    if ev.get("cloud_provider"):
        die("cloud deployments are not supported; use 'Your own machines' with the inventory step.")

    allg = inv.get("all") or {}
    children = allg.get("children") or {}
    if "patroni_cluster" not in children:
        die("the inventory has no HA groups - it was not created by the JumboSQL inventory step.")
    problems = check_layout(children)
    if problems:
        die("invalid HA layout:\n  - " + "\n  - ".join(problems))

    add_node_jobnames(children)

    lines = ["# Keen PostgreSQL HA inventory, generated by JumboSQL", "---", "all:", "  vars:"]
    for k, v in (allg.get("vars") or {}).items():
        lines.append(f"    {k}: {yaml_scalar(v)}")
    lines.append("  children:")
    for g in HA_GROUPS:
        if g in children:
            emit_group(lines, g, children[g], 2)
    with open(out_inv, "w") as f:
        f.write("\n".join(lines) + "\n")

    # Only these console values reach the playbook; other form variables are dropped so they can't
    # override your group_vars.
    ha_ev = {}
    check_pg_version(ev.get("postgresql_version"))
    if ev.get("postgresql_version") not in (None, ""):
        ha_ev["postgresql_version"] = str(ev["postgresql_version"])
    if ev.get("patroni_cluster_name"):
        ha_ev["cluster_name"] = str(ev["patroni_cluster_name"])
    if ev.get("proxy_env"):
        ha_ev["proxy_env"] = ev["proxy_env"]
    with open(out_ev, "w") as f:
        json.dump(ha_ev, f)

    for g in ("etcd_cluster", "patroni_cluster", "haproxy_cluster", "pgbouncer_cluster", "backrest_cluster",
              "prometheus_cluster", "alertmanager_cluster", "grafana_cluster"):
        if g in children:
            print(f"[jumbosql] {g:<20} {', '.join(hosts(children, g))}")
    print(f"[jumbosql] variables            {json.dumps(ha_ev)}")


if __name__ == "__main__":
    main()
