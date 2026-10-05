#!/usr/bin/env bash
# pack-from-ansible-vm.sh - run on the Ansible VM (.10) as root.
# Collects everything the adapter image needs into /root/cpa-bundle.tar.gz:
#   collections/  crunchydata.pg + pinned dependencies (from wherever ansible-galaxy finds them)
#   project/      the crunchy-ha-postgresql playbook dir (group_vars, files/, vault.yml, ...)
#   vault_pass    your vault password file (so the console can run unattended)
#
# Usage: ./pack-from-ansible-vm.sh [PLAYBOOK_DIR] [VAULT_PASS_FILE]
#   defaults: /root/crunchydata-pg-2.2/playbooks/crunchy-ha-postgresql  /root/.cpa_vault_pass
set -euo pipefail

PB=${1:-/root/crunchydata-pg-2.2/playbooks/crunchy-ha-postgresql}
VP=${2:-/root/.cpa_vault_pass}
OUT=/root/cpa-bundle.tar.gz
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

[[ -f "$PB/crunchy-postgres-ha.playbook.yml" ]] || { echo "playbook not found in $PB" >&2; exit 1; }

echo "== collections"
mkdir -p "$STAGE/bundle/collections/ansible_collections"
# every collection path ansible-galaxy reports, except the ones shipped inside the ansible python package
mapfile -t PATHS < <(ansible-galaxy collection list 2>/dev/null | sed -n 's/^# \(\/.*ansible_collections\)$/\1/p' | sort -u)
for p in "${PATHS[@]}"; do
  case "$p" in */site-packages/ansible_collections|*/dist-packages/ansible_collections) continue ;; esac
  echo "   $p"
  cp -a "$p"/. "$STAGE/bundle/collections/ansible_collections/"
done
[[ -d "$STAGE/bundle/collections/ansible_collections/crunchydata/pg" ]] || { echo "crunchydata.pg not found in: ${PATHS[*]}" >&2; exit 1; }

echo "== project $PB"
mkdir -p "$STAGE/bundle/project"
# keep files/var (the RPM download cache) so the container doesn't need to re-download from Crunchy
rsync -a --exclude '*.inventory.yml' --exclude 'jumbosql-deploy.yml' --exclude '*.retry' "$PB"/ "$STAGE/bundle/project/"
ls "$STAGE/bundle/project"

echo "== vault password"
if [[ -f "$VP" ]]; then install -m 600 "$VP" "$STAGE/bundle/vault_pass"; echo "   $VP"
else : >"$STAGE/bundle/vault_pass"; echo "   none found at $VP (vault.yml must then be unencrypted)"; fi

[[ -f "$PB/ansible.cfg" ]] && echo "== note: $PB/ansible.cfg will be merged into the image's ansible.cfg"

tar -C "$STAGE" -czf "$OUT" bundle
chmod 600 "$OUT"
echo
echo "Done: $OUT ($(du -h "$OUT" | cut -f1)). It contains secrets - copy it only to the console VM, into <repo>/automation-cpa/."
