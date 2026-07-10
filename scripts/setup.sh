#!/usr/bin/env bash
# agent-memory one-shot setup
#
# Does everything needed on a fresh machine, idempotently:
#   1. Build + install the collector plugin (global opencode plugins dir)
#   2. Register the MCP server in the global opencode.json (merge, never clobber)
#   3. (--backfill)          Export all historical sessions once
#   4. (--schedule "<cron>") Install a crontab entry for the nightly distill
#
# Usage:
#   ./scripts/setup.sh                          # steps 1+2 only
#   ./scripts/setup.sh --backfill               # + historical export
#   ./scripts/setup.sh --schedule "0 3 * * *"   # + nightly distill at 03:00
#   ./scripts/setup.sh --backfill --schedule "0 3 * * *"
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
OPENCODE_JSON="$CONFIG_DIR/opencode.json"
CRON_MARKER="# agent-memory-distill"

BACKFILL=0
SCHEDULE=""

usage() { sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --backfill) BACKFILL=1 ;;
    --schedule)
      shift
      [ $# -gt 0 ] || { echo "error: --schedule needs a cron expression (e.g. \"0 3 * * *\")" >&2; exit 1; }
      SCHEDULE="$1"
      ;;
    -h|--help) usage 0 ;;
    *) echo "error: unknown flag $1" >&2; usage 1 ;;
  esac
  shift
done

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
if [ -n "$SCHEDULE" ]; then
  echo "==> [4/4] Cron schedule: $SCHEDULE"
  if [ "$(uname)" = "Darwin" ]; then
    printf '\033[33mnote:\033[0m %s\n' "macOS TCC may block cron from reading this repo if it lives under Documents/Desktop."
    printf '      %s\n' "If the log shows permission errors, grant cron Full Disk Access or move the repo."
  fi
  CRON_LINE="$SCHEDULE $REPO_DIR/scripts/run-distill.sh $CRON_MARKER"
  EXISTING="$(crontab -l 2>/dev/null || true)"
  if printf '%s\n' "$EXISTING" | grep -qF "$CRON_MARKER"; then
    # Replace the existing marked line (schedule may have changed).
    printf '%s\n' "$EXISTING" | grep -vF "$CRON_MARKER" | { cat; echo "$CRON_LINE"; } | crontab -
    echo "replaced existing agent-memory cron entry"
  else
    { printf '%s\n' "$EXISTING"; echo "$CRON_LINE"; } | sed '/^$/d' | crontab -
    echo "installed cron entry"
  fi
  echo "log: \${AGENT_MEMORY_HOME:-~/.agent-memory}/distill.log"
else
  echo "==> [4/4] Schedule skipped (run with --schedule \"0 3 * * *\", or add cron/systemd manually calling scripts/run-distill.sh)"
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
EOF
