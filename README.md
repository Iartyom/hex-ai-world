# Hex-World Agent Visualizer

A local web app that shows live Claude Code activity as a "hex world" — one floating
hex platform per session, robots (agents/subagents) working on each.

## Prerequisite
[Node.js](https://nodejs.org) 18+ (`node -v` to check). On macOS with Homebrew: `brew install node`.

## Run it

**macOS — easiest:**
1. **First time:** double-click **`install-mac.command`** (right-click → **Open** if Gatekeeper
   blocks it). It installs dependencies and offers to install the Claude Code hooks.
2. **Every time after:** double-click **`start-mac.command`** — starts the server and opens your browser.

(If a `.command` won't run, make it executable once: `chmod +x *.command`, or run
`bash install-mac.command` in Terminal.)

**Any OS (Terminal):**
```bash
npm install         # first time only
npm run install-hooks   # optional: enables the live view
npm start           # serves http://localhost:8787
```
Then open **http://localhost:8787**.

- **Preview without live agents:** open **http://localhost:8787/?demo** for a canned scene.
- Press **`d`** in the page to toggle the raw-state panel. Drag to pan, scroll to zoom.

## Live data (hooks)
The live view fills in from Claude Code hook events. Install the hooks once:
```bash
npm run install-hooks     # appends to ~/.claude/settings.json (never replaces existing hooks)
npm run uninstall-hooks   # to remove them
```
Runs on macOS and Windows. It's idempotent — **re-run it after updating** to pick up newly
added events (e.g. `Notification` and `UserPromptSubmit`), then **restart your sessions**.

## Signals on each world
- **Orange glow (bright, pulsing)** — the session needs *you now*: a permission prompt is blocking it.
- **Amber glow (soft)** — the turn ended and it's idle awaiting your input (tooltip: *idle — your turn*).
- **Green glow (calm)** — actively working (main agent or any subagent mid-tool/thinking).
- **⚠ stuck** — a tool has been running with no result for 3+ minutes.
- **Green / red flash** — the turn finished / a tool errored.
- **Floating text over a robot** — the tool it's running right now (or `thinking…`).
- Robots keep their working animation through *thinking*, not just while a tool runs.
- **Hover a robot** for a quick tooltip; **click it** to open the live read-only session mirror.
- **Click a world** to focus/zoom it; **double-click** empty space to reset. Filter box (top) hides
  worlds whose folder/title don't match.

## Config
- **`HEX_WORLD_ANIM`** — animated hex platforms are **off by default** (calm static art). Set the
  env var to `1` when starting the server to switch the animated backdrops on:
  ```bash
  HEX_WORLD_ANIM=1 npm start                 # macOS / Linux
  $env:HEX_WORLD_ANIM=1; npm start           # Windows PowerShell
  ```
  Nothing else changes — the client reads it once at boot from `/config/runtime.json`.
