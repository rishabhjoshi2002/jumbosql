#!/usr/bin/env python3
"""Build-time: take CPA's own ansible.cfg (if the playbook dir has one) and add what the console needs."""
import configparser
import os

src = "/cpa/project/ansible.cfg"
cfg = configparser.ConfigParser(interpolation=None, inline_comment_prefixes=("#", ";"), strict=False)
if os.path.exists(src):
    cfg.read(src)
    print(f"merged CPA settings from {src}")

for sec in ("defaults", "ssh_connection"):
    if not cfg.has_section(sec):
        cfg.add_section(sec)

d = cfg["defaults"]
d["collections_path"] = "/cpa/collections"
d["callback_plugins"] = "/cpa/callback"
enabled = [c.strip() for c in d.get("callbacks_enabled", "").split(",") if c.strip()]
if "json_log" not in enabled:
    enabled.append("json_log")
d["callbacks_enabled"] = ", ".join(enabled)
d["host_key_checking"] = "False"
d.setdefault("forks", "10")
d.setdefault("timeout", "60")
cfg["ssh_connection"].setdefault("pipelining", "True")

with open("/cpa/ansible.cfg", "w") as f:
    cfg.write(f)
print(open("/cpa/ansible.cfg").read())
