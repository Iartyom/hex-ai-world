#!/bin/bash
# Hex-World Agent Visualizer — macOS launcher.
# Double-click this file in Finder to run. (If blocked: right-click → Open.)
# For first-time setup incl. Claude Code hooks, run install-mac.command instead.

cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required but not found."
  echo "Install it from https://nodejs.org  (or, with Homebrew:  brew install node)"
  echo "Then run this again."
  read -r -p "Press Return to close…"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Dependencies not installed — running setup…"
  npm install || { echo "npm install failed. Try install-mac.command."; read -r -p "Press Return to close…"; exit 1; }
fi

URL="http://localhost:8787"
# Open the browser a moment after the server starts listening.
( sleep 1; open "$URL" ) >/dev/null 2>&1 &

echo "──────────────────────────────────────────────"
echo " Hex-World running at $URL"
echo " • Live view fills in as Claude Code sessions run (run install-mac.command for hooks)."
echo " • Preview without live agents:  $URL/?demo"
echo " • Press Ctrl+C here to stop."
echo "──────────────────────────────────────────────"
node server/server.mjs
