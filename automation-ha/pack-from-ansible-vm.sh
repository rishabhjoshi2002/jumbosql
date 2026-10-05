#!/usr/bin/env bash
# pack-from-ansible-vm.sh - run on the Ansible VM (.10) as root.
#
# Collects everything the JumboSQL HA automation image needs into /root/ha-bundle.tar.gz:
#   collections/  the HA Ansible collection (2.2.0) + its pinned dependencies (wherever ansible-galaxy finds them)
#   project/      your HA playbook directory (group_vars, files/, vault.yml, ...), with the playbook copied
#                 as keen-ha.playbook.yml - the only name JumboSQL uses
#
# The vault password is NOT packed: you give it to the console when you start it (./build.sh run asks), and
# the console hands it to each deployment.
#
# Usage: ./pack-from-ansible-vm.sh [PLAYBOOK_DIR]
#
# The defaults below are where the vendor's installer put the collection on your Ansible VM; this script is
# the only place in JumboSQL that refers to those vendor file names.
set -euo pipefail

VENDOR_PLAYBOOK_DIR=/root/crunchydata-pg-2.2/playbooks/crunchy-ha-postgresql
VENDOR_PLAYBOOK=crunchy-postgres-ha.playbook.yml
VENDOR_COLLECTION_DIR=crunchydata/pg

PB=${1:-$VENDOR_PLAYBOOK_DIR}
OUT=/root/ha-bundle.tar.gz
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

[[ -f "$PB/$VENDOR_PLAYBOOK" ]] || { echo "HA playbook not found in $PB" >&2; exit 1; }

echo "== collections"
mkdir -p "$STAGE/bundle/collections/ansible_collections"
# every collection path ansible-galaxy reports, except the ones shipped inside the ansible python package
mapfile -t PATHS < <(ansible-galaxy collection list 2>/dev/null | sed -n 's/^# \(\/.*ansible_collections\)$/\1/p' | sort -u)
for p in "${PATHS[@]}"; do
  case "$p" in */site-packages/ansible_collections|*/dist-packages/ansible_collections) continue ;; esac
  echo "   $p"
  cp -a "$p"/. "$STAGE/bundle/collections/ansible_collections/"
done
[[ -d "$STAGE/bundle/collections/ansible_collections/$VENDOR_COLLECTION_DIR" ]] || {
  echo "the HA collection was not found in: ${PATHS[*]}" >&2
  exit 1
}

echo "== project $PB"
mkdir -p "$STAGE/bundle/project"
# keep files/var (the RPM download cache) so the container doesn't need to download the packages again
rsync -a --exclude '*.inventory.yml' --exclude '*.retry' --exclude 'jumbosql-deploy.yml' "$PB"/ "$STAGE/bundle/project/"
cp "$PB/$VENDOR_PLAYBOOK" "$STAGE/bundle/project/keen-ha.playbook.yml"
ls "$STAGE/bundle/project"

if head -c 14 "$PB/vault.yml" 2>/dev/null | grep -q '^\$ANSIBLE_VAULT'; then
  echo "== vault.yml is encrypted: start the console with the same vault password (./build.sh run asks for it)"
fi

[[ -f "$PB/ansible.cfg" ]] && echo "== note: $PB/ansible.cfg will be merged into the image's ansible.cfg"

tar -C "$STAGE" -czf "$OUT" bundle
chmod 600 "$OUT"
echo
echo "Done: $OUT ($(du -h "$OUT" | cut -f1)). It contains your licensed collection and vault.yml - copy it only to the console VM, into <repo>/automation-ha/."
