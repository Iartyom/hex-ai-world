// Tests for the shared pure helpers (public/pure.mjs): escaping, path/label helpers, and the
// diff engine that powers the live mirror's colored diffs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, baseName, langFor, tickerText, lineDiff, charDiff } from '../public/pure.mjs';

test('esc: escapes HTML-significant chars', () => {
  assert.equal(esc('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');
  assert.equal(esc(`it's`), 'it&#39;s', 'safe inside title="…" and title=\'…\' attributes');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
});

test('baseName: last path segment, POSIX + Windows, trailing slash', () => {
  assert.equal(baseName('/a/b/c.ts'), 'c.ts');
  assert.equal(baseName('C:\\a\\b\\d.js'), 'd.js');
  assert.equal(baseName('/a/b/'), 'b');
  assert.equal(baseName(''), '');
});

test('langFor: maps extensions to highlight.js languages', () => {
  assert.equal(langFor('x.ts'), 'typescript');
  assert.equal(langFor('a/b/x.MJS'), 'javascript');
  assert.equal(langFor('main.py'), 'python');
  assert.equal(langFor('noext'), '');
  assert.equal(langFor('weird.zzz'), '');
});

test('tickerText: thinking, tool+arg, path shortening, truncation', () => {
  assert.equal(tickerText('working:think', 'Bash', 'x'), 'thinking…');
  assert.equal(tickerText('working:shell', 'Bash', 'npm test'), 'Bash: npm test');
  assert.equal(tickerText('working:read', 'Read', '/very/deep/path/file.ts'), 'Read: file.ts');
  assert.equal(tickerText('idle', null, null), '');
  const long = tickerText('working:shell', 'Bash', 'x'.repeat(50));
  assert.ok(long.length <= 'Bash: '.length + 26 + 1);
  assert.ok(long.endsWith('…'));
});

test('lineDiff: additions, deletions, context', () => {
  const d = lineDiff('a\nb\nc', 'a\nB\nc');
  assert.deepEqual(d.map((x) => x.t), [' ', '-', '+', ' ']);
  assert.equal(d[1].s, 'b');
  assert.equal(d[2].s, 'B');
  // pure add
  const add = lineDiff('', 'x\ny');
  assert.ok(add.every((x) => x.t === '+' || (x.t === '-' && x.s === '')));
  // identical
  const same = lineDiff('a\nb', 'a\nb');
  assert.ok(same.every((x) => x.t === ' '));
});

test('lineDiff: returns null when the matrix is too large (caller falls back)', () => {
  const big = Array.from({ length: 700 }, (_, i) => 'line ' + i).join('\n');
  const big2 = big + '\nmore';
  assert.equal(lineDiff(big, big2), null);   // 701 * 702 > 400000
});

test('charDiff: wraps only the changed middle, keeps common prefix/suffix', () => {
  const { del, add } = charDiff('const x = 1;', 'const x = 2;');
  assert.ok(del.includes('<span class="wd wd-del">1</span>'));
  assert.ok(add.includes('<span class="wd wd-add">2</span>'));
  assert.ok(del.startsWith('const x = '));
  assert.ok(add.startsWith('const x = '));
});

test('charDiff: escapes HTML inside the diff', () => {
  const { add } = charDiff('a', '<img>');
  assert.ok(!add.includes('<img>'));
  assert.ok(add.includes('&lt;img&gt;'));
});
