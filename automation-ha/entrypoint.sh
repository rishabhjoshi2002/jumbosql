#!/bin/bash
# entrypoint.sh - pg_genin Keen PostgreSQL HA automation: runs inside the container the console starts.
#
# The console always starts the container with:
#     ansible-playbook deploy_pgcluster.yml --extra-vars '<json>'
# plus the env vars ANSIBLE_INVENTORY_JSON, SSH_PRIVATE_KEY_CONTENT and ANSIBLE_JSON_LOG_FILE.
# We keep that contract and run the HA playbook (automation 2.2.0) with the inventory from the form.
set -euo pipefail

PROJECT=/ha/project
WORK=/ha/run
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

# --- 4. write the HA inventory from the console's inventory step + pick the HA variables
python3 /ha/inventory_to_ha.py \
  "$WORK/autobase-inventory.json" "$WORK/autobase-extra-vars.json" \
  "$PROJECT/jumbosql.inventory.yml" "$WORK/ha-extra-vars.json"

# --- 5. run the HA playbook (same command as on the Ansible VM, plus the console wrapper plays)
cd "$PROJECT"
VAULT_ARGS=()
[[ -f vault.yml ]] && VAULT_ARGS+=(-e @vault.yml)
# The vault password comes from the console (PG_CONSOLE_VAULT_PASSWORD -> ANSIBLE_VAULT_PASSWORD). It is written
# to a private file for this run only and removed from the environment, so playbook tasks never see it.
if [[ -n "${ANSIBLE_VAULT_PASSWORD:-}" ]]; then
  (umask 077 && printf '%s\n' "$ANSIBLE_VAULT_PASSWORD" >"$WORK/.vault_pass")
  unset ANSIBLE_VAULT_PASSWORD
  VAULT_ARGS+=(--vault-password-file "$WORK/.vault_pass")
elif [[ -f /ha/.vault_pass ]]; then
  VAULT_ARGS+=(--vault-password-file /ha/.vault_pass) # older images built with the password inside
elif [[ -f vault.yml ]] && head -c 14 vault.yml | grep -q '^\$ANSIBLE_VAULT'; then
  echo "[jumbosql] ERROR: vault.yml is encrypted but no vault password was given - start the console with PG_CONSOLE_VAULT_PASSWORD (./build.sh run asks for it)." >&2
  exit 2
fi

echo "[jumbosql] ansible-playbook -i jumbosql.inventory.yml jumbosql-deploy.yml ${VAULT_ARGS[*]}"
exec ansible-playbook -i jumbosql.inventory.yml jumbosql-deploy.yml \
  "${VAULT_ARGS[@]}" -e @"$WORK/ha-extra-vars.json"
