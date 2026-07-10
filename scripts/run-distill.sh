#!/usr/bin/env bash
# Cron-safe distiller wrapper: resolves bun without relying on the caller's
# PATH, runs `distill run`, and appends timestamped output to
# ${AGENT_MEMORY_HOME:-~/.agent-memory}/distill.log.
#
# Usage (typically from cron/systemd):
#   /path/to/repo/scripts/run-distill.sh [extra distill-run args]
set -uo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${AGENT_MEMORY_HOME:-$HOME/.agent-memory}"
LOG_FILE="$LOG_DIR/distill.log"
mkdir -p "$LOG_DIR"

# cron environments have a bare PATH — find bun explicitly.
BUN="$(command -v bun || true)"
[ -n "$BUN" ] || { [ -x "$HOME/.bun/bin/bun" ] && BUN="$HOME/.bun/bin/bun"; }
if [ -z "$BUN" ]; then
  echo "$(date -u +%FT%TZ) ERROR: bun not found (PATH=$PATH)" >> "$LOG_FILE"
  exit 1
fi

{
  echo "$(date -u +%FT%TZ) distill run starting (repo: $REPO_DIR)"
  cd "$REPO_DIR" && "$BUN" distiller/cli.ts run "$@"
  RC=$?  # capture BEFORE any command substitution ($(date) would reset $?)
  echo "$(date -u +%FT%TZ) distill run finished (exit $RC)"
  exit "$RC"
} >> "$LOG_FILE" 2>&1
