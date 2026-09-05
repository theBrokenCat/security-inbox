#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

command -v docker >/dev/null
command -v curl >/dev/null
mkdir -p data

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/security-inbox-verify.XXXXXX")"
cleanup() {
  docker compose down --remove-orphans >/dev/null 2>&1 || true
  case "$tmp_dir" in
    /tmp/security-inbox-verify.*) rm -rf -- "$tmp_dir" ;;
  esac
}
trap cleanup EXIT INT TERM

docker compose build app

# The MCP E2E test recompiles dist; keep that ephemeral test run separate from
# the non-privileged runtime services and preserve root-owned application files.
docker compose run --rm -T --user root app npm test
docker compose run --rm -T app npm run seed

demo_before="$(docker compose run --rm -T app npm run demo)"
before_id="$(sed -n 's/.*finding \([0-9a-f-]\{36\}\);.*/\1/p' <<<"$demo_before")"
test -n "$before_id"

docker compose up -d web
published="$(docker compose port web 3300 | tr -d '\r')"
test "$published" = '127.0.0.1:3300'

healthy=false
for _ in $(seq 1 30); do
  if curl --fail --silent --show-error http://127.0.0.1:3300/ >/dev/null; then
    healthy=true
    break
  fi
  sleep 1
done
test "$healthy" = true

mcp_stderr="$tmp_dir/mcp.stderr"
set +e
mcp_stdout="$(docker compose run --rm -T mcp </dev/null 2>"$mcp_stderr")"
mcp_status=$?
set -e
test "$mcp_status" -eq 0
test -z "$mcp_stdout"
! grep -Fq "Security Inbox MCP failed to start" "$mcp_stderr"

docker compose restart web >/dev/null
healthy=false
for _ in $(seq 1 30); do
  if curl --fail --silent --show-error http://127.0.0.1:3300/ >/dev/null; then
    healthy=true
    break
  fi
  sleep 1
done
test "$healthy" = true

demo_after="$(docker compose run --rm -T app npm run demo)"
after_id="$(sed -n 's/.*finding \([0-9a-f-]\{36\}\);.*/\1/p' <<<"$demo_after")"
test "$after_id" = "$before_id"
printf 'demo verified across restart: %s\n' "$after_id"
