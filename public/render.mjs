/*
 * Render layer — consumes the server's full-state messages and diffs them onto a Pixi scene:
 *   world  -> a floating hex platform (config/worlds.mjs art; dims when dormant)
 *   main + each subagent -> an animated robot wandering the platform (config/units.mjs)
 * If art fails to load it falls back to placeholder shapes animated by config/theme.mjs MOTION.
 */
import { Application, Container, Graphics, Text, Sprite, AnimatedSprite, Assets, Ellipse, Texture, Rectangle } from '/vendor/pixi.min.mjs';
import { WORKER_BEHAVIOR, DEFAULT_WORKER_BEHAVIOR } from '/config/behaviors.mjs';
import {
  CATEGORY_COLOR, IDLE_COLOR, DEFAULT_ACCENT, MOTION, DEFAULT_MOTION,
} from '/config/theme.mjs';
import { WORLDS, worldFramePath } from '/config/worlds.mjs';
import { UNIT, dirFromAngle, framePath, NEAREST_CARDINAL } from '/config/units.mjs';
import { axialToPixel, spiralCells, hexCorners } from './hexgrid.mjs';
import { openMirror, mirrorActive, revealMirror } from './terminal.mjs';
import { esc, baseName, tickerText } from './pure.mjs';
import { flagsOf } from '/config/quality.mjs';
import { stackedBars, stateLegend, STATE_COLORS, fmtDur, fmtTok, CTX_HEAVY } from './charts.mjs';
import { makeWorldAllocator, makeCellAllocator } from './alloc.mjs';
import { makeFloor, makeSpacing } from './floor.mjs';

const HEX_SIZE = 64;       // fallback placeholder hex size (used only if a world image is missing)
const LAYOUT_SIZE = 200;   // hex-grid spacing between bases — tighter so the islands cluster closer together
const WORLD_W = 320;       // on-screen width every world backdrop is normalized to
const BG = 0x0b0e14;

// state string ("working:shell" | "idle") -> behavior name / accent color / motion
const behaviorName = (s) => WORKER_BEHAVIOR[s] || DEFAULT_WORKER_BEHAVIOR;
const motionFor = (s) => MOTION[behaviorName(s)] || DEFAULT_MOTION;
function accentFor(s) {
  if (!s || s === 'idle') return IDLE_COLOR;
  return CATEGORY_COLOR[s.split(':')[1]] || DEFAULT_ACCENT;
}

export async function startBoard(mountEl) {
  const app = new Application();
  await app.init({ background: BG, antialias: true, resizeTo: window });
  (mountEl || document.body).appendChild(app.canvas);

  // --- deep-space starfield: a dim, gently twinkling backdrop BEHIND the worlds. It lives in
  // screen space (not in `board`), so it stays fixed like a skybox as you pan/zoom the worlds. ---
  const space = new Container();
  space.eventMode = 'none';                 // never intercept clicks meant for worlds/robots
  app.stage.addChild(space);
  const stars = [];
  function buildStars() {
    for (const c of space.removeChildren()) c.destroy(); stars.length = 0;
    const w = app.screen.width, h = app.screen.height;
    const n = Math.min(420, Math.round((w * h) / 6500)); // density scales with viewport, capped
    for (let i = 0; i < n; i++) {
      const big = Math.random() < 0.12;
      const r = big ? 1.3 + Math.random() * 1.0 : 0.5 + Math.random() * 0.9;
      const tint = Math.random() < 0.16 ? 0x9fb8ff : (Math.random() < 0.16 ? 0xffe3bd : 0xffffff); // faint blue/warm variance
      const g = new Graphics();
      g.circle(0, 0, r).fill(tint);
      g.x = Math.random() * w; g.y = Math.random() * h;
      const base = 0.10 + Math.random() * 0.32;         // dimmed
      g.alpha = base;
      space.addChild(g);
      stars.push({ g, base, amp: 0.35 + Math.random() * 0.5, speed: 0.0006 + Math.random() * 0.0018,
        phase: Math.random() * Math.PI * 2, twinkle: Math.random() < 0.65 });
    }
  }
  buildStars();
  window.addEventListener('resize', buildStars);

  const board = new Container();
  app.stage.addChild(board);              // worlds render ON TOP of the starfield

  // --- camera: drag to pan, wheel to zoom toward the cursor ---
  // The ticker positions the board at screen-center + cam offset, scaled by cam.zoom.
  const cam = { x: 0, y: 0, zoom: 1 };
  const MIN_ZOOM = 0.2, MAX_ZOOM = 4;
  // camAnim: a smooth-focus goal the ticker eases toward; any manual pan/zoom cancels it.
  // Click a world to focus it (feature #5); double-click empty space to reset.
  let camAnim = null;
  const FOCUS_ZOOM = 1.8;
  function focusOn(container) {
    camAnim = { x: -container.position.x * FOCUS_ZOOM, y: -container._homeY * FOCUS_ZOOM, zoom: FOCUS_ZOOM };
  }
  function resetCam() { camAnim = { x: 0, y: 0, zoom: 1 }; }
  {
    const canvas = app.canvas;
    let dragging = false, lastX = 0, lastY = 0;
    canvas.style.cursor = 'grab';
    canvas.addEventListener('pointerdown', (e) => {
      dragging = true; lastX = e.clientX; lastY = e.clientY; camAnim = null; // manual input wins
      canvas.style.cursor = 'grabbing'; try { canvas.setPointerCapture(e.pointerId); } catch { /* older */ }
    });
    canvas.addEventListener('dblclick', () => resetCam()); // double-click empty space → reset view
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      cam.x += e.clientX - lastX; cam.y += e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
    });
    const endDrag = (e) => { dragging = false; canvas.style.cursor = 'grab'; try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ } };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const cx = app.screen.width / 2, cy = app.screen.height / 2;
      // world point under the cursor stays fixed across the zoom
      const wx = (sx - cx - cam.x) / cam.zoom, wy = (sy - cy - cam.y) / cam.zoom;
      cam.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.zoom * Math.exp(-e.deltaY * 0.0015)));
      cam.x = sx - cx - wx * cam.zoom; cam.y = sy - cy - wy * cam.zoom;
    }, { passive: false });
  }

  // --- lightweight hover tooltip: title · folder · what it's doing right now. The deep view is
  //     the click-opened live mirror (terminal.mjs); hover is just a quick glance. ---
  const sessionMeta = new Map();               // sid -> { cwd, title }
  const tipStyle = document.createElement('style');
  tipStyle.textContent = `
    .hw-tip{position:fixed;display:none;z-index:60;pointer-events:none;max-width:340px;
      background:#0c111b;border:1px solid #243044;border-radius:9px;padding:7px 11px;
      box-shadow:0 12px 34px rgba(0,0,0,.6);
      font:11.5px/1.45 ui-monospace,Menlo,Consolas,monospace;color:#cdd3e0}
    .hw-tip .t{color:#eaeef6;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .hw-tip .p{color:#5a6577;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .hw-tip .a{margin-top:3px;color:#a9c187;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .hw-tip .a.think{color:#8b94a8;font-style:italic}
    .hw-tip .a.idle{color:#6b7488}
    .hw-tip .a.need{color:#ffcf4d;font-weight:700}
    .hw-tip .hint{margin-top:4px;color:#465067;font-size:10.5px}
    .hw-tip .g{margin-top:7px}
    .hw-tip .gl{display:flex;justify-content:space-between;gap:10px;color:#8b94a8;font-size:10.5px;margin-bottom:2px}
    .hw-tip .gl b{color:#cdd3e0;font-weight:600}
    .hw-tip .ax{display:flex;justify-content:space-between;color:#465067;font-size:9.5px}
    .hw-tip .tot{margin-top:6px;color:#8b94a8;font-size:10.5px}
    .hw-tip .tot b{color:#cdd3e0;font-weight:600}
    .hw-tip .lgs{display:flex;gap:9px;color:#8b94a8;font-size:10px;margin-top:2px}
    .hw-tip .lg{display:inline-flex;align-items:center;gap:4px}
    .hw-tip .lg i{width:8px;height:8px;border-radius:2px;display:inline-block}
    .hw-tip .ctx{margin-top:6px;display:flex;justify-content:space-between;gap:10px}
    .hw-tip .ctx b{color:#eaeef6;font-weight:600}
    .hw-tip .warn{margin-top:2px;color:#e0b050;font-size:10.5px;white-space:normal}
  `;
  document.head.appendChild(tipStyle);
  const tip = document.createElement('div'); tip.className = 'hw-tip';
  document.body.appendChild(tip);
  let hoveredSid = null;

  // Per-session stats for the tooltip graphs, fetched lazily on hover (not in every broadcast).
  const statsCache = new Map();                // sid -> { at, data }
  let tipArgs = null;                          // what the tip currently shows, so a late fetch can refresh it
  function loadStats(sid) {
    const hit = statsCache.get(sid);
    if (hit && performance.now() - hit.at < 5000) return;
    statsCache.set(sid, { at: performance.now(), data: hit && hit.data });   // mark in-flight
    fetch(`/stats?session=${encodeURIComponent(sid)}`).then((r) => (r.ok ? r.json() : null)).then((data) => {
      statsCache.set(sid, { at: performance.now(), data });
      if (tipArgs && tipArgs[0] === sid && tip.style.display === 'block') showTip(...tipArgs);
    }).catch(() => {});
  }
  function statsHtml(sid) {
    const d = statsCache.get(sid)?.data;
    if (!d) return '';
    const { timeline: tl } = d;
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    const ax = '<div class="ax"><span>−2h</span><span>now</span></div>';
    // What the agent spent the last 2h doing (sampled by the server); empty space = idle / server off.
    const layers = ['working', 'thinking', 'blocked'].map((k) => ({ values: tl[k], color: STATE_COLORS[k] }));
    const tracked = sum(tl.working) + sum(tl.thinking) + sum(tl.blocked) + sum(tl.idle);
    const busyPct = tracked ? Math.round(100 * (sum(tl.working) + sum(tl.thinking)) / tracked) : 0;
    // What to do about THIS session's quality, from Anthropic's Claude Code best practices — only the
    // flags that apply. Context size is shown, not judged: no published threshold says where Opus degrades.
    const q = d.quality || {}, on = flagsOf(q), flags = [];
    // Each flag: what's wrong, then exactly what to type (in quotes / as a command).
    if (on.corrections) flags.push(`You corrected it ${q.corrections}× in your last ${q.recentPrompts} prompts — its context is now full of failed attempts. Type /clear, then restate the task with what you learned.`);
    if (on.uncheckedEdits) flags.push(`${q.uncheckedEdits} edits not verified yet. Tell it: “run the tests and lint for what you changed, and fix any failures.”`);
    if (on.branches) flags.push(`${q.branches} git branches in this session — unrelated tasks are mixing in one context. Before the next task, /clear or open a new session.`);
    if (on.compactions) flags.push(`Compacted ${q.compactions}× — it remembers earlier work only as summaries. For a new task, start a fresh session.`);
    const age = d.startTs ? Date.now() - d.startTs : 0;
    const ctxHtml = d.ctx ? `<div class="ctx"><span>context <b>${fmtTok(d.ctx)}</b>${d.ctx >= CTX_HEAVY ? ' <span class="warn" style="display:inline">· large</span>' : ''}</span>`
      + `<span>${age > 86_400_000 ? `running <b>${Math.floor(age / 86_400_000)}d</b>` : q.uncheckedEdits ? `<b>${q.uncheckedEdits}</b> unchecked edit${q.uncheckedEdits === 1 ? '' : 's'}` : 'checked ✓'}</span></div>` : '';
    return ctxHtml + flags.map((f) => `<div class="warn">⚠ ${esc(f)}</div>`).join('')
      + `<div class="g"><div class="gl"><span>activity · 5-min</span><b>${tracked ? `${busyPct}% busy · ${fmtDur(sum(tl.blocked))} waiting on you` : 'no samples yet'}</b></div>`
      + `${stackedBars(layers, tl.step, { w: 230, h: 22 })}${ax}<div class="lgs">${stateLegend()}</div></div>`
      + `<div class="tot">${d.tools} tools · ${fmtDur(d.activeMs)} active`
      + `${d.subagents ? ` · ${d.subagents} subagent${d.subagents === 1 ? '' : 's'}` : ''}${q.compactions ? ` · compacted ${q.compactions}×` : ''}</div>`;
  }

  function hideTip() { tip.style.display = 'none'; tipArgs = null; }
  // Compact tooltip near the robot: title, folder, and its current activity (or "needs you").
  function showTip(sid, agent, unit) {
    const meta = sessionMeta.get(sid) || {};
    const b = bases.get(sid);
    const attn = b && b.container._attention;            // 'waiting' | 'permission' | null
    const st = unit._state || 'idle';
    let cls = 'idle', act = 'idle';
    // Only a permission prompt is truly "waiting for you"; an idle prompt just means the turn ended
    // and it's your move — Claude Code fires idle_prompt ~60s after any finish, blocked or not, so
    // calling it "waiting" was a lie every time a turn simply completed.
    if (attn) { cls = 'need'; act = attn === 'permission' ? '● needs you — permission' : '● idle — your turn'; }
    else if (st === 'working:think') { cls = 'think'; act = 'thinking…'; }
    else if (st.startsWith('working')) { cls = ''; act = tickerText(st, unit._lastTool, unit._lastCmd) || 'working'; }
    tipArgs = [sid, agent, unit];
    loadStats(sid);
    tip.innerHTML = `<div class="t">${esc(meta.title || sid.slice(0, 6))}${agent !== 'main' ? ' · subagent' : ''}</div>`
      + `<div class="p">${esc(baseName(meta.cwd))}</div>`
      + `<div class="a ${cls}">${esc(act)}</div>`
      + statsHtml(sid)
      + '<div class="hint">click → open live view</div>';
    tip.style.display = 'block';
    const p = unit.getGlobalPosition(); const rect = app.canvas.getBoundingClientRect();
    const ax = rect.left + p.x, ay = rect.top + p.y;
    const m = 10; const r = tip.getBoundingClientRect();
    let x = ax + 16, y = ay - r.height - 10;
    if (x + r.width > window.innerWidth - m) x = ax - r.width - 16;
    if (x < m) x = m;
    if (y < m) y = ay + 18;
    y = Math.min(y, window.innerHeight - r.height - m);
    tip.style.left = `${x}px`; tip.style.top = `${y}px`;
  }
  // Phase 3: preload the floating-world backdrops up front so makeBase places them
  // synchronously. A world whose PNG is missing just falls back to the placeholder hex.
  const worldTex = new Map();
  await Promise.all(WORLDS.map(async (w) => {
    try { worldTex.set(w.id, await Assets.load(w.file)); } catch { /* missing → fallback hex */ }
  }));

  // Animated-world backdrops: worldAnimTex[id] = [Texture,…] for worlds that declare `anim`.
  // Two sources: a spritesheet grid sliced into sub-textures, or individual frame files.
  // Loaded best-effort; a world whose animation is missing simply uses its static PNG.
  // OFF by default: only load these when the server reports HEX_WORLD_ANIM=1. When empty, makeBase
  // falls through to the static PixelLab PNG — so flipping the env is the whole switch, no code change.
  let worldAnimOn = false;
  try { worldAnimOn = !!(await (await fetch('/config/runtime.json')).json()).worldAnim; } catch { /* default static */ }
  const worldAnimTex = new Map();
  if (worldAnimOn) await Promise.all(WORLDS.filter((w) => w.anim).map(async (w) => {
    try {
      let frames;
      if (w.anim.sheet) {
        // One PNG grid (row-major). Slice into `frames` sub-textures over the same GPU source.
        const sheet = await Assets.load(w.anim.sheet);
        const src = sheet.source;
        const cols = w.anim.cols || 1, rows = w.anim.rows || 1;
        const cw = src.width / cols, ch = src.height / rows;
        frames = Array.from({ length: w.anim.frames }, (_, i) => {
          const cx = (i % cols) * cw, cy = Math.floor(i / cols) * ch;
          return new Texture({ source: src, frame: new Rectangle(cx, cy, cw, ch) });
        });
      } else {
        frames = await Promise.all(
          Array.from({ length: w.anim.frames }, (_, i) => Assets.load(worldFramePath(w.id, i))),
        );
      }
      if (frames && frames.length) worldAnimTex.set(w.id, frames);
    } catch { /* missing → static fallback */ }
  }));

  // Worker unit sprite (static fallback if the animation library fails to load).
  let workerTex = null;
  try { workerTex = await Assets.load('/assets/units/worker-south.png'); } catch { /* fallback shapes */ }

  // Worker ANIMATION library: animTex[anim][dir] = [Texture,…]. walk/standby carry all 8
  // directions; the in-place behaviors are south-only and are reused for every facing.
  const animTex = {};
  let animReady = false;
  try {
    await Promise.all(Object.entries(UNIT.anims).map(async ([anim, meta]) => {
      animTex[anim] = {};
      const dirs = meta.dirList;
      await Promise.all(dirs.map(async (dir) => {
        const urls = Array.from({ length: meta.frames }, (_, i) => framePath(anim, dir, i));
        animTex[anim][dir] = await Promise.all(urls.map((u) => Assets.load(u)));
      }));
    }));
    animReady = !!(animTex.standby?.south?.length);
  } catch { animReady = false; }

  const bases = new Map();       // sessionId -> baseObj
  const units = new Set();       // every unit container currently in the scene (for the ticker)

  // Spiral-cell slot allocator (reuses freed slots so positions don't drift outward over time).
  const cellAlloc = makeCellAllocator(spiralCells);

  // Filter box (feature #6): substring match over title + folder; empty = show all.
  let filterText = '';
  const matchesFilter = (title, cwd) => `${title || ''} ${cwd || ''}`.toLowerCase().includes(filterText);
  function setFilter(text) {
    filterText = (text || '').trim().toLowerCase();
    for (const [sid, b] of bases) {                 // re-apply immediately without waiting for the next state
      const meta = sessionMeta.get(sid) || {};
      const hidden = filterText && !matchesFilter(meta.title, meta.cwd);
      b._filterHidden = hidden;
      b.badge.visible = b._stuck && !hidden;
      b.container._target = hidden ? 0.06 : (b._dormant ? 0.4 : 1);
    }
  }

  // World allocation (unique world per active session; freed slots reused) + walkable-floor
  // geometry — both are pure and live in their own modules (alloc.mjs / floor.mjs), unit-tested.
  const worldAlloc = makeWorldAllocator(WORLDS); // random among unused worlds, then random among all
  const floor = makeFloor(WORLD_W);
  // Robots keep ~this far apart on a platform (pure logic in floor.mjs, simulated in tests).
  const spacing = makeSpacing(floor, WORLD_W * 0.085);
  const clearFloorPoint = (peers, self) => spacing.clearPoint(peers && peers.values(), self);

  function makeUnit(isMain, teamColor, sid, key, peers) {
    const c = new Container();
    const accent = new Graphics(); // ground ring under the unit, tinted per state
    const uiScale = (isMain ? 0.95 : 0.72) * (WORLD_W / 320); // small; scales with world size
    let core, asprite = null;
    if (animReady) {
      // Preferred: an 8-direction AnimatedSprite. _core is a Container so wander/position
      // work on it; the AnimatedSprite inside advances frames on Pixi's shared ticker.
      core = new Container();
      asprite = new AnimatedSprite(animTex.standby.south);
      asprite.anchor.set(0.5, 0.85);                 // stand on its feet at the origin
      asprite.scale.set(uiScale);
      // keep the robot's original colors (no team tint — the world already carries the session color)
      asprite.animationSpeed = UNIT.anims.standby.fps / 60;
      asprite.play();
      core.addChild(asprite);
      const r = asprite.height * 0.42;
      accent.ellipse(0, 2, r, r * 0.4).stroke({ width: 2, color: 0xffffff });
    } else if (workerTex) {
      core = new Container();
      const spr = new Sprite(workerTex);
      spr.anchor.set(0.5, 0.85); spr.scale.set(uiScale); // original colors, no team tint
      core.addChild(spr);
      const r = spr.height * 0.42;
      accent.ellipse(0, 2, r, r * 0.4).stroke({ width: 2, color: 0xffffff });
    } else {
      const size = isMain ? 11 : 7;
      core = new Graphics();
      if (isMain) core.rect(-size, -size, size * 2, size * 2).fill(teamColor).stroke({ width: 2, color: BG });
      else core.circle(0, 0, size).fill(teamColor).stroke({ width: 2, color: BG });
      accent.circle(0, 0, size + 5).stroke({ width: 2, color: 0xffffff });
    }
    // Matrix-style tool ticker (feature #4): 4 tiny green code lines above the robot's head,
    // scrolling like the Matrix — each new activity ("Bash: npm test", "thinking…") drops in at
    // the bottom (bright leading line) and older lines fade upward. Hidden unless working.
    const tLines = [];
    for (let k = 0; k < 4; k++) {
      const ln = new Text({ text: '', style: {
        fontSize: 8, fontFamily: 'monospace', align: 'center', fill: 0x33ff77,
        stroke: { color: 0x001a05, width: 3 }, // dark green outline so glyphs read over any world
      } });
      ln.anchor.set(0.5, 1); ln.visible = false;
      tLines.push(ln);
    }
    c.addChild(accent, core, ...tLines);
    const start = clearFloorPoint(peers, null);
    c.position.set(start.x, start.y);
    Object.assign(c, {
      _core: core, _accent: accent, _asp: asprite, _tLines: tLines, _tHist: [], _tLast: null,
      _phaseT: Math.random() * Math.PI * 2, _curAnim: 'standby', _curDir: 'south',
      _motion: DEFAULT_MOTION, _accentColor: IDLE_COLOR, _state: 'idle', _target: 1, _removing: false,
      _lastTool: null, _lastCmd: null,
      _px: start.x, _py: start.y, _tx: start.x, _ty: start.y, _facing: Math.PI / 2, _moving: false,
      _dwell: 400 + Math.random() * 2000, _working: false, _workUntil: 0, _workDir: 'south', _hovered: false,
      _peers: peers,                                   // the other robots on this platform (spacing)
    });
    // hover this robot → quick tooltip; click → its live mirror (subagent → its own run).
    // Hovering FREEZES the robot AND its platform's bob (see ticker) so it can't slip out from
    // under the cursor — that slipping was what made the panel flicker/disappear.
    c.eventMode = 'static';
    c.cursor = 'pointer';
    c.on('pointerover', () => {
      c._hovered = true; c._moving = false;
      hoveredSid = sid;                                   // freeze this base's bob while hovered
      // If THIS robot's mirror (session or this subagent) is already open, surface it, not a tooltip.
      if (mirrorActive(sid, key)) { hideTip(); revealMirror(); return; }
      showTip(sid, key, c);
    });
    c.on('pointerout', () => { c._hovered = false; if (hoveredSid === sid) hoveredSid = null; hideTip(); });
    // Open the live read-only mirror for THIS robot: 'main' → session transcript; a subagent robot
    // (key = agent_id) → that subagent's own run. Passing `key` is the fix for subagents showing the
    // main chat instead of their real run.
    c.on('pointertap', () => openMirror(sid, sessionMeta.get(sid) || {}, key));
    c.alpha = 0;
    return c;
  }

  function makeBase(sid) {
    const world = worldAlloc.assign(sid);       // this session's floating world (unique among active sessions)
    const color = world.color;            // units inherit their world's accent so they read as one base
    const container = new Container();
    const cell = cellAlloc.take(sid);           // lowest free spiral slot (reused when sessions end)
    const { x, y } = axialToPixel(cell.q, cell.r, LAYOUT_SIZE);
    container.position.set(x, y);

    // Backdrop: animated frames if this world declares `anim` and they loaded; else the static
    // PixelLab PNG; else the Phase-2 placeholder hex. All normalized to one on-screen width.
    const frames = worldAnimTex.get(world.id);
    const tex = worldTex.get(world.id);
    let base;
    if (frames) {
      base = new AnimatedSprite(frames);
      base.anchor.set(0.5, 0.5);
      base.scale.set(WORLD_W / frames[0].width);
      base.animationSpeed = (world.anim.fps || 6) / 60;
      base.play();
    } else if (tex) {
      base = new Sprite(tex);
      base.anchor.set(0.5, 0.5);
      base.scale.set(WORLD_W / tex.width);  // normalize every world to one on-screen width
    } else {
      base = new Graphics();
      const flat = hexCorners(HEX_SIZE * 0.92).flatMap((p) => [p.x, p.y]);
      base.poly(flat).fill({ color, alpha: 0.14 }).stroke({ width: 2, color, alpha: 0.7 });
    }

    // Attention glow (feature #1): an amber ellipse UNDER the platform that pulses when the
    // session is waiting on the human. Drawn first so it reads as a halo behind the world.
    const glowRx = WORLD_W * 0.42, glowRy = WORLD_W * 0.24;
    const glow = new Graphics();
    glow.ellipse(0, WORLD_W * 0.02, glowRx, glowRy).fill({ color: 0xffcf4d, alpha: 1 });
    glow.alpha = 0;

    // Finish/error flash (feature #2): a colored ellipse over the deck that fades out once.
    const flash = new Graphics();
    flash.ellipse(0, WORLD_W * 0.04, WORLD_W * 0.34, WORLD_W * 0.19).fill({ color: 0xffffff, alpha: 1 });
    flash.alpha = 0;

    const unitsLayer = new Container();
    unitsLayer.sortableChildren = true;     // front units (higher y) draw over back units
    const label = new Text({ text: '', style: { fill: 0xcdd3e0, fontSize: 11, fontFamily: 'monospace' } });
    label.anchor.set(0.5, 0);
    label.position.set(0, WORLD_W * 0.52);  // just under the platform

    // Stuck badge (feature #3): amber warning above the world when a tool has hung.
    const badge = new Text({ text: '⚠ stuck', style: { fill: 0xffb454, fontSize: 12, fontWeight: 'bold', fontFamily: 'monospace' } });
    badge.anchor.set(0.5, 1); badge.position.set(0, -WORLD_W * 0.44); badge.visible = false;

    container.addChild(glow, base, flash, unitsLayer, label, badge);
    board.addChild(container);

    // Click the world to focus/zoom it (feature #5). The backdrop is the click target;
    // robots sit on top with their own handlers, so clicking a robot still opens its mirror.
    base.eventMode = 'static'; base.cursor = 'zoom-in';
    // Confine clicks to the platform ellipse — the PNG's transparent margins otherwise make a
    // full-rect hit-box that overlaps neighbours (worlds sit close) and could steal robot clicks.
    base.hitArea = new Ellipse(0, WORLD_W * 0.04, WORLD_W * 0.34, WORLD_W * 0.2);
    base.on('pointertap', () => focusOn(container));

    const b = { container, base, glow, flash, badge, label, unitsLayer, color, units: new Map() };
    // _homeY + _phase drive the gentle floating bob in the ticker (offset per world so they desync)
    Object.assign(container, { _target: 1, _removing: false, _homeY: y, _phase: Math.random() * Math.PI * 2, _attention: false, _flash: null });
    return b;
  }

  function update(worlds) {
    const seen = new Set(Object.keys(worlds));
    for (const [sid, w] of Object.entries(worlds)) {
      let b = bases.get(sid);
      if (!b) { b = makeBase(sid); bases.set(sid, b); }
      const dormant = w.status === 'dormant';
      b._dormant = dormant;
      // Filter box (feature #6): dim worlds whose title/folder don't match the query.
      const hidden = filterText && !matchesFilter(w.title, w.cwd);
      b._filterHidden = hidden;
      b.container._target = hidden ? 0.06 : (dormant ? 0.4 : 1);
      b.container._removing = false;
      b.label.text = `${w.title || sid.slice(0, 6)}  ·  ${baseName(w.cwd)}${dormant ? '  ⏻' : ''}`;
      sessionMeta.set(sid, { cwd: w.cwd, title: w.title }); // for the hover panel + Warp link

      // Attention / working / stuck / one-shot flashes -----------------------
      b.container._attention = w.attention ? w.attention.reason : null; // 'permission' (urgent) | 'idle' | null
      // "working" = actively doing something (main or any subagent mid-tool/thinking). Drives a
      // calm green glow so you can tell working vs idle vs needs-you at a glance.
      const workers = w.workers || {};
      b.container._working = (w.main && w.main.state && w.main.state.startsWith('working'))
        || Object.values(workers).some((k) => k && k.state && k.state.startsWith('working'));
      b._stuck = !!w.stuck;
      b.badge.visible = b._stuck && !hidden;                  // ⚠ stuck badge
      // Fire a flash exactly once per new finish/error timestamp from the server.
      if (w.finishedAt && w.finishedAt !== b._lastFinish) { b._lastFinish = w.finishedAt; b.container._flash = { color: 0x27c93f, until: performance.now() + 850 }; }
      if (w.lastError && w.lastError !== b._lastErrorTs) { b._lastErrorTs = w.lastError; b.container._flash = { color: 0xff5f56, until: performance.now() + 1200 }; }

      // desired units: main + one per subagent (keyed by agent_id)
      const desired = new Map([['main', w.main]]);
      for (const [aid, wk] of Object.entries(w.workers || {})) desired.set(aid, wk);

      // remove units no longer present (fade out)
      for (const key of [...b.units.keys()]) {
        if (!desired.has(key)) { const u = b.units.get(key); u._removing = true; u._target = 0; b.units.delete(key); }
      }
      // add / update — position is driven by the wander system in the ticker, not here
      for (const [key, unit] of desired) {
        let u = b.units.get(key);
        if (!u) { u = makeUnit(key === 'main', b.color, sid, key, b.units); u._target = 1; b.unitsLayer.addChild(u); units.add(u); b.units.set(key, u); }
        const st = (unit && unit.state) || 'idle';
        u._state = st;
        u._motion = motionFor(st);
        u._accentColor = accentFor(st);
        u._lastTool = (unit && unit.lastTool) || null;   // feeds the floating tool ticker
        u._lastCmd = (unit && unit.lastCmd) || null;
      }
    }
    // remove bases whose session vanished (12h cleanup on the server)
    for (const sid of [...bases.keys()]) {
      if (!seen.has(sid)) {
        const b = bases.get(sid);
        b.container._removing = true; b.container._target = 0;
        // Stop ticking this world's robots: drop them from the global `units` set so the ticker
        // no longer touches them. They're children of the container and get freed by its
        // destroy({children:true}) when it finishes fading — avoids operate-after-destroy.
        for (const u of b.units.values()) units.delete(u);
        b.units.clear();
        bases.delete(sid); leftoverBases.add(b); worldAlloc.free(sid); cellAlloc.release(sid); sessionMeta.delete(sid);
      }
    }
  }

  const leftoverBases = new Set();

  // ---- animation ----
  app.ticker.add(() => {
    // Ease the camera toward a focus goal (click-to-focus / reset); snap & release when close.
    if (camAnim) {
      cam.x += (camAnim.x - cam.x) * 0.15; cam.y += (camAnim.y - cam.y) * 0.15;
      cam.zoom += (camAnim.zoom - cam.zoom) * 0.15;
      if (Math.abs(cam.zoom - camAnim.zoom) < 0.005 && Math.hypot(cam.x - camAnim.x, cam.y - camAnim.y) < 0.5) {
        cam.x = camAnim.x; cam.y = camAnim.y; cam.zoom = camAnim.zoom; camAnim = null;
      }
    }
    board.position.set(app.screen.width / 2 + cam.x, app.screen.height / 2 + cam.y);
    board.scale.set(cam.zoom);
    const now = performance.now();

    // Twinkle the starfield (dim base alpha modulated by a slow per-star sine).
    for (const s of stars) if (s.twinkle) s.g.alpha = Math.max(0.02, s.base * (1 + s.amp * Math.sin(now * s.speed + s.phase)));

    for (const u of units) {
      // fade toward target; destroy when a removing unit has faded out
      u.alpha += (u._target - u.alpha) * 0.15;
      if (u._removing && u.alpha < 0.03) { u.parent?.removeChild(u); u.destroy({ children: true }); units.delete(u); continue; }

      const dt = app.ticker.deltaMS;
      const st = u._state || 'idle';
      const stWorking = st.startsWith('working');

      // --- working mode: stop in place, lock the facing from work-start, loop >= 5s ---
      if (stWorking && !u._working && animTex.work) {
        u._working = true;
        u._moving = false;                                              // stop where you are
        u._workUntil = now + 5000;                                       // minimum 5s of welding
        u._workDir = NEAREST_CARDINAL[dirFromAngle(u._facing)] || 'south'; // lock facing at start
      }
      // leave working mode only once the agent has stopped AND the 5s floor has passed
      if (u._working && !stWorking && now >= u._workUntil) u._working = false;

      // --- wander (paused while working or hovered): drift to random floor points, never onto elements ---
      if (!u._working && !u._hovered) {
        if (u._moving) {
          const dx = u._tx - u._px, dy = u._ty - u._py, dist = Math.hypot(dx, dy);
          if (dist < 2) { u._moving = false; u._dwell = 500 + Math.random() * 2500; }
          else {
            const step = Math.min(dist, (WORLD_W * 0.176) * dt / 1000); // 80% of the original wander speed
            u._px += (dx / dist) * step; u._py += (dy / dist) * step;
            u._facing = Math.atan2(dy, dx);
          }
        } else {
          u._dwell -= dt;
          if (u._dwell <= 0) { const t = clearFloorPoint(u._peers, u); u._tx = t.x; u._ty = t.y; u._moving = true; }
        }
      }
      if (u._peers) spacing.separate(u, u._peers.values());   // personal space (floor.mjs)
      u.position.set(u._px, u._py);
      u.zIndex = u._py;                      // depth sort: front units draw over back units

      // Matrix tool ticker: push each new activity string, render 4 fading lines above the head.
      const tLines = u._tLines;
      if (tLines) {
        if (stWorking && !u._hovered) {
          const txt = tickerText(u._state, u._lastTool, u._lastCmd);
          if (txt && txt !== u._tLast) {           // only advance the rain on a genuinely new activity
            u._tHist.push(txt); if (u._tHist.length > 4) u._tHist.shift(); u._tLast = txt;
          }
          const top = (u._asp ? u._asp.height * 0.66 : 14); // sit the stack just above the head, close to the robot
          const lh = 8, n = u._tHist.length;
          const flick = 0.86 + 0.14 * Math.sin(now / 90 + u._phaseT); // subtle code-rain shimmer
          for (let k = 0; k < 4; k++) {
            const ln = tLines[k];
            const h = u._tHist[n - 4 + k];         // k=3 (bottom) = newest, older lines climb upward
            if (!h) { ln.visible = false; continue; }
            ln.text = h.length > 22 ? h.slice(0, 21) + '…' : h;
            ln.visible = true;
            ln.y = -top - (3 - k) * lh;            // stack the 4 lines just above the robot
            const newest = k === 3;
            ln.tint = newest ? 0xd6ffe0 : 0x2be36b; // leading line bright, trail Matrix-green
            ln.alpha = newest ? flick : [0.26, 0.44, 0.70][k]; // fade upward
          }
        } else { for (const ln of tLines) ln.visible = false; }
      }

      const accent = u._accent;
      accent.scale.set(1);
      accent.tint = u._accentColor;
      if (u._asp) {
        // Animated unit: work (locked facing) while working; walk while moving; else idle.
        const want = u._working ? 'work' : (u._moving ? 'walk' : 'standby');
        const anim = animTex[want] ? want : 'standby';
        const lib = animTex[anim];
        let dir;
        if (u._working) dir = lib[u._workDir] ? u._workDir : 'south';   // held facing for the whole work loop
        else { const wd = dirFromAngle(u._facing); dir = lib[wd] ? wd : (lib[NEAREST_CARDINAL[wd]] ? NEAREST_CARDINAL[wd] : 'south'); }
        if (anim !== u._curAnim || dir !== u._curDir) {
          const tx = lib[dir] || lib.south;
          if (tx) {
            u._asp.textures = tx;
            const meta = UNIT.anims[anim] || UNIT.anims.standby;
            u._asp.animationSpeed = (meta.fps || 10) / 60;
            u._asp.loop = meta.loop !== false;
            u._asp.gotoAndPlay(0);
          }
          u._curAnim = anim; u._curDir = dir;
        }
        accent.alpha = u._moving ? 0.12 : 0.28;
      } else {
        const m = u._motion, core = u._core;
        const phase = (now % m.period) / m.period;
        core.position.set(0, 0); core.scale.set(1);
        switch (m.kind) {
          case 'bob': core.y = Math.sin(phase * 2 * Math.PI) * m.amp; accent.alpha = 0.22; break;
          case 'jab': core.y = Math.abs(Math.sin(phase * Math.PI)) * m.amp; accent.alpha = 0.9; break;
          case 'flicker': accent.alpha = 0.35 + 0.6 * Math.abs(Math.sin(now / m.period)); break;
          case 'sweep': core.x = Math.sin(phase * 2 * Math.PI) * m.amp; accent.alpha = 0.9; break;
          case 'pulse': core.scale.set(1 + Math.sin(phase * 2 * Math.PI) * 0.18); accent.alpha = 0.9; break;
          case 'beam': accent.scale.set(1, 1 + (Math.sin(phase * 2 * Math.PI) * 0.5 + 0.5)); accent.alpha = 0.9; break;
          case 'tap': core.y = phase < 0.25 ? phase * 4 * m.amp : 0; accent.alpha = 0.7; break;
          default: core.y = Math.sin(phase * 2 * Math.PI) * m.amp; accent.alpha = 0.25;
        }
      }
    }
    // base fade / dim / destroy + attention glow + finish/error flash
    for (const b of [...bases.values(), ...leftoverBases]) {
      const c = b.container;
      // Freeze the bob for the platform whose robot is being hovered, so the robot stays put under
      // the cursor (a moving robot fired pointerout and made the hover panel flicker away).
      const frozen = hoveredSid && bases.get(hoveredSid) === b;
      if (!frozen) c.y = c._homeY + Math.sin(now / 2600 + c._phase) * 8; // gentle floating bob (desynced per world)
      c.alpha += (c._target - c.alpha) * 0.12;
      // Status glow (at-a-glance state), priority: needs-you > working > idle(none).
      //   permission → urgent orange (bright, fast)   idle-attention → amber (soft, slow)
      //   working    → calm green (subtle, slow)      otherwise → fade out
      if (b.glow) {
        const reason = c._attention;
        let want = 0;
        if (reason === 'permission') { want = 0.36 + 0.34 * (0.5 + 0.5 * Math.sin(now / 240)); b.glow.tint = 0xff8a3d; }
        else if (reason) { want = 0.20 + 0.22 * (0.5 + 0.5 * Math.sin(now / 560)); b.glow.tint = 0xffcf4d; }
        else if (c._working) { want = 0.12 + 0.14 * (0.5 + 0.5 * Math.sin(now / 700)); b.glow.tint = 0x3fd47a; }
        b.glow.alpha += (want - b.glow.alpha) * 0.18;
      }
      // One-shot flash: fade a colored overlay out over its lifetime, then clear it.
      if (b.flash) {
        const f = c._flash;
        if (f && now < f.until) { b.flash.tint = f.color; b.flash.alpha = 0.55 * (f.until - now) / 900; }
        else { b.flash.alpha = 0; if (f) c._flash = null; }
      }
      if (c._removing && c.alpha < 0.03) { c.parent?.removeChild(c); c.destroy({ children: true }); leftoverBases.delete(b); }
    }
  });

  // Screen point (CSS px) just above a session's platform, tracking pan/zoom/bob — the permission
  // card anchors here so it pops up next to the robot that asked. null if the session isn't drawn.
  function anchorOf(sid) {
    const b = bases.get(sid);
    if (!b) return null;
    // From the platform's REST position (_homeY), not its floating bob — a card that bobs under the
    // mouse is hard to click.
    const p = board.toGlobal({ x: b.container.x, y: b.container._homeY - WORLD_W * 0.28 });
    const r = app.canvas.getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }
  const focusSession = (sid) => { const b = bases.get(sid); if (b) focusOn(b.container); };

  return { update, app, setFilter, anchorOf, focusSession };
}
