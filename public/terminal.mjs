/*
 * Live read-only session mirror — a rich code viewer. Clicking a robot opens a floating panel
 * that shows a session's activity and refreshes in real time (polls the server's /chat digest,
 * which re-parses the transcript only when its mtime changes).
 *
 * It renders the real work, not summaries: prompts, assistant text + thinking, tool calls with
 * their actual inputs — Edit → colored line diff, Write → highlighted file, Bash → command +
 * output — all syntax-highlighted with highlight.js. Read-only by design (a running session is
 * owned by one process; two-way control needs a shared multiplexer — see build notes).
 */
import hljs from '/hljs/es/highlight.min.js';
import { marked } from '/marked/marked.esm.js';
import DOMPurify from '/dompurify/purify.es.mjs';
import { esc, baseName, langFor, lineDiff, charDiff } from './pure.mjs';
import { TOOLS } from '/config/tools.mjs';

marked.setOptions({ gfm: true, breaks: true }); // GitHub-flavored; single newlines → <br> (chat-like)

const POLL_MS = 1200;

// highlight.js dark theme (served locally).
if (!document.getElementById('hwm-hljs-css')) {
  const l = document.createElement('link');
  l.id = 'hwm-hljs-css'; l.rel = 'stylesheet'; l.href = '/hljs/styles/atom-one-dark.min.css';
  document.head.appendChild(l);
}

const style = document.createElement('style');
style.textContent = `
  .hwm-panel{position:fixed;z-index:80;display:none;flex-direction:column;width:820px;max-width:96vw;
    height:560px;max-height:90vh;background:#0a0e15;border:1px solid #243044;border-radius:12px;
    overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,.72);
    font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#cdd3e0;}
  .hwm-bar{display:flex;align-items:center;gap:7px;padding:8px 12px;background:#111621;border-bottom:1px solid #1c2431;
    cursor:move;user-select:none;font-size:11px;color:#8792a6;white-space:nowrap;}
  .hwm-bar .dot{width:11px;height:11px;border-radius:50%;flex:0 0 auto;}
  .hwm-bar .ttl{color:#d9dee9;font-weight:600;margin-left:5px;overflow:hidden;text-overflow:ellipsis;}
  .hwm-bar .sub{color:#5a6577;overflow:hidden;text-overflow:ellipsis;flex:1 1 auto;}
  .hwm-live{display:inline-flex;align-items:center;gap:5px;color:#7fd69a;flex:0 0 auto;}
  .hwm-live b{width:7px;height:7px;border-radius:50%;background:#3fd47a;animation:hwm-pulse 1.4s ease-in-out infinite;}
  @keyframes hwm-pulse{0%,100%{opacity:.35}50%{opacity:1}}
  .hwm-bar .x,.hwm-bar .find{flex:0 0 auto;cursor:pointer;color:#8792a6;padding:1px 7px;border-radius:6px;font-size:13px;}
  .hwm-bar .x:hover,.hwm-bar .find:hover{background:#26314a;color:#fff;}
  .hwm-body{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:8px 14px 14px;}
  .hwm-body::-webkit-scrollbar{width:10px}
  .hwm-body::-webkit-scrollbar-thumb{background:#28313f;border-radius:6px;border:2px solid #0a0e15}

  .hwm-user{color:#eaeef6;padding:12px 0 4px;border-top:1px solid #141b27;white-space:pre-wrap;word-break:break-word}
  .hwm-user:first-child{border-top:0}
  .hwm-user .p{color:#4ec9d6;margin-right:7px;font-weight:700}
  .hwm-say{color:#c3cad8;white-space:pre-wrap;word-break:break-word;padding:2px 0 4px}
  .hwm-think{color:#6b7488;font-style:italic;white-space:pre-wrap;word-break:break-word;padding:2px 0;
    border-left:2px solid #2a3346;padding-left:9px;margin:3px 0}

  .hwm-tool{border:1px solid #1e2636;border-radius:8px;margin:7px 0;overflow:hidden;background:#0c111b}
  .hwm-tool.has-err{border-color:#5a2e2e}
  .hwm-thdr{display:flex;align-items:center;gap:8px;padding:6px 10px;background:#121826;font-size:11px;white-space:nowrap;overflow:hidden}
  .hwm-thdr .tname{color:#0a0e15;background:#7fa7ff;border-radius:5px;padding:1px 7px;font-weight:700;flex:0 0 auto}
  .hwm-thdr .tname.edit{background:#e5c07b}.hwm-thdr .tname.write{background:#98c379}
  .hwm-thdr .tname.run{background:#61afef}.hwm-thdr .tname.read{background:#56b6c2}.hwm-thdr .tname.spawn{background:#c678dd}
  .hwm-thdr .targ{color:#9aa4bb;overflow:hidden;text-overflow:ellipsis}

  .hwm-code,.hwm-cmdline{margin:0;padding:8px 10px;overflow-x:auto;white-space:pre;font-size:12px;line-height:1.5;background:#0a0e15}
  .hwm-cmdline{color:#98c379}.hwm-cmdline::before{content:"$ ";color:#4b566b}
  .hwm-out{margin:0;border-top:1px solid #1a2130;padding:7px 10px;max-height:260px;overflow:auto;
    white-space:pre-wrap;word-break:break-word;color:#8b94a8;font-size:11.5px;background:#080b11}
  .hwm-out.err{color:#e88b84;background:#160f0f}

  .hwm-diff{font-size:12px;line-height:1.5;overflow-x:auto}
  .hwm-diff .dl{display:flex;white-space:pre}
  .hwm-diff .dl .sgn{flex:0 0 18px;text-align:center;color:#4b566b;user-select:none}
  .hwm-diff .dl code{flex:1 1 auto;white-space:pre}
  .hwm-diff .dl.add{background:rgba(80,200,120,.11)}.hwm-diff .dl.add .sgn{color:#5bd68a}
  .hwm-diff .dl.del{background:rgba(230,90,80,.11)}.hwm-diff .dl.del .sgn{color:#e5766b}
  .hwm-diff .dl.ctx{opacity:.72}
  .hwm-diff .gap{color:#3a4256;padding:1px 10px;font-size:11px;background:#0b0f18}

  .hwm-diff .dl.add .wd-add{background:rgba(80,220,130,.28);border-radius:2px}
  .hwm-diff .dl.del .wd-del{background:rgba(240,90,80,.30);border-radius:2px}

  .hwm-dim{color:#5a6577}
  .hwm-note{color:#e5c07b;padding:8px 0 2px;font-style:italic}
  /* let hljs tokens color the text but keep our own backgrounds */
  .hwm-body .hljs,.hwm-body code.hljs{background:transparent;padding:0;color:#abb2bf}

  /* markdown (assistant text) */
  .hwm-md{color:#c3cad8;padding:2px 0 5px;word-break:break-word}
  .hwm-md p{margin:.35em 0}
  .hwm-md strong{color:#eef1f7;font-weight:700}
  .hwm-md em{color:#d7c9a7}
  .hwm-md a{color:#7fa7ff;text-decoration:underline}
  .hwm-md h1,.hwm-md h2,.hwm-md h3,.hwm-md h4{color:#eaeef6;margin:.6em 0 .3em;line-height:1.3}
  .hwm-md h1{font-size:1.25em}.hwm-md h2{font-size:1.15em}.hwm-md h3{font-size:1.05em}
  .hwm-md ul,.hwm-md ol{margin:.3em 0;padding-left:1.4em}
  .hwm-md li{margin:.15em 0}
  .hwm-md code{background:#1a2233;color:#e5c07b;padding:1px 5px;border-radius:4px;font-size:.92em}
  .hwm-md pre{margin:.4em 0}
  .hwm-md pre code{display:block;background:#0c111b;border:1px solid #1e2636;border-radius:8px;padding:9px 11px;overflow-x:auto;color:#abb2bf}
  .hwm-md blockquote{border-left:3px solid #2a3346;margin:.4em 0;padding:.1em 0 .1em .8em;color:#9aa4bb}
  .hwm-md table{border-collapse:collapse;margin:.4em 0}
  .hwm-md th,.hwm-md td{border:1px solid #23304a;padding:3px 8px}
  .hwm-md th{background:#141c2b;color:#d9dee9}
  .hwm-md hr{border:0;border-top:1px solid #1e2636;margin:.6em 0}

  /* per-session stats bar */
  .hwm-stats{display:flex;flex-wrap:wrap;gap:14px;padding:5px 12px;background:#0d1420;border-bottom:1px solid #1a2230;
    color:#8a94a8;font-size:11px}
  .hwm-stats:empty{display:none}
  .hwm-stats .it{display:inline-flex;align-items:center;gap:5px}
  .hwm-stats .ic{opacity:.85}

  /* in-mirror search */
  .hwm-search{display:none;align-items:center;gap:6px;padding:5px 10px;background:#0d1420;border-bottom:1px solid #1c2431}
  .hwm-search.on{display:flex}
  .hwm-search input{flex:1 1 auto;background:#11151f;border:1px solid #263042;border-radius:7px;color:#cdd3e0;
    padding:3px 8px;outline:none;font:12px ui-monospace,Menlo,Consolas,monospace}
  .hwm-search input:focus{border-color:#3a5a86}
  .hwm-search .cnt{color:#6b7488;font-size:11px;min-width:52px;text-align:right}
  .hwm-search .nav{cursor:pointer;color:#8792a6;padding:2px 7px;border-radius:6px}
  .hwm-search .nav:hover{background:#26314a;color:#fff}
  mark.hwm-hit{background:#4b5a2e;color:#f5f7d8;border-radius:2px}
  mark.hwm-hit.cur{background:#e5c07b;color:#1a1300}
`;
document.head.appendChild(style);

function hl(code, lang) {
  try { if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; } catch { /* */ }
  return esc(code);
}
const toolClass = (name) => (TOOLS[name] && TOOLS[name].class) || '';
function toolArg(name, i) {
  const meta = TOOLS[name];
  if (!meta) return '';
  if (meta.arg === 'grep') return `${i.pattern || ''}${i.path ? '  ·  ' + i.path : ''}`;
  if (name === 'Agent' || name === 'Task') return i.description || i.subagent_type || '';
  return i[meta.arg] || '';
}

function renderCode(file, content) {
  const lang = langFor(file);
  return `<pre class="hwm-code"><code class="hljs">${hl(content || '', lang)}</code></pre>`;
}
function renderDiff(file, oldS, newS) {
  const lang = langFor(file);
  const d = lineDiff(oldS, newS);
  if (!d) return renderCode(file, newS);          // too big to diff → show the new content
  const line = (cls, sgn, html) => `<div class="dl ${cls}"><span class="sgn">${sgn}</span><code>${html}</code></div>`;
  const rows = [];
  let ctx = 0;
  const flushGap = () => { if (ctx > 6) rows.push(`<div class="gap">⋯ ${ctx - 4} unchanged lines</div>`); ctx = 0; };
  for (let k = 0; k < d.length && rows.length < 800;) {
    const x = d[k];
    if (x.t === ' ') {
      const near = (a) => a && a.t !== ' ';
      if (near(d[k - 1]) || near(d[k + 1]) || near(d[k - 2]) || near(d[k + 2])) { rows.push(line('ctx', ' ', hl(x.s, lang))); ctx = 0; }
      else ctx++;
      k++; continue;
    }
    // A change block: gather consecutive dels then adds, pair them for word-level highlighting.
    if (ctx) flushGap();
    const dels = [], adds = [];
    while (k < d.length && d[k].t !== ' ') { (d[k].t === '-' ? dels : adds).push(d[k].s); k++; }
    const n = Math.max(dels.length, adds.length);
    for (let p = 0; p < n; p++) {
      if (p < dels.length && p < adds.length) {                 // paired → char/word diff
        const cd = charDiff(dels[p], adds[p]);
        rows.push(line('del', '-', cd.del));
        rows.push(line('add', '+', cd.add));
      } else if (p < dels.length) rows.push(line('del', '-', hl(dels[p], lang)));
      else rows.push(line('add', '+', hl(adds[p], lang)));
    }
  }
  return `<div class="hwm-diff">${rows.join('')}</div>`;
}

// Assistant text: full Markdown (bold, lists, headings, tables, links, inline + fenced code).
// Fenced code blocks are syntax-highlighted after insertion (see the querySelectorAll in poll()).
function renderSay(t) {
  // Sanitize the rendered markdown: assistant text can echo web/file content, so raw HTML in it
  // must not execute. DOMPurify strips scripts/handlers but keeps the formatting + code blocks.
  const clean = DOMPurify.sanitize(marked.parse(String(t)), { USE_PROFILES: { html: true } });
  return `<div class="hwm-md">${clean}</div>`;
}

function renderTool(e, result) {
  const i = e.input || {}, name = e.name;
  const meta = TOOLS[name];
  const arg = toolArg(name, i);
  let bodyHtml = '';
  switch (meta && meta.render) {
    case 'diff': bodyHtml = renderDiff(i.file_path, i.old_string, i.new_string); break;
    case 'multidiff': bodyHtml = (i.edits || []).map((ed) => renderDiff(i.file_path, ed.old_string, ed.new_string)).join(''); break;
    case 'code': bodyHtml = renderCode(i.file_path, i.content); break;
    case 'command': bodyHtml = `<pre class="hwm-cmdline"><code class="hljs">${hl(i.command || '', name === 'PowerShell' ? 'powershell' : 'bash')}</code></pre>`; break;
    default: bodyHtml = '';
  }

  let out = '';
  if (result && result.text && result.text.trim() && name !== 'Read') {   // Read output is just the file; skip the noise
    out = `<pre class="hwm-out ${result.err ? 'err' : ''}">${esc(result.text)}</pre>`;
  } else if (result && result.err) {
    out = `<pre class="hwm-out err">${esc(result.text || 'error')}</pre>`;
  }
  return `<div class="hwm-tool ${result && result.err ? 'has-err' : ''}">`
    + `<div class="hwm-thdr"><span class="tname ${toolClass(name)}">${esc(name)}</span><span class="targ">${esc(arg || '')}</span></div>`
    + bodyHtml + out + '</div>';
}

function renderAll(entries, fallback) {
  const results = {};
  for (const e of entries) if (e.k === 'result' && e.id) results[e.id] = e;
  let html = fallback ? '<div class="hwm-note">subagent — showing session transcript</div>' : '';
  for (const e of entries) {
    if (e.k === 'user') html += `<div class="hwm-user"><span class="p">❯</span>${esc(e.t)}</div>`;
    else if (e.k === 'say') html += renderSay(e.t);
    else if (e.k === 'think') html += `<div class="hwm-think">${esc(e.t)}</div>`;
    else if (e.k === 'tool') html += renderTool(e, e.id ? results[e.id] : null);
    else if (e.k === 'result' && !e.id) html += `<pre class="hwm-out ${e.err ? 'err' : ''}">${esc(e.text)}</pre>`;
    else if (e.k === 'cmd') html += `<div class="hwm-say">$ ${esc(e.tool || '')} ${esc(e.t || '')}</div>`; // legacy
  }
  return html;
}

// ---- panel ----
let panel, bar, ttl, sub, body, searchWrap, searchInput, searchCnt, statsBar;
let activeSid = null, timer = null, lastKey = '';
let lastEntries = [], lastFallback = false;   // last painted data (so search can re-paint)
let searchTerm = '', hits = [], curHit = -1;

export function mirrorSidActive() { return (panel && panel.style.display !== 'none') ? activeSid : null; }
export function revealMirror() { if (panel) panel.style.display = 'flex'; }

function build() {
  panel = document.createElement('div'); panel.className = 'hwm-panel';
  bar = document.createElement('div'); bar.className = 'hwm-bar';
  bar.innerHTML = '<span class="dot" style="background:#ff5f56"></span><span class="dot" style="background:#ffbd2e"></span>'
    + '<span class="dot" style="background:#27c93f"></span><span class="ttl"></span><span class="sub"></span>'
    + '<span class="hwm-live"><b></b>live</span><span class="find" title="search (Ctrl+F)">⌕</span><span class="x" title="close">✕</span>';
  ttl = bar.querySelector('.ttl'); sub = bar.querySelector('.sub');
  bar.querySelector('.x').addEventListener('click', closeMirror);
  bar.querySelector('.find').addEventListener('click', () => toggleSearch());

  searchWrap = document.createElement('div'); searchWrap.className = 'hwm-search';
  searchWrap.innerHTML = '<input placeholder="search…" spellcheck="false" autocomplete="off"/>'
    + '<span class="cnt"></span><span class="nav prev" title="previous (Shift+Enter)">▲</span>'
    + '<span class="nav next" title="next (Enter)">▼</span><span class="nav done" title="close">✕</span>';
  searchInput = searchWrap.querySelector('input'); searchCnt = searchWrap.querySelector('.cnt');
  searchInput.addEventListener('input', () => { searchTerm = searchInput.value; paint(false); if (hits.length) setHit(0); });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); toggleSearch(false); }
  });
  searchWrap.querySelector('.next').addEventListener('click', () => step(1));
  searchWrap.querySelector('.prev').addEventListener('click', () => step(-1));
  searchWrap.querySelector('.done').addEventListener('click', () => toggleSearch(false));

  statsBar = document.createElement('div'); statsBar.className = 'hwm-stats';
  body = document.createElement('div'); body.className = 'hwm-body';
  panel.append(bar, statsBar, searchWrap, body);
  document.body.appendChild(panel);
  makeDraggable(panel, bar);
  panel.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); toggleSearch(true); }
  });
}
function makeDraggable(el, handle) {
  let sx = 0, sy = 0, ox = 0, oy = 0, drag = false;
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.classList.contains('x') || e.target.classList.contains('find')) return;
    drag = true; sx = e.clientX; sy = e.clientY;
    const r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
    el.style.left = ox + 'px'; el.style.top = oy + 'px'; el.style.right = 'auto'; el.style.bottom = 'auto';
    try { handle.setPointerCapture(e.pointerId); } catch { /* */ }
  });
  handle.addEventListener('pointermove', (e) => { if (!drag) return; el.style.left = Math.max(0, ox + e.clientX - sx) + 'px'; el.style.top = Math.max(0, oy + e.clientY - sy) + 'px'; });
  const end = (e) => { drag = false; try { handle.releasePointerCapture(e.pointerId); } catch { /* */ } };
  handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
}

// Wrap search matches in the freshly-rendered body (re-run on every paint).
function highlightMatches(term) {
  hits = []; curHit = -1;
  if (!term) { if (searchCnt) searchCnt.textContent = ''; return; }
  const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null);
  const nodes = []; let n; while ((n = walker.nextNode())) nodes.push(n);
  for (const tn of nodes) {
    const s = tn.nodeValue; rx.lastIndex = 0; if (!rx.test(s)) continue; rx.lastIndex = 0;
    const frag = document.createDocumentFragment(); let last = 0, m;
    while ((m = rx.exec(s))) {
      if (m.index > last) frag.appendChild(document.createTextNode(s.slice(last, m.index)));
      const mk = document.createElement('mark'); mk.className = 'hwm-hit'; mk.textContent = m[0];
      frag.appendChild(mk); hits.push(mk);
      last = m.index + m[0].length; if (m[0].length === 0) rx.lastIndex++;
    }
    if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last)));
    tn.parentNode.replaceChild(frag, tn);
  }
  searchCnt.textContent = hits.length ? `1/${hits.length}` : '0/0';
}
function setHit(i) {
  if (!hits.length) return;
  if (curHit >= 0 && hits[curHit]) hits[curHit].classList.remove('cur');
  curHit = (i + hits.length) % hits.length;
  hits[curHit].classList.add('cur');
  hits[curHit].scrollIntoView({ block: 'center', behavior: 'smooth' });
  searchCnt.textContent = `${curHit + 1}/${hits.length}`;
}
function step(dir) { if (hits.length) setHit(curHit < 0 ? 0 : curHit + dir); }
function toggleSearch(on) {
  const show = on === undefined ? !searchWrap.classList.contains('on') : on;
  searchWrap.classList.toggle('on', show);
  if (show) { searchInput.focus(); searchInput.select(); }
  else { searchTerm = ''; searchInput.value = ''; paint(false); }
}

// --- stats bar (feature 4) ---
const fmtNum = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(n || 0));
function fmtDur(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.round(ms / 1000); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${ss}s` : `${ss}s`;
}
// Rough $ estimate (model unknown → blended Claude-ish rates; clearly marked ~).
function estCost(s) {
  const c = (s.tokIn || 0) / 1e6 * 3 + (s.tokOut || 0) / 1e6 * 15 + (s.tokCacheRead || 0) / 1e6 * 0.3 + (s.tokCacheWrite || 0) / 1e6 * 3.75;
  return c < 0.01 ? '<$0.01' : '~$' + c.toFixed(2);
}
function updateStats(s) {
  if (!statsBar) return;
  if (!s) { statsBar.innerHTML = ''; return; }
  const items = [
    ['⏱', fmtDur((s.endTs || 0) - (s.startTs || 0))],
    ['\u{1f527}', `${s.tools || 0} tools`],
    ['\u{1f4c4}', `${s.files || 0} files`],
    ['⇅', `${fmtNum(s.tokTotal)} tok`],
    ['\u{1f4b0}', estCost(s)],
  ];
  statsBar.innerHTML = items.map(([ic, v]) => `<span class="it"><span class="ic">${ic}</span>${v}</span>`).join('');
}

// Render lastEntries into the body: HTML → highlight markdown code → apply search marks.
function paint(stick) {
  const atBottom = stick && body.scrollTop + body.clientHeight >= body.scrollHeight - 16;
  body.innerHTML = lastEntries.length ? renderAll(lastEntries, lastFallback) : '<span class="hwm-dim">(no transcript yet)</span>';
  body.querySelectorAll('.hwm-md pre code').forEach((el) => { try { hljs.highlightElement(el); } catch { /* */ } });
  highlightMatches(searchTerm);
  if (atBottom) body.scrollTop = body.scrollHeight;
}

async function poll(sid) {
  let data = { entries: [], fallback: false };
  const demo = typeof window !== 'undefined' && window.__demoChat && window.__demoChat[sid];
  if (demo) data = { entries: demo, fallback: false };
  else { try { data = await fetch(`/chat?session=${encodeURIComponent(sid)}&agent=main`).then((r) => r.json()); } catch { return; } }
  if (activeSid !== sid) return;
  updateStats(data.stats);                    // refresh stats every poll (tokens/elapsed drift)
  const entries = data.entries || [];
  const key = entries.length + '|' + (entries.length ? JSON.stringify(entries[entries.length - 1]).length : 0) + '|' + (entries.length ? entries[entries.length - 1].k : '');
  if (key === lastKey) return;
  lastKey = key; lastEntries = entries; lastFallback = data.fallback;
  const wasAtBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 16;
  paint(false);
  if (wasAtBottom && !searchTerm) body.scrollTop = body.scrollHeight;
}

export function closeMirror() {
  if (timer) { clearInterval(timer); timer = null; }
  activeSid = null; lastKey = ''; lastEntries = []; searchTerm = '';
  if (searchWrap) { searchWrap.classList.remove('on'); searchInput.value = ''; }
  if (panel) panel.style.display = 'none';
}
export function openMirror(sid, meta = {}) {
  if (!panel) build();
  if (timer) { clearInterval(timer); timer = null; }
  activeSid = sid; lastKey = ''; lastEntries = [];
  ttl.textContent = meta.title || sid.slice(0, 8);
  sub.textContent = `· ${baseName(meta.cwd) || meta.cwd || ''}`;
  panel.style.display = 'flex';
  if (!panel.style.left) { panel.style.left = Math.max(10, (window.innerWidth - 820) / 2) + 'px'; panel.style.top = '64px'; }
  body.innerHTML = '<span class="hwm-dim">loading…</span>';
  poll(sid);
  timer = setInterval(() => poll(sid), POLL_MS);
}
