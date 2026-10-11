#!/bin/bash
# pg_mantra upgrade runner. The console starts it like a deployment container:
#     <cmd...> --extra-vars '{"pgm": {...}, "ansible_user": ...}'
# with ANSIBLE_INVENTORY_JSON (base64 JSON inventory), ANSIBLE_JSON_LOG_FILE and, for key logins,
# SSH_PRIVATE_KEY_CONTENT. It runs pgm-upgrade.yml and nothing else.
set -euo pipefail
W=$(mktemp -d)
is_base64() { [[ "$1" =~ ^[A-Za-z0-9+/=]+$ ]]; }

[[ -n "${ANSIBLE_INVENTORY_JSON:-}" ]] || { echo "[pg_mantra] ERROR: no inventory" >&2; exit 2; }
if is_base64 "$ANSIBLE_INVENTORY_JSON"; then echo "$ANSIBLE_INVENTORY_JSON" | base64 -d > "$W/inventory.json"
else printf '%s' "$ANSIBLE_INVENTORY_JSON" > "$W/inventory.json"; fi

if [[ -n "${SSH_PRIVATE_KEY_CONTENT:-}" ]]; then
  mkdir -p /root/.ssh && chmod 700 /root/.ssh
  if is_base64 "$SSH_PRIVATE_KEY_CONTENT"; then echo "$SSH_PRIVATE_KEY_CONTENT" | base64 -d > /root/.ssh/id_pgm
  else printf '%s\n' "$SSH_PRIVATE_KEY_CONTENT" > /root/.ssh/id_pgm; fi
  chmod 600 /root/.ssh/id_pgm
  export ANSIBLE_PRIVATE_KEY_FILE=/root/.ssh/id_pgm
fi

EXTRA='{}'
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  [[ "${args[$i]}" == "--extra-vars" || "${args[$i]}" == "-e" ]] && EXTRA="${args[$((i + 1))]:-}"
done
(umask 077 && printf '%s' "$EXTRA" > "$W/extra-vars.json")

python3 /pgm/upgrade/pgm_inventory.py "$W/inventory.json" "$W/inventory.yml"
cd /pgm/upgrade
echo "[pg_mantra] $(python3 -c 'import json,sys; p=json.load(open(sys.argv[1])).get("pgm",{}); print(p.get("action"), p.get("component"))' "$W/extra-vars.json")"
exec ansible-playbook -i "$W/inventory.yml" pgm-upgrade.yml -e @"$W/extra-vars.json"
