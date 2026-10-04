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
exec npm test -- --maxWorkers=2
