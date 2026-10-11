#!/bin/bash
# pg_mantra upgrade runner. The console starts it like a deployment container:
#     <cmd...> --extra-vars '{"pgm": {...}, "ansible_user": ...}'
# with ANSIBLE_INVENTORY_JSON (base64 JSON inventory), ANSIBLE_JSON_LOG_FILE and, for key logins,
# SSH_PRIVATE_KEY_CONTENT. It runs pgm-upgrade.yml - or, with PGM_MODE=playbook, your own playbook (Custom
# playbooks): the console writes its files to PGM_DIR (playbook PGM_PLAYBOOK, inventory PGM_INVENTORY,
# pgm-requirements.yml) and sets PGM_CHECK=1 for a dry run, PGM_LIMIT, PGM_VERBOSE, PGM_VAULT_PASSWORD (base64).
set -euo pipefail
W=$(mktemp -d)
is_base64() { [[ "$1" =~ ^[A-Za-z0-9+/=]+$ ]]; }

[[ -n "${ANSIBLE_INVENTORY_JSON:-}" || "${PGM_MODE:-}" == "playbook" ]] || { echo "[pg_mantra] ERROR: no inventory" >&2; exit 2; }
if [[ -z "${ANSIBLE_INVENTORY_JSON:-}" ]]; then :
elif is_base64 "$ANSIBLE_INVENTORY_JSON"; then echo "$ANSIBLE_INVENTORY_JSON" | base64 -d > "$W/inventory.json"
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

if [[ "${PGM_MODE:-}" == "playbook" ]]; then
  cd "${PGM_DIR:?}"
  [[ -f "$PGM_PLAYBOOK" ]] || { echo "[pg_mantra] ERROR: playbook $PGM_PLAYBOOK not found" >&2; exit 2; }
  inv="$PGM_INVENTORY"
  if [[ "$inv" == *.json ]]; then python3 /pgm/upgrade/pgm_inventory.py "$inv" "$W/inventory.yml"; inv="$W/inventory.yml"; fi
  export ANSIBLE_ROLES_PATH="$PWD/roles:$PWD/pgm-galaxy/roles:${ANSIBLE_ROLES_PATH:-/etc/ansible/roles}"
  export ANSIBLE_COLLECTIONS_PATH="$PWD/collections:$PWD/pgm-galaxy:/usr/share/ansible/collections:/root/.ansible/collections"
  if [[ -f pgm-requirements.yml ]]; then
    echo "[pg_mantra] installing pgm-requirements.yml"
    ansible-galaxy collection install -r pgm-requirements.yml -p pgm-galaxy || echo "[pg_mantra] WARNING: collections not installed"
    ansible-galaxy role install -r pgm-requirements.yml -p pgm-galaxy/roles || echo "[pg_mantra] WARNING: roles not installed"
  fi
  opts=(-i "$inv" -e @"$W/extra-vars.json")
  [[ "${PGM_CHECK:-0}" == "1" ]] && opts+=(--check --diff)
  [[ -n "${PGM_LIMIT:-}" ]] && opts+=(--limit "$PGM_LIMIT")
  [[ "${PGM_VERBOSE:-0}" == "1" ]] && opts+=(-vv)
  if [[ -n "${PGM_VAULT_PASSWORD:-}" ]]; then
    (umask 077 && echo "$PGM_VAULT_PASSWORD" | base64 -d > "$W/vault")
    opts+=(--vault-password-file "$W/vault")
  fi
  echo "[pg_mantra] $( [[ "${PGM_CHECK:-0}" == "1" ]] && echo 'dry run (--check --diff)' || echo run ) of $PGM_PLAYBOOK"
  exec ansible-playbook "${opts[@]}" "$PGM_PLAYBOOK"
fi

python3 /pgm/upgrade/pgm_inventory.py "$W/inventory.json" "$W/inventory.yml"
cd /pgm/upgrade
echo "[pg_mantra] $(python3 -c 'import json,sys; p=json.load(open(sys.argv[1])).get("pgm",{}); print(p.get("action"), p.get("component"))' "$W/extra-vars.json")"
exec ansible-playbook -i "$W/inventory.yml" pgm-upgrade.yml -e @"$W/extra-vars.json"
