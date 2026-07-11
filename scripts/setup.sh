#!/usr/bin/env bash
# agent-memory one-shot setup
#
# Does everything needed on a fresh machine, idempotently:
#   1. Build + install the collector plugin (global opencode plugins dir)
#   2. Register the MCP server in the global opencode.json (merge, never clobber)
#   3. (--backfill)                  Export all historical sessions once
#   4. (--schedule "<cron>")         Install a crontab entry for the nightly distill
#   5. (--schedule-reflect "<cron>") Install a SECOND crontab entry that runs
#      ONLY `distill reflect` (via `run-distill.sh --reflect-only`) — schedule
#      it independently of (and typically less frequently than) the distill run,
#      e.g. weekly, since reflect consolidates across sessions already distilled.
#
# Usage:
#   ./scripts/setup.sh                          # steps 1+2 only
#   ./scripts/setup.sh --backfill               # + historical export
#   ./scripts/setup.sh --schedule "0 3 * * *"   # + nightly distill at 03:00
#   ./scripts/setup.sh --schedule-reflect "0 4 * * 0"   # + weekly reflect at Sun 04:00
#   ./scripts/setup.sh --backfill --schedule "0 3 * * *" --schedule-reflect "0 4 * * 0"
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
OPENCODE_JSON="$CONFIG_DIR/opencode.json"
CRON_MARKER="# agent-memory-distill"
REFLECT_CRON_MARKER="# agent-memory-reflect"

BACKFILL=0
SCHEDULE=""
SCHEDULE_REFLECT=""

usage() { sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --backfill) BACKFILL=1 ;;
    --schedule)
      shift
      [ $# -gt 0 ] || { echo "error: --schedule needs a cron expression (e.g. \"0 3 * * *\")" >&2; exit 1; }
      SCHEDULE="$1"
      ;;
    --schedule-reflect)
      shift
      [ $# -gt 0 ] || { echo "error: --schedule-reflect needs a cron expression (e.g. \"0 4 * * 0\")" >&2; exit 1; }
      SCHEDULE_REFLECT="$1"
      ;;
    -h|--help) usage 0 ;;
    *) echo "error: unknown flag $1" >&2; usage 1 ;;
  esac
  shift
done

# Installs (or replaces, keyed on the trailing marker comment) one crontab
# line — same "read, drop old marked line if present, append new one"
# semantics for both the distill and reflect schedules, so reruns are always
# safe and each schedule can be updated independently.
install_cron_line() {
  local marker="$1" line="$2" label="$3"
  local existing
  existing="$(crontab -l 2>/dev/null || true)"
  if printf '%s\n' "$existing" | grep -qF "$marker"; then
    printf '%s\n' "$existing" | grep -vF "$marker" | { cat; echo "$line"; } | crontab -
    echo "replaced existing $label cron entry"
  else
    { printf '%s\n' "$existing"; echo "$line"; } | sed '/^$/d' | crontab -
    echo "installed $label cron entry"
  fi
}

command -v bun >/dev/null 2>&1 || { echo "error: bun is required (https://bun.sh)" >&2; exit 1; }

echo "==> [1/4] Collector plugin"
"$REPO_DIR/scripts/install.sh"

echo ""
echo "==> [2/4] MCP server registration ($OPENCODE_JSON)"
mkdir -p "$CONFIG_DIR"
REPO_DIR="$REPO_DIR" OPENCODE_JSON="$OPENCODE_JSON" bun -e '
  const fs = require("node:fs")
  const path = process.env.OPENCODE_JSON
  const entry = {
    enabled: true,
    type: "local",
    command: ["bun", `${process.env.REPO_DIR}/mcp-server/main.ts`],
  }
  let cfg = { $schema: "https://opencode.ai/config.json" }
  if (fs.existsSync(path)) {
    try {
      cfg = JSON.parse(fs.readFileSync(path, "utf8"))
    } catch (e) {
      // Never clobber a config we cannot parse — the user must fix it first.
      console.error(`error: ${path} exists but is not valid JSON (${e.message}); fix it manually first`)
      process.exit(1)
    }
  }
  if (typeof cfg.mcp !== "object" || cfg.mcp === null) cfg.mcp = {}
  const existing = cfg.mcp["agent-memory"]
  if (existing && JSON.stringify(existing) === JSON.stringify(entry)) {
    console.log("already registered — no change")
    process.exit(0)
  }
  cfg.mcp["agent-memory"] = entry
  fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n")
  console.log(existing ? "updated existing agent-memory entry" : "registered agent-memory MCP server")
'

echo ""
if [ "$BACKFILL" = "1" ]; then
  echo "==> [3/4] Backfill historical sessions"
  (cd "$REPO_DIR" && bun collector/backfill.ts)
else
  echo "==> [3/4] Backfill skipped (run with --backfill, or later: bun $REPO_DIR/collector/backfill.ts)"
fi

echo ""
if [ -n "$SCHEDULE" ] || [ -n "$SCHEDULE_REFLECT" ]; then
  if [ "$(uname)" = "Darwin" ]; then
    printf '\033[33mnote:\033[0m %s\n' "macOS TCC may block cron from reading this repo if it lives under Documents/Desktop."
    printf '      %s\n' "If the log shows permission errors, grant cron Full Disk Access or move the repo."
  fi
fi

if [ -n "$SCHEDULE" ]; then
  echo "==> [4/5] Cron schedule (distill run): $SCHEDULE"
  install_cron_line "$CRON_MARKER" "$SCHEDULE $REPO_DIR/scripts/run-distill.sh $CRON_MARKER" "distill"
  echo "log: \${AGENT_MEMORY_HOME:-~/.agent-memory}/distill.log"
else
  echo "==> [4/5] Distill schedule skipped (run with --schedule \"0 3 * * *\", or add cron/systemd manually calling scripts/run-distill.sh)"
fi

echo ""
if [ -n "$SCHEDULE_REFLECT" ]; then
  echo "==> [5/5] Cron schedule (reflect only): $SCHEDULE_REFLECT"
  install_cron_line "$REFLECT_CRON_MARKER" "$SCHEDULE_REFLECT $REPO_DIR/scripts/run-distill.sh --reflect-only $REFLECT_CRON_MARKER" "reflect"
  echo "log: \${AGENT_MEMORY_HOME:-~/.agent-memory}/distill.log (shared with distill run)"
else
  echo "==> [5/5] Reflect schedule skipped (run with --schedule-reflect \"0 4 * * 0\", or add cron/systemd manually calling scripts/run-distill.sh --reflect-only)"
fi

cat <<EOF

Done. Next steps:
  1. Restart opencode — collector plugin + agent-memory MCP tools load globally.
  2. Transcripts:  \${AGENT_MEMORY_HOME:-~/.agent-memory}/transcripts/
     Memories:     \${AGENT_MEMORY_HOME:-~/.agent-memory}/store/memories/
  3. Manual distill anytime:  bun $REPO_DIR/distiller/cli.ts run
     Review queue:            bun $REPO_DIR/distiller/cli.ts review
     Probe without an agent:  (cd $REPO_DIR && bun run mcp:probe --stats)
  4. Production LLM: export AGENT_MEMORY_LLM=vllm AGENT_MEMORY_VLLM_URL=... AGENT_MEMORY_VLLM_MODEL=...
     (default backend shells out to \`opencode run\`)
  5. Cross-session reflect (try --dry-run first!):
       bun $REPO_DIR/distiller/cli.ts reflect --dry-run
       bun $REPO_DIR/distiller/cli.ts reflect
     Schedule it independently: ./scripts/setup.sh --schedule-reflect "0 4 * * 0"
EOF
