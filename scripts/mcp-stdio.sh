#!/bin/sh
# One stdio MCP session in a one-off container that is removed however the session ends.
#
#   ssh -T arturo-dev /root/Proyectos/security-inbox/scripts/mcp-stdio.sh [-e SECURITY_INBOX_USER=slug]
#
# `docker compose run --rm` alone leaves its container behind when the client gives up while
# the container is still being created or started (a slow host, a 30 s client timeout): the
# CLI dies before it can remove it (SIGPIPE once the SSH channel is gone, or a signal), and
# --rm only covers a container that ran and exited. Such containers stay "Created" forever,
# or "Up" with nobody attached. Here the container gets a name chosen in advance, and when
# compose returns, for whatever reason, exactly that container is removed: never another
# client's. stdout stays reserved for the protocol; this script writes nothing of its own.
#
# Options go to `docker compose run` before the service name; -e is the one that is expected.
# SECURITY_INBOX_MCP_CLEANUP_RETRY (seconds, default "2 10 30") spaces the extra removals made
# after an abnormal end; the tests shorten it.
set -u

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P) || exit 1
name="security-inbox-mcp-session-$(date -u +%Y%m%dT%H%M%SZ)-$$"
retry_delays=${SECURITY_INBOX_MCP_CLEANUP_RETRY:-2 10 30}
child=''
stop=''
status=0

remove() { docker rm -f "$name" >/dev/null 2>&1; }

cleanup() {
  # Further signals are ignored from here on, and so by the retries started below: a second
  # stop, or one sent to the caller's whole process group, cannot cut the cleanup short.
  trap - EXIT
  trap '' HUP INT TERM
  remove
  # Compose can die while its create request is still in flight, and the daemon may finish
  # creating the container after the removal above. After an abnormal end the removal is
  # repeated in the background, detached from the session's stdio so the client is not kept.
  if [ "$status" -ne 0 ]; then
    (for delay in $retry_delays; do sleep "$delay"; remove; done) </dev/null >/dev/null 2>&1 &
  fi
}

# Compose stops the container on TERM; the loop below then sees it exit. A signal that reaches
# only this script is passed on at once instead of waiting for compose to end by itself; one
# that arrives before compose has a pid is remembered and delivered as soon as it has one.
forward() {
  stop=1
  if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null; fi
}

trap cleanup EXIT
trap forward HUP INT TERM

# In the background so the traps run as soon as a signal arrives. stdin goes through fd 3: a
# background job in a non-interactive shell reads /dev/null instead, and dash applies that
# even over an explicit `<&0`.
exec 3<&0
docker compose -f "$root/compose.yaml" run --rm -T --name "$name" "$@" mcp <&3 3<&- &
child=$!
exec 3<&-
if [ -n "$stop" ]; then kill -TERM "$child" 2>/dev/null; fi
while :; do
  wait "$child"
  status=$?
  kill -0 "$child" 2>/dev/null || break
done
exit "$status"
