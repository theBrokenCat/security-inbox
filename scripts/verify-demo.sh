#!/usr/bin/env bash
# End-to-end demo on private resources only: a synthetic database and project folders under a
# fresh private root, an exclusive Compose project, a private image tag and a loopback port other
# than the real service's. It never reads the shared data or the repository .env, and never stops or
# removes anything it did not create. A failed run keeps its root, logs and stopped containers.
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
port="${SECURITY_INBOX_VERIFY_PORT:-3390}"

case "$port" in
  3300 | 3301)
    echo "Port $port belongs to the shared service; choose another SECURITY_INBOX_VERIFY_PORT." >&2
    exit 1
    ;;
esac
# No leading zero: bash would read 03300 as octal while Docker publishes 3300.
if ! [[ "$port" =~ ^[1-9][0-9]{3,4}$ ]] || ((port < 1024 || port > 65535)); then
  echo "SECURITY_INBOX_VERIFY_PORT must be a port between 1024 and 65535." >&2
  exit 1
fi

command -v docker >/dev/null
command -v curl >/dev/null
# Something already answers there: fail instead of stopping it or picking another target.
if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
  echo "127.0.0.1:$port is already in use; choose another SECURITY_INBOX_VERIFY_PORT." >&2
  exit 1
fi

run_id="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
project="security-inbox-verify-$run_id"
image="security-inbox:verify-$run_id"
if [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ] \
  || docker image inspect "$image" >/dev/null 2>&1; then
  echo "Compose project $project or image $image already exists; not reusing it." >&2
  exit 1
fi

root="$(mktemp -d "${TMPDIR:-/tmp}/security-inbox-verify.XXXXXX")"
chmod 700 "$root"
mkdir "$root/data" "$root/projects" "$root/projects/demo-api" "$root/projects/demo-web" "$root/logs"
# The containers run as UID 1000; only the synthetic data directory is handed over.
if [ "$(id -u)" = 0 ]; then chown 1000:1000 "$root/data"; fi
env_file="$root/compose.env"
: >"$env_file"

unset COMPOSE_FILE COMPOSE_PROFILES COMPOSE_PROJECT_NAME COMPOSE_ENV_FILES
export SECURITY_INBOX_IMAGE="$image"
export SECURITY_INBOX_DATA_DIR="$root/data"
export SECURITY_INBOX_PROJECTS_HOST_ROOT="$root/projects"
export SECURITY_INBOX_WEB_BIND=127.0.0.1
export SECURITY_INBOX_WEB_PORT="$port"
export SECURITY_INBOX_WEB_ORIGIN="http://127.0.0.1:$port"
export SECURITY_INBOX_MCP_BIND=127.0.0.1
export SECURITY_INBOX_USER=demo
export SECURITY_INBOX_DEFAULT_USER=demo
export SECURITY_INBOX_REVISION=verify

compose() {
  docker compose --project-name "$project" --project-directory "$repo_root" \
    --file "$repo_root/compose.yaml" --env-file "$env_file" "$@"
}

status=failed
finish() {
  local code=$?
  trap - EXIT INT TERM
  if [ "$status" = passed ]; then
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
    if [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ]; then
      echo "Containers of $project are still present; evidence kept in $root." >&2
      exit 1
    fi
    docker image rm "$image" >/dev/null
    rm -rf -- "$root"
  else
    compose logs --no-color >"$root/logs/compose.log" 2>&1 || true
    compose ps --all >"$root/logs/ps.txt" 2>&1 || true
    compose stop >/dev/null 2>&1 || true
    echo "verify-demo failed; evidence kept in $root" >&2
    echo "resources of this run: Compose project $project, image $image, directory $root" >&2
  fi
  exit "$code"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

wait_healthy() {
  for _ in $(seq 1 30); do
    if curl --fail --silent --show-error "http://127.0.0.1:$port/" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

compose build app

# Recompile in a temporary workspace, preserving the runtime image permissions.
compose run --rm -T app sh scripts/test-container.sh
compose run --rm -T app npm run seed

demo_before="$(compose run --rm -T app npm run demo)"
before_id="$(sed -n 's/.*finding \([0-9a-f-]\{36\}\);.*/\1/p' <<<"$demo_before")"
test -n "$before_id"

compose up -d web
published="$(compose port web 3300 | tr -d '\r')"
test "$published" = "127.0.0.1:$port"
wait_healthy

mcp_stderr="$root/logs/mcp.stderr"
set +e
mcp_stdout="$(compose run --rm -T mcp </dev/null 2>"$mcp_stderr")"
mcp_status=$?
set -e
test "$mcp_status" -eq 0
test -z "$mcp_stdout"
# errexit ignores a negated command, so the failure is explicit.
! grep -Fq "Security Inbox MCP failed to start" "$mcp_stderr" || exit 1

compose restart web >/dev/null
wait_healthy

demo_after="$(compose run --rm -T app npm run demo)"
after_id="$(sed -n 's/.*finding \([0-9a-f-]\{36\}\);.*/\1/p' <<<"$demo_after")"
test "$after_id" = "$before_id"
test -s "$root/data/security-inbox.sqlite"
status=passed
printf 'demo verified across restart: %s (project %s, port %s)\n' "$after_id" "$project" "$port"
