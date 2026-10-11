#!/usr/bin/env python3
"""pgm_inventory.py - pg_mantra upgrades: the cluster's inventory (console JSON) as an Ansible YAML inventory,
with every group kept. Usage: pgm_inventory.py INVENTORY_JSON OUT_YML"""
import json
import sys

sys.path.insert(0, "/pgm")
sys.path.insert(0, "/ha")
try:
    from inventory_to_ha import emit_group  # same YAML writer as the deployment
except ImportError:  # running outside the image (tests)
    sys.path.insert(0, __file__.rsplit("/", 2)[0])
    from inventory_to_ha import emit_group


def main():
    inv = json.load(open(sys.argv[1]))
    allg = inv.get("all", inv)
    lines = ["all:"]
    if allg.get("vars"):
        lines.append("  vars:")
        for k, v in allg["vars"].items():
            lines.append(f"    {k}: {json.dumps(v)}")
    if allg.get("hosts"):
        lines.append("  hosts:")
        for h, hv in allg["hosts"].items():
            lines.append(f"    {h}:")
            for k, v in (hv or {}).items():
                lines.append(f"      {k}: {json.dumps(v)}")
    children = allg.get("children") or {}
    if children:
        lines.append("  children:")
        for g, body in children.items():
            emit_group(lines, g, body or {}, 2)
    open(sys.argv[2], "w").write("\n".join(lines) + "\n")
    for g, body in children.items():
        hosts = list(((body or {}).get("hosts") or {}).keys())
        if hosts:
            print(f"[pg_mantra] {g:<20} {', '.join(hosts)}")


if __name__ == "__main__":
    main()
