#!/bin/bash
# entrypoint.sh - JumboSQL CPA automation: runs inside the container the JumboSQL console starts.
#
# The console always starts the container with:
#     ansible-playbook deploy_pgcluster.yml --extra-vars '<json>'
# plus the env vars ANSIBLE_INVENTORY_JSON, SSH_PRIVATE_KEY_CONTENT and ANSIBLE_JSON_LOG_FILE.
# We keep that contract and run the CPA 2.2.0 playbook (crunchydata.pg) with the inventory from the form.
set -euo pipefail

PROJECT=/cpa/project
WORK=/cpa/run
mkdir -p "$WORK"

is_base64() { [[ "$1" =~ ^[A-Za-z0-9+/=]+$ ]]; }

# --- 1. inventory from the console (same decoding as Autobase's own entrypoint)
if [[ -z "${ANSIBLE_INVENTORY_JSON:-}" ]]; then
  echo "[jumbosql] ERROR: ANSIBLE_INVENTORY_JSON not set - use 'Your own machines' in the console." >&2
  exit 2
fi
if is_base64 "$ANSIBLE_INVENTORY_JSON"; then
  echo "$ANSIBLE_INVENTORY_JSON" | base64 -d >"$WORK/autobase-inventory.json"
else
  echo "$ANSIBLE_INVENTORY_JSON" >"$WORK/autobase-inventory.json"
fi

# --- 2. SSH key from the console
if [[ -n "${SSH_PRIVATE_KEY_CONTENT:-}" ]]; then
  mkdir -p /root/.ssh && chmod 700 /root/.ssh
  if is_base64 "$SSH_PRIVATE_KEY_CONTENT"; then
    echo "$SSH_PRIVATE_KEY_CONTENT" | base64 -d >/root/.ssh/id_rsa
  else
    echo "$SSH_PRIVATE_KEY_CONTENT" >/root/.ssh/id_rsa
  fi
  chmod 600 /root/.ssh/id_rsa
  sed -i -e '$a\' /root/.ssh/id_rsa
  ssh-keygen -y -f /root/.ssh/id_rsa >/dev/null
  export ANSIBLE_PRIVATE_KEY_FILE=/root/.ssh/id_rsa
fi

# --- 3. pick the console's --extra-vars JSON out of the command line
EXTRA='{}'
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  if [[ "${args[$i]}" == "--extra-vars" || "${args[$i]}" == "-e" ]]; then
    EXTRA="${args[$((i + 1))]:-}"
  fi
done
[[ -z "$EXTRA" ]] && EXTRA='{}'
printf '%s' "$EXTRA" >"$WORK/autobase-extra-vars.json"

# --- 4. write the CPA inventory from the console's inventory step + pick the CPA variables
python3 /cpa/inventory_to_cpa.py \
  "$WORK/autobase-inventory.json" "$WORK/autobase-extra-vars.json" \
  "$PROJECT/jumbosql.inventory.yml" "$WORK/cpa-extra-vars.json"

# --- 5. run CPA (same command as on the Ansible VM, plus the console wrapper plays)
cd "$PROJECT"
VAULT_ARGS=()
[[ -f vault.yml ]] && VAULT_ARGS+=(-e @vault.yml)
[[ -f /cpa/.vault_pass ]] && VAULT_ARGS+=(--vault-password-file /cpa/.vault_pass)

echo "[jumbosql] ansible-playbook -i jumbosql.inventory.yml jumbosql-deploy.yml ${VAULT_ARGS[*]}"
exec ansible-playbook -i jumbosql.inventory.yml jumbosql-deploy.yml \
  "${VAULT_ARGS[@]}" -e @"$WORK/cpa-extra-vars.json"
