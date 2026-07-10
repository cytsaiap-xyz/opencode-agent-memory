#!/usr/bin/env bash
# agent-memory collector installer
#
# Builds the collector plugin and installs it globally into
# ${XDG_CONFIG_HOME:-~/.config}/opencode/plugins/ .
#
# Usage:
#   ./scripts/install.sh                 # global install
#   ./scripts/install.sh --name <f.js>   # override installed filename
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
PLUGIN_NAME="agent-memory-collector.js"

while [ $# -gt 0 ]; do
  case "$1" in
    --name)
      shift
      [ $# -gt 0 ] || { echo "error: --name needs a value" >&2; exit 1; }
      PLUGIN_NAME="$1"
      ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "error: unknown flag $1" >&2; exit 1 ;;
  esac
  shift
done

command -v bun >/dev/null 2>&1 || { echo "error: bun is required (https://bun.sh)" >&2; exit 1; }
case "$PLUGIN_NAME" in *.js) ;; *) echo "error: --name must end in .js" >&2; exit 1 ;; esac

echo "==> Building agent-memory collector"
cd "$REPO_DIR"
[ -d node_modules ] || bun install
bun run build >/dev/null
[ -f dist/agent-memory-collector.js ] || { echo "error: build produced no bundle" >&2; exit 1; }

PLUGINS_DIR="$CONFIG_DIR/plugins"
DEST="$PLUGINS_DIR/$PLUGIN_NAME"
echo "==> Installing -> $DEST"
mkdir -p "$PLUGINS_DIR"
cp dist/agent-memory-collector.js "$DEST"

# Trap check: a package.json in the plugins dir whose "main" doesn't resolve
# silently disables EVERY flat plugin in this directory (root-caused 2026-07-10).
PKG_JSON="$PLUGINS_DIR/package.json"
if [ -f "$PKG_JSON" ]; then
  BROKEN_MAIN=$(bun -e '
    try {
      const fs = require("node:fs"), path = require("node:path")
      const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
      if (pkg.main && !fs.existsSync(path.join(path.dirname(process.argv[1]), pkg.main))) console.log(pkg.main)
    } catch {}
  ' "$PKG_JSON")
  if [ -n "$BROKEN_MAIN" ]; then
    printf '\033[31m✗ WARNING:\033[0m %s\n' "$PKG_JSON has \"main\": \"$BROKEN_MAIN\" pointing at a missing file."
    printf '  %s\n' "This silently disables EVERY plugin in $PLUGINS_DIR (including this one)."
    printf '  %s\n' "Fix: remove the \"main\" field (back it up first), then restart opencode."
  fi
fi

cat <<EOF

Done. Next steps:
  1. Restart opencode.
  2. Transcripts appear under \${AGENT_MEMORY_HOME:-~/.agent-memory}/transcripts/
     after a session goes idle; check ~/.agent-memory/collector.log.
  3. Export history once: bun $REPO_DIR/collector/backfill.ts
EOF
