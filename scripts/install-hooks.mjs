#!/usr/bin/env node
/*
 * OS-aware installer for the Phase 0 hook spike.
 *
 * WHY this exists: the BUILD runbook uses a hand-edited ~/.claude/settings.json, but
 * we must (a) work on Mac + Windows and (b) NOT clobber the existing RTK PreToolUse
 * hook already registered on this machine. So we read settings.json, back it up, and
 * APPEND our logging registrations idempotently, leaving every existing hook intact.
 *
 * Registers `node <repo>/hooks/hook.js <EventName>` for the six lifecycle events the
 * runbook wants to observe. Run again safely — it de-dupes by command string.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Absolute path to hook.js, forward-slashed so it's shell-safe on Windows too.
const hookPath = path.resolve(__dirname, '..', 'hooks', 'hook.js').replace(/\\/g, '/');
const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');

// The lifecycle events we observe. Tool events get matcher:"" (all tools); lifecycle
// events omit the matcher. We add our entries ALONGSIDE anything already registered.
// `Notification` is the ONLY event Claude Code fires when it's blocked on the human
// (permission prompt or idle-awaiting-input) — it powers the "needs you" world glow.
const EVENTS = [
  { event: 'SessionStart', tool: false },
  { event: 'PreToolUse', tool: true },
  { event: 'PostToolUse', tool: true },
  { event: 'SubagentStop', tool: false },
  { event: 'Stop', tool: false },
  { event: 'SessionEnd', tool: false },
  { event: 'Notification', tool: false },     // → "needs you" attention state
  { event: 'UserPromptSubmit', tool: false }, // → turn start, so the unit works while Claude thinks (not just while a tool runs)
  // → Allow/Deny / answer questions from the board. It holds only while a board tab is open, until you
  // answer (or press Terminal, or answer in the terminal); with no board it returns at once.
  // timeout (s) = Claude Code's outer bound on the hold.
  { event: 'PermissionRequest', tool: true, timeout: 86400 },
];

function cmdFor(event) {
  return `node "${hookPath}" ${event}`;
}

if (!fs.existsSync(settingsPath)) {
  console.error(`No settings.json at ${settingsPath} — is Claude Code installed for this user?`);
  process.exit(1);
}

const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

// Timestamped backup so uninstall / manual recovery is always possible.
const backup = `${settingsPath}.bak-${Date.now()}`;
fs.writeFileSync(backup, JSON.stringify(settings, null, 2));

settings.hooks = settings.hooks || {};
let added = 0;
let skipped = 0;
let updated = 0;

for (const { event, tool, timeout } of EVENTS) {
  const command = cmdFor(event);
  const arr = (settings.hooks[event] = settings.hooks[event] || []);
  // Idempotent: skip if any existing entry already runs our exact command.
  const mine = arr.flatMap((entry) => entry.hooks || []).find((h) => h.command === command);
  if (mine) {                                   // already registered: just bring its timeout up to date
    if (timeout && mine.timeout !== timeout) { mine.timeout = timeout; updated++; } else skipped++;
    continue;
  }
  const entry = { hooks: [{ type: 'command', command, ...(timeout ? { timeout } : {}) }] };
  if (tool) entry.matcher = ''; // empty matcher = all tools
  arr.push(entry);
  added++;
}

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

console.log(`Hook: ${hookPath}`);
console.log(`Settings: ${settingsPath}`);
console.log(`Backup:  ${backup}`);
console.log(`Registered ${added} new hook(s), updated ${updated}, ${skipped} already present.`);
console.log(`Log file will be: ${path.resolve(__dirname, '..', 'hooks', 'agent-events.jsonl')}`);
console.log('\nRestart your Claude Code sessions so the new hooks load.');
