#!/bin/bash
# Hex-World Agent Visualizer — macOS one-time installer.
# Double-click in Finder (first time: right-click → Open if Gatekeeper blocks it),
# or in Terminal:  bash install-mac.command
# Installs dependencies and (optionally) the Claude Code hooks that feed the live view.

cd "$(dirname "$0")" || exit 1

echo "──────────────────────────────────────────────"
echo " Hex-World — installer"
echo "──────────────────────────────────────────────"

# 1) Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js not found."
  echo "  Install it from https://nodejs.org  (or, with Homebrew:  brew install node)"
  echo "  Then run this installer again."
  read -r -p "Press Return to close…"
  exit 1
fi
echo "✓ Node.js $(node -v)"

# 2) Dependencies
echo "Installing dependencies (first run takes a minute)…"
if ! npm install; then
  echo "✗ npm install failed — see the errors above."
  read -r -p "Press Return to close…"
  exit 1
fi
echo "✓ Dependencies installed"

# 3) Make the launchers double-clickable
chmod +x start-mac.command install-mac.command 2>/dev/null || true

# 4) Claude Code hooks (optional — needed for the LIVE view; ?demo works without them)
printf "Install Claude Code hooks now? They feed the live view. [Y/n] "
read -r ans
case "$ans" in
  [Nn]*)
    echo "• Skipped. Install later with:  npm run install-hooks"
    ;;
  *)
    if npm run install-hooks; then
      echo "✓ Hooks installed — RESTART any running Claude Code sessions so they load."
    else
      echo "! Hook install didn't complete (is Claude Code installed? ~/.claude/settings.json missing)."
      echo "  Retry later with:  npm run install-hooks"
    fi
    ;;
esac

echo "──────────────────────────────────────────────"
echo " Done. Start it by double-clicking  start-mac.command"
echo " (or run:  npm start  → then open http://localhost:8787 )"
echo "──────────────────────────────────────────────"
read -r -p "Press Return to close…"
