# Hex-World Agent Visualizer

A local web board for everyone running several Claude Code sessions at once. Each live session is a
floating hex platform; its main agent and every subagent are robots working on it. At a glance you
see **which session needs you**, what each agent is doing right now, and where your time and tokens go —
and you can **answer permission prompts and Claude's questions right from the board**.

Everything runs on your machine. Nothing leaves it: the server listens on `127.0.0.1` only and reads
your local transcripts.

---

## Quick start (5 minutes)

**You need:** [Node.js](https://nodejs.org) 18+ (`node -v`; macOS: `brew install node`) and Claude Code.

```bash
git clone https://github.com/Iartyom/hex-world.git && cd hex-world
npm install              # once
npm run install-hooks    # once: registers the hooks in ~/.claude/settings.json (backs it up first)
npm start                # every time: serves http://localhost:8787
```

1. Open **http://localhost:8787** and keep the tab open.
2. **Restart your Claude Code sessions** — hooks load when a session starts.
3. Work as usual. Platforms appear as soon as each session does something.

No live sessions yet? **http://localhost:8787/?demo** shows a canned scene.

**macOS shortcut:** double-click `install-mac.command` once, then `start-mac.command` every time
(right-click → Open if Gatekeeper blocks it; `chmod +x *.command` if it won't run).

---

## Using the board

### Reading it
| You see | It means |
|---|---|
| **Orange pulsing glow** | The session is **blocked on you** — a permission prompt or a question. |
| **Amber soft glow** | The turn is over; it's your move. |
| **Green calm glow** | Working (a tool is running, or the model is thinking). |
| **⚠ stuck** | A tool has run 3+ minutes with no result. |
| **Green / red flash** | A turn just finished / a tool just errored. |
| **Green text over a robot** | The tool it's running right now (`Bash: npm test`, `thinking…`). |
| **Tab title `(2) Hex-World`** | Two sessions need you. |

Only **live** sessions have a platform: exiting a session removes it at once, and closing its terminal
removes it within seconds (macOS / Linux).

### Moving around
- **Drag** to pan, **scroll** to zoom, **click a platform** to focus it, **double-click** empty space to reset.
- **Filter box** (top left): type part of a folder or title to dim everything else.

### Robots
- **Hover** a robot: title, folder, what it's doing, plus two small graphs for the last 2 hours —
  *activity* (working / thinking / waiting on you) and *cost* per 5 minutes — and session totals.
- **Click** a robot: a live, read-only mirror of that agent's conversation — prompts, replies, diffs,
  commands and their output. A subagent's robot shows *its own* run.
  **Esc** closes it, **Ctrl/⌘+F** searches inside it.

### Answering from the board
When a session asks for permission or asks you a question, a card pops up **next to its platform**:
- **Tool prompts** → **Allow** / **Deny**.
- **Claude's questions** → one question per tab, like in the terminal: click an option or press
  **1–9** (single-choice jumps to the next tab), **←/→** between tabs, type into **Other…** for your own
  answer, then **Send answers** on the **Submit** tab (or Enter).
- **Terminal** → hand it back and answer in the terminal instead.

The card waits until you answer. It gives up by itself (back to the normal terminal prompt) if you answer
in the terminal, the session moves on, or you close the last board tab — so a session can never get
stuck on a card nobody sees. The hook only waits while a board tab is open; without one, the terminal
prompt appears immediately as always.

### The `d` panel — where time and money went
Press **`d`**:
- **Last 14 days, all your Claude Code sessions** (not just live ones): cost, today's cost, active time,
  tool calls, cost per day, and a per-project table with a 14-day sparkline.
- **Live sessions, last 2 hours**: how busy each agent was and **how long they waited on you**.

Costs use Anthropic API list prices (`config/pricing.mjs`). On a Claude subscription read them as
"value used", not your bill. Active time counts gaps under 5 minutes between transcript lines.

### Desktop alerts
On macOS / Linux the server itself raises a notification when a session is blocked on you — it works
even with the browser tab closed.

---

## Configuration
Set these in the environment of `npm start` (Windows PowerShell: `$env:NAME=1; npm start`).

| Variable | Default | Effect |
|---|---|---|
| `HEX_WORLD_ANIM=1` | off | Animated platforms. |
| `HEX_WORLD_NOTIFY=0` | on | Turn off desktop alerts. |
| `HEX_WORLD_PERMISSION_WAIT=<s>` | no limit | Cap how long a board card may hold a prompt. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where Claude Code keeps transcripts (same variable Claude Code uses). |

---

## Docker (optional)
Runs the **server** in a container (no `npm install`, restarts on its own). The **hooks still run on your
machine** — Claude Code runs them there — so you still need Node on the host for them.

```bash
node scripts/install-hooks.mjs   # on the host, once (needs Node, no npm install)
docker compose up -d             # → http://localhost:8787
docker compose down              # stop (saved sessions stay in the volume)
```

What's different in Docker: the container can't see your `claude` processes or show macOS
notifications, so **closed terminals aren't detected** (platforms leave on a normal exit, or after 12h)
and **desktop alerts are off** (the browser tab still notifies). For the full experience use `npm start`.
The port is published on `127.0.0.1` only, and `~/.claude` is mounted read-only.

---

## Troubleshooting
- **Board is empty** — did you restart the Claude Code sessions after `npm run install-hooks`? Is the
  server running (`npm start`)? Hooks talk to `127.0.0.1:8787`.
- **"disconnected" banner** — the server stopped; the page reconnects by itself when it's back.
- **A platform for a session I closed** — on Windows / Docker only normal exits are detected; it goes
  after 12h of silence.
- **Hook log** — every event is appended to `hooks/agent-events.jsonl` (rotates at 20 MB).
  `npm run replay` feeds it back into a running server for offline development.

## Uninstall
```bash
npm run uninstall-hooks   # removes only this project's hooks; others (e.g. sound hooks) stay
```
Your previous settings are also kept as `~/.claude/settings.json.bak-<timestamp>`.

## Development
```bash
npm test        # node:test — state machine, pricing, charts, spacing sim, HTTP/WebSocket integration
```
Layout: `hooks/hook.js` (the hook, zero dependencies) → `server/server.mjs` (HTTP/WebSocket, fs) →
`server/state.mjs` (pure logic, unit-tested) → `public/` (Pixi board, mirror, charts). Shared tables
live in `config/` (tools, behaviors, pricing, worlds, units, theme).
