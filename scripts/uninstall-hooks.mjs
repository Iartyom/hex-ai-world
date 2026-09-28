#!/usr/bin/env node
/*
 * Removes ONLY the Phase 0 logging hooks this repo added, leaving every other hook
 * (e.g. the RTK PreToolUse hook) untouched. Matches by our exact command string, so
 * it's safe even if you've hand-edited other hooks since installing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hookPath = path.resolve(__dirname, '..', 'hooks', 'hook.js').replace(/\\/g, '/');
const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');

const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
if (!settings.hooks) { console.log('No hooks to remove.'); process.exit(0); }

const isOurs = (h) => typeof h.command === 'string' && h.command.includes(hookPath);
let removed = 0;

for (const event of Object.keys(settings.hooks)) {
  const arr = settings.hooks[event];
  if (!Array.isArray(arr)) continue;
  for (const entry of arr) {
    const before = (entry.hooks || []).length;
    entry.hooks = (entry.hooks || []).filter((h) => !isOurs(h));
    removed += before - entry.hooks.length;
  }
  // Drop now-empty entries, then drop the event key if nothing is left.
  settings.hooks[event] = arr.filter((e) => (e.hooks || []).length > 0);
  if (settings.hooks[event].length === 0) delete settings.hooks[event];
}

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
console.log(`Removed ${removed} Phase 0 hook registration(s). Other hooks left intact.`);
console.log('Restart your Claude Code sessions to apply.');
