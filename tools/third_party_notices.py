#!/usr/bin/env python3
"""
Write THIRD_PARTY_NOTICES.md: the open-source components shipped in the pg_MANTRA console (Go modules of the API
server, npm packages of the web UI - production dependencies only) with their licenses.

    cd console/service && go list -deps -f '{{if .Module}}{{.Module.Path}} {{.Module.Version}} {{.Module.Dir}}{{end}}' . \
        | sort -u > /tmp/go-mods.txt
    python3 tools/third_party_notices.py /tmp/go-mods.txt console/ui > THIRD_PARTY_NOTICES.md

Re-run it whenever dependencies change. Keep the file with every copy you ship (repository, images, packages).
"""
import json
import os
import re
import sys

# modules whose license file is not in the module cache of every build machine
KNOWN = {"github.com/gdex-lab/go-render": "BSD-3-Clause (fork of github.com/luci/go-render)"}

LICENSE_FILES = ("LICENSE", "LICENSE.txt", "LICENSE.md", "LICENCE", "COPYING", "LICENSE-MIT", "license", "License")


def guess(text):
    t = " ".join(text.split())
    if "Apache License" in t and ("Version 2.0" in t or "version 2.0" in t):
        return "Apache-2.0"
    if "Mozilla Public License" in t and "2.0" in t:
        return "MPL-2.0"
    if "GNU LESSER GENERAL PUBLIC" in t.upper():
        return "LGPL"
    if "GNU GENERAL PUBLIC" in t.upper():
        return "GPL"
    if "ISC License" in t or "Permission to use, copy, modify, and/or distribute this software for any" in t:
        return "ISC"
    if "Redistribution and use in source and binary forms" in t:
        return "BSD-3-Clause" if "Neither the name" in t or "neither the name" in t else "BSD-2-Clause"
    if "Permission is hereby granted, free of charge" in t:
        return "MIT"
    if "unlicense" in t.lower() or "This is free and unencumbered software" in t:
        return "Unlicense"
    return "see its license file"


def license_of(d):
    for f in LICENSE_FILES:
        p = os.path.join(d, f)
        if os.path.isfile(p):
            return guess(open(p, errors="ignore").read())
    return "unknown (no license file found)"


def go_modules(listing):
    out = {}
    for line in open(listing):
        parts = line.split()
        if len(parts) < 3 or parts[0].startswith("postgresql-cluster-console"):
            continue
        lic = license_of(parts[2])
        out[parts[0]] = (parts[1], KNOWN.get(parts[0], lic) if lic.startswith("unknown") else lic)
    return out


def npm_packages(ui):
    pkg = json.load(open(os.path.join(ui, "package.json")))
    seen = {}
    todo = list((pkg.get("dependencies") or {}).keys())
    while todo:
        name = todo.pop()
        if name in seen:
            continue
        d = os.path.join(ui, "node_modules", name)
        pj = os.path.join(d, "package.json")
        if not os.path.isfile(pj):
            continue
        m = json.load(open(pj))
        lic = m.get("license")
        if isinstance(lic, dict):
            lic = lic.get("type")
        if not lic and isinstance(m.get("licenses"), list) and m["licenses"]:
            lic = " OR ".join(x.get("type", "") for x in m["licenses"] if isinstance(x, dict))
        seen[name] = (m.get("version", ""), lic or license_of(d))
        todo += list((m.get("dependencies") or {}).keys())
    return seen


def table(title, rows):
    lines = [f"## {title}", "", "| Component | Version | License |", "|---|---|---|"]
    for name in sorted(rows):
        v, lic = rows[name]
        lines.append(f"| {name} | {v} | {lic} |")
    counts = {}
    for _, lic in rows.values():
        counts[lic] = counts.get(lic, 0) + 1
    lines += ["", "Totals: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items(), key=lambda x: -x[1])), ""]
    return "\n".join(lines)


def main():
    go = go_modules(sys.argv[1])
    npm = npm_packages(sys.argv[2])
    print("# Third-Party Notices\n")
    print("pg_MANTRA is built on Autobase (MIT, see LICENSE and NOTICE) and uses the open-source components below.")
    print("Each keeps its own license; the full license texts are in the components' source (Go module cache,")
    print("`node_modules`) and must be kept with every copy you distribute.\n")
    print(table("API Server (Go Modules)", go))
    print(table("Web UI (npm Packages, Production)", npm))
    flagged = sorted(n for n, (_, lic) in {**go, **npm}.items() if re.search(r"GPL|unknown|see its", str(lic)))
    if flagged:
        print("## To Check By Hand\n")
        print("These need a manual look (copyleft or the license could not be read automatically):\n")
        for n in flagged:
            print(f"- {n}")


if __name__ == "__main__":
    main()
