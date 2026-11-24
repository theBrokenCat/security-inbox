#!/bin/sh
set -eu

# Vitest and the MCP E2E build need a writable workspace. Keep /app and its
# dependencies protected, and discard the test workspace with this container.
cd /app
test_workspace=$(mktemp -d /tmp/security-inbox-tests.XXXXXX)
cp -R src test views public scripts tasks package.json package-lock.json \
  tsconfig.json vitest.config.ts Dockerfile compose.yaml README.md AGENTS.md \
  "$test_workspace/"
ln -s /app/node_modules "$test_workspace/node_modules"
cd "$test_workspace"
# Vitest caches transformed modules under node_modules by default, which here is the
# read-only /app copy; keep that cache in the disposable workspace instead.
exec npm test -- --maxWorkers=2 --fsModuleCachePath "$test_workspace/.vitest-cache"
