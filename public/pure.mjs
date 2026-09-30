/*
 * Pure, dependency-free helpers shared by the render layer and the live mirror. No Pixi, no DOM,
 * no browser-only imports — so this module is unit-testable under Node (see test/pure.test.mjs)
 * and importable from both public/render.mjs and public/terminal.mjs (removing the old copies).
 */

// HTML-escape for safe innerHTML interpolation — text AND attribute values (titles/paths come from
// transcripts, so a `"` must not end a title="…" attribute early).
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Last path segment (file/folder name) from a POSIX or Windows path.
export const baseName = (p) => (p ? p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() : '');

// file extension → highlight.js language id
export const LANGS = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php',
  sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', css: 'css', scss: 'scss',
  less: 'less', html: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', yml: 'yaml', yaml: 'yaml',
  md: 'markdown', sql: 'sql', toml: 'ini', ini: 'ini', swift: 'swift', kt: 'kotlin',
  lua: 'lua', r: 'r', dart: 'dart', ex: 'elixir', exs: 'elixir',
};
export const langFor = (file) => LANGS[(String(file).split('.').pop() || '').toLowerCase()] || '';

// One short line for the robot's floating tool ticker: "Bash: npm test", "Read render.mjs",
// or "thinking…" between tools. Paths are shown by their last segment to stay compact.
export function tickerText(state, tool, cmd) {
  if (state === 'working:think') return 'thinking…';
  if (!tool) return '';
  let arg = (cmd || '').trim();
  if (/[/\\]/.test(arg) && !/\s/.test(arg)) arg = baseName(arg); // a bare path → just the file
  if (arg.length > 26) arg = arg.slice(0, 25) + '…';
  return arg ? `${tool}: ${arg}` : tool;
}

// LCS line diff → [{t:' '|'-'|'+', s}] ; null if too large to diff cheaply (caller falls back).
export function lineDiff(aStr, bStr) {
  const a = (aStr || '').split('\n'), b = (bStr || '').split('\n');
  const n = a.length, m = b.length;
  if (n * m > 400000) return null;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: ' ', s: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: '-', s: a[i] }); i++; }
    else { out.push({ t: '+', s: b[j] }); j++; }
  }
  while (i < n) out.push({ t: '-', s: a[i++] });
  while (j < m) out.push({ t: '+', s: b[j++] });
  return out;
}

// Char-level diff of two changed lines → escaped HTML with the differing middle wrapped, so you
// see exactly what changed within a line. Common prefix/suffix stay unmarked.
export function charDiff(a, b) {
  const la = a.length, lb = b.length;
  let s = 0; while (s < la && s < lb && a[s] === b[s]) s++;
  let e = 0; while (e < la - s && e < lb - s && a[la - 1 - e] === b[lb - 1 - e]) e++;
  const pre = esc(a.slice(0, s));
  const aMid = esc(a.slice(s, la - e)), bMid = esc(b.slice(s, lb - e));
  const suf = esc(a.slice(la - e)); // common suffix (same text in b)
  return {
    del: pre + (aMid ? `<span class="wd wd-del">${aMid}</span>` : '') + suf,
    add: pre + (bMid ? `<span class="wd wd-add">${bMid}</span>` : '') + suf,
  };
}
