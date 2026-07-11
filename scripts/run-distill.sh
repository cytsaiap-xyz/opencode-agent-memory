#!/usr/bin/env bash
# Cron-safe distiller wrapper: resolves bun without relying on the caller's
# PATH, runs `distill run` (and optionally `distill reflect`), and appends
# timestamped output to ${AGENT_MEMORY_HOME:-~/.agent-memory}/distill.log.
#
# Usage (typically from cron/systemd):
#   /path/to/repo/scripts/run-distill.sh [MODE FLAG] [extra distill args]
#
# MODE FLAG (mutually exclusive; default is legacy run-only behavior):
#   --with-reflect   run `distill run` then `distill reflect`, same log file,
#                    same trailing args passed to BOTH stages.
#   --reflect-only   run ONLY `distill reflect` — for a separately scheduled
#                    reflect cron line (see scripts/setup.sh --schedule-reflect).
# Any remaining args (e.g. --project <slug>) are forwarded verbatim to
# whichever distill command(s) run.
#
# Exit code: the worst (highest) exit code among the stage(s) that ran.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${AGENT_MEMORY_HOME:-$HOME/.agent-memory}"
LOG_FILE="$LOG_DIR/distill.log"
mkdir -p "$LOG_DIR"

MODE="run-only"
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --with-reflect) MODE="run-and-reflect" ;;
    --reflect-only) MODE="reflect-only" ;;
    *) ARGS+=("$arg") ;;
  esac
done

# cron environments have a bare PATH — find bun explicitly.
BUN="$(command -v bun || true)"
[ -n "$BUN" ] || { [ -x "$HOME/.bun/bin/bun" ] && BUN="$HOME/.bun/bin/bun"; }
if [ -z "$BUN" ]; then
  echo "$(date -u +%FT%TZ) ERROR: bun not found (PATH=$PATH)" >> "$LOG_FILE"
  exit 1
fi

{
  RC=0

  if [ "$MODE" != "reflect-only" ]; then
    echo "$(date -u +%FT%TZ) distill run starting (repo: $REPO_DIR)"
    # bash 3.2 (macOS default) treats a reference to an EMPTY array as an unbound
    # variable under `set -u` — the `+"${ARGS[@]}"` guard sidesteps that (expands to
    # nothing when ARGS is empty, to the array otherwise).
    cd "$REPO_DIR" && "$BUN" distiller/cli.ts run ${ARGS[@]+"${ARGS[@]}"}
    RUN_RC=$?  # capture BEFORE any command substitution ($(date) would reset $?)
    echo "$(date -u +%FT%TZ) distill run finished (exit $RUN_RC)"
    [ "$RUN_RC" -gt "$RC" ] && RC="$RUN_RC"
  fi

  if [ "$MODE" != "run-only" ]; then
    echo "$(date -u +%FT%TZ) distill reflect starting (repo: $REPO_DIR)"
    cd "$REPO_DIR" && "$BUN" distiller/cli.ts reflect ${ARGS[@]+"${ARGS[@]}"}
    REFLECT_RC=$?
    echo "$(date -u +%FT%TZ) distill reflect finished (exit $REFLECT_RC)"
    [ "$REFLECT_RC" -gt "$RC" ] && RC="$REFLECT_RC"
  fi

  exit "$RC"
} >> "$LOG_FILE" 2>&1
