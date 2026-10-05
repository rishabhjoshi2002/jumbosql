#!/usr/bin/env python3
"""
make_deploy_playbook.py - build time: write jumbosql-deploy.yml with the HA playbook's plays copied in.

The HA collection reads the playbook given on the command line (module_utils/groups.py) and expects every
play in it to have `hosts:`. An `import_playbook:` entry has none, so a wrapper that imports the HA playbook
crashes with "'NoneType' object has no attribute 'split'". So the template's import line is replaced by the
text of the HA playbook itself (byte for byte, comments and Jinja untouched), and the result is checked.

Usage: make_deploy_playbook.py TEMPLATE HA_PLAYBOOK OUTPUT
"""
import re
import sys

import yaml

MARKER = re.compile(r"^- name: Keen PostgreSQL HA\n\s+(ansible\.builtin\.)?import_playbook: \S+\n", re.M)


class AnyTagLoader(yaml.SafeLoader):
    """Loads custom tags (!vault, !unsafe, ...) as plain values: only the structure is checked here."""


AnyTagLoader.add_multi_constructor("!", lambda loader, suffix, node: None)


def main():
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    template_path, ha_path, out_path = sys.argv[1:]
    template = open(template_path).read()
    ha = open(ha_path).read()

    if not MARKER.search(template):
        sys.exit(f"{template_path}: the '- name: Keen PostgreSQL HA / import_playbook' entry was not found")

    # drop the HA playbook's document markers; its plays are top-level list items like the template's
    body = "\n".join(l for l in ha.splitlines() if l.strip() not in ("---", "...")).strip("\n")
    plays = yaml.load(body, Loader=AnyTagLoader)
    if not isinstance(plays, list) or not plays:
        sys.exit(f"{ha_path}: expected a list of plays")
    inlined = f"# ---- begin: {ha_path.rsplit('/', 1)[-1]} (copied at image build) ----\n{body}\n# ---- end ----\n"
    out = MARKER.sub(lambda _: inlined, template, count=1)

    final = yaml.load(out, Loader=AnyTagLoader)
    bad = [i for i, p in enumerate(final) if not isinstance(p, dict) or not p.get("hosts")]
    if bad:
        sys.exit(f"{out_path}: plays without 'hosts:' at positions {bad} - the HA collection cannot run this playbook")

    with open(out_path, "w") as f:
        f.write(out)
    print(f"{out_path}: {len(final)} plays ({len(plays)} from {ha_path})")


if __name__ == "__main__":
    main()
