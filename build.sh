#!/usr/bin/env bash
# build.sh - build and run JumboSQL on the console VM (needs Docker).
#
#   ./build.sh automation   build jumbosql/automation-cpa:2.2.0 from automation-cpa/ (needs cpa-bundle.tar.gz there)
#   ./build.sh console      build jumbosql/console:<version> (UI + API + console DB + SQL editor)
#   ./build.sh run          (re)start the console container on port 80
#   ./build.sh all          automation + console + run
#
# Settings (environment):
#   JUMBOSQL_TOKEN       login token for the console          (asked for if unset on 'run')
#   JUMBOSQL_PORT        published UI port                     (default 80)
#   PATRONI_USERNAME / PATRONI_PASSWORD   Patroni REST API basic auth, if your CPA sets restapi authentication
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(tr -d '[:space:]' < console/service/VERSION 2>/dev/null || echo dev)
CONSOLE_IMAGE="jumbosql/console:${VERSION}"
AUTOMATION_IMAGE="jumbosql/automation-cpa:2.2.0"
CONSOLE_POSTGRES_VERSION=${CONSOLE_POSTGRES_VERSION:-16}

build_automation() {
  cd automation-cpa
  if [[ ! -d bundle ]]; then
    [[ -f cpa-bundle.tar.gz ]] || { echo "automation-cpa/cpa-bundle.tar.gz missing - run pack-from-ansible-vm.sh on the Ansible VM first" >&2; exit 1; }
    tar xzf cpa-bundle.tar.gz
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
    read -rsp "Console login token: " JUMBOSQL_TOKEN; echo
  fi
  docker inspect "$AUTOMATION_IMAGE" >/dev/null 2>&1 || echo "warning: $AUTOMATION_IMAGE not built yet (./build.sh automation)" >&2
  docker rm -f jumbosql-console >/dev/null 2>&1 || true
  docker run -d --name jumbosql-console \
    --publish "${JUMBOSQL_PORT:-80}:80" \
    --env PG_CONSOLE_AUTHORIZATION_TOKEN="$JUMBOSQL_TOKEN" \
    --env PG_CONSOLE_DOCKER_IMAGE="$AUTOMATION_IMAGE" \
    ${PATRONI_USERNAME:+--env PG_CONSOLE_PATRONI_USERNAME="$PATRONI_USERNAME"} \
    ${PATRONI_PASSWORD:+--env PG_CONSOLE_PATRONI_PASSWORD="$PATRONI_PASSWORD"} \
    --volume jumbosql_console_db:/var/lib/postgresql \
    --volume /var/run/docker.sock:/var/run/docker.sock \
    --volume /tmp/ansible:/tmp/ansible \
    --restart=unless-stopped \
    "$CONSOLE_IMAGE"
  echo "JumboSQL console is starting on port ${JUMBOSQL_PORT:-80}"
}

case "${1:-}" in
  automation) build_automation ;;
  console) build_console ;;
  run) run_console ;;
  all) build_automation; build_console; run_console ;;
  *) sed -n '2,12p' "$0"; exit 1 ;;
esac
