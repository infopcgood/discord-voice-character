#!/usr/bin/env bash
set -euo pipefail

# Resolve project files relative to this script, even when launched elsewhere.
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Install Node.js 24 (with npm), then run ./start.sh again.' >&2
  exit 1
fi

node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 12)) {
    console.error("Node.js 22.12.0 or newer is required. Node.js 24 is recommended.");
    process.exit(1);
  }
'

if ! command -v npm >/dev/null 2>&1; then
  printf '%s\n' 'npm is missing. Install npm with Node.js, then run ./start.sh again.' >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  (umask 077; cp .env.example .env)
  printf '%s\n' \
    'Created .env. Fill in the Discord, OpenAI, and Strata settings, save it,' \
    'then run ./start.sh again. You can edit it with: nano .env'
  exit 0
fi

# Repair missing or outdated dependencies as well as fresh installations.
if ! npm ls --depth=0 >/dev/null 2>&1; then
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi
fi

npm run check
npm run register

printf '%s\n' 'Starting the bot. Press Ctrl+C to stop.'
# Replace the shell so SIGINT/SIGTERM reach the bot directly.
exec node src/bot.js
