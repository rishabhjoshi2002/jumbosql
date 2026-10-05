#!/usr/bin/env bash
# build.sh - build and run JumboSQL on the console VM (needs Docker).
#
#   ./build.sh automation   build jumbosql/automation-ha:2.2.0 from automation-ha/ (needs ha-bundle.tar.gz there)
#   ./build.sh console      build jumbosql/console:<version> (UI + API + console DB + SQL editor)
#   ./build.sh run          (re)start the console container on port 80
#   ./build.sh all          automation + console + run
#
# Settings (environment):
#   JUMBOSQL_TOKEN       API token for scripts; also the first admin's password unless JUMBOSQL_ADMIN_PASSWORD is set
#                        (asked for if unset on 'run'). People sign in as admin / <that password>.
#   JUMBOSQL_PORT        published UI port                     (default 80)
#   PATRONI_USERNAME / PATRONI_PASSWORD   Patroni REST API basic auth, if your group_vars set restapi authentication
#   JUMBOSQL_ADMIN_PASSWORD               first admin's password (default: the login token)
#   JUMBOSQL_VAULT_PASSWORD               Ansible vault password for vault.yml (asked for if unset and not saved yet)
#
# The vault password is kept in /etc/jumbosql/vault_pass (root only, mode 600) and given to the console as a
# secret file; the console hands it to each deployment. It is never stored in an image or the console DB.
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(tr -d '[:space:]' < console/service/VERSION 2>/dev/null || echo dev)
CONSOLE_IMAGE="jumbosql/console:${VERSION}"
AUTOMATION_IMAGE="jumbosql/automation-ha:2.2.0"
CONSOLE_POSTGRES_VERSION=${CONSOLE_POSTGRES_VERSION:-16}

build_automation() {
  cd automation-ha
  if [[ ! -d bundle ]]; then
    [[ -f ha-bundle.tar.gz ]] || { echo "automation-ha/ha-bundle.tar.gz missing - run pack-from-ansible-vm.sh on the Ansible VM first" >&2; exit 1; }
    tar xzf ha-bundle.tar.gz
  fi
  docker build -t "$AUTOMATION_IMAGE" .
  cd ..
  echo "built $AUTOMATION_IMAGE (local only - it contains your vault, do not push it)"
}

build_console() {
  docker build -f console/Dockerfile --build-arg POSTGRES_VERSION="$CONSOLE_POSTGRES_VERSION" -t "$CONSOLE_IMAGE" .
  echo "built $CONSOLE_IMAGE"
}

run_console() {
  if [[ -z "${JUMBOSQL_TOKEN:-}" ]]; then
    read -rsp "Console API token (also the first admin password): " JUMBOSQL_TOKEN; echo
  fi
  # Ansible vault password: env > prompt > previously saved file
  install -d -m 700 /etc/jumbosql
  if [[ -n "${JUMBOSQL_VAULT_PASSWORD:-}" ]]; then
    (umask 077 && printf '%s' "$JUMBOSQL_VAULT_PASSWORD" >/etc/jumbosql/vault_pass)
  elif [[ ! -s /etc/jumbosql/vault_pass ]]; then
    read -rsp "Ansible vault password for vault.yml (Enter if vault.yml is not encrypted): " JUMBOSQL_VAULT_PASSWORD; echo
    (umask 077 && printf '%s' "$JUMBOSQL_VAULT_PASSWORD" >/etc/jumbosql/vault_pass)
  else
    echo "using the saved vault password in /etc/jumbosql/vault_pass (set JUMBOSQL_VAULT_PASSWORD to change it)"
  fi
  chmod 600 /etc/jumbosql/vault_pass
  VAULT_ARGS=()
  if [[ -s /etc/jumbosql/vault_pass ]]; then
    VAULT_ARGS=(--volume /etc/jumbosql/vault_pass:/run/secrets/jumbosql_vault_pass:ro
                --env PG_CONSOLE_VAULT_PASSWORD_FILE=/run/secrets/jumbosql_vault_pass)
  fi

  docker inspect "$AUTOMATION_IMAGE" >/dev/null 2>&1 || echo "warning: $AUTOMATION_IMAGE not built yet (./build.sh automation)" >&2
  docker rm -f jumbosql-console >/dev/null 2>&1 || true
  docker run -d --name jumbosql-console \
    --publish "${JUMBOSQL_PORT:-80}:80" \
    --env PG_CONSOLE_AUTHORIZATION_TOKEN="$JUMBOSQL_TOKEN" \
    ${JUMBOSQL_ADMIN_PASSWORD:+--env PG_CONSOLE_AUTH_ADMIN_PASSWORD="$JUMBOSQL_ADMIN_PASSWORD"} \
    --env PG_CONSOLE_DOCKER_IMAGE="$AUTOMATION_IMAGE" \
    "${VAULT_ARGS[@]}" \
    ${PATRONI_USERNAME:+--env PG_CONSOLE_PATRONI_USERNAME="$PATRONI_USERNAME"} \
    ${PATRONI_PASSWORD:+--env PG_CONSOLE_PATRONI_PASSWORD="$PATRONI_PASSWORD"} \
    --volume jumbosql_console_db:/var/lib/postgresql \
    --volume /var/run/docker.sock:/var/run/docker.sock \
    --volume /tmp/ansible:/tmp/ansible \
    --restart=unless-stopped \
    "$CONSOLE_IMAGE"
  echo "JumboSQL console is starting on port ${JUMBOSQL_PORT:-80}. Sign in as: admin (first start only creates it)"
}

case "${1:-}" in
  automation) build_automation ;;
  console) build_console ;;
  run) run_console ;;
  all) build_automation; build_console; run_console ;;
  *) sed -n '2,12p' "$0"; exit 1 ;;
esac
