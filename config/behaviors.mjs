/*
 * SINGLE SOURCE OF TRUTH for how raw Claude Code activity maps to (a) coarse
 * categories and (b) character/world behaviors. Built to scale + alter later:
 * to support a new tool or a new animation you edit ONLY this file — the server
 * and (Phase 2+) the render engine both read from here, nothing is hard-coded
 * elsewhere.
 *
 * Contract for downstream code: the KEYS below are the stable vocabulary
 * (e.g. "working:shell", "idle", "dormant"). Swap the VALUES (animation names)
 * freely as the art evolves; keep the keys stable so the spine and engine agree.
 */

// --- tool_name -> coarse category (server computes worker state = "working:<category>") ---
export const TOOL_CATEGORY = {
  Bash: 'shell', PowerShell: 'shell',
  Edit: 'edit', Write: 'edit', NotebookEdit: 'edit',
  Read: 'read', Glob: 'read', Grep: 'read',
  Agent: 'spawn', Task: 'spawn',       // spawning a subagent
  WebFetch: 'web', WebSearch: 'web',
};
export const DEFAULT_CATEGORY = 'tool';           // any unmapped tool
export function categoryFor(tool) { return TOOL_CATEGORY[tool] || DEFAULT_CATEGORY; }

// --- WORKER behavior: what a unit DOES for a given worker state ---
// Theme: futuristic StarCraft-style. A worker is a harvesting/utility unit.
// Phase 2 uses these as placeholder-motion keys; Phase 3 maps them to PixelLab clips.
// (Keys are the stable contract; these sci-fi VALUES are the animation names.)
export const WORKER_BEHAVIOR = {
  'working:shell': 'harvest',  // Bash/PowerShell — mine crystals with a laser cutter
  'working:edit':  'weld',     // Edit/Write      — weld/construct, sparks flying
  'working:read':  'scan',     // Read/Grep/Glob  — sweep a scanner over a console
  'working:spawn': 'warp',     // Agent/Task      — warp-in a new unit (spawn subagent)
  'working:web':   'uplink',   // WebFetch/Search — satellite/comms uplink beam
  'working:tool':  'operate',  // any other tool  — generic panel operation
  'idle':          'standby',  // ALIVE, waiting on the model — hover in standby ("awaiting orders")
};
export const DEFAULT_WORKER_BEHAVIOR = 'operate';
export function workerBehaviorFor(state) { return WORKER_BEHAVIOR[state] || DEFAULT_WORKER_BEHAVIOR; }

// --- WORLD behavior: the whole session/base mood ---
export const WORLD_BEHAVIOR = {
  active:   'online',     // base powered up, units working
  dormant:  'powerdown',  // session ended or quiet — base dimmed, units in standby pods
};
export function worldBehaviorFor(status) { return WORLD_BEHAVIOR[status] || 'powerdown'; }
