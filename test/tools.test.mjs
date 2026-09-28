// Invariants for the consolidated tool-metadata table (config/tools.mjs) — guards against the
// table drifting out of sync with the category map or missing required fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../config/tools.mjs';
import { TOOL_CATEGORY } from '../config/behaviors.mjs';

test('every categorized tool has presentation metadata', () => {
  for (const name of Object.keys(TOOL_CATEGORY)) {
    assert.ok(TOOLS[name], `TOOLS missing entry for ${name}`);
  }
});

test('every TOOLS entry is well-formed', () => {
  const renders = new Set(['diff', 'multidiff', 'code', 'command', 'none']);
  for (const [name, m] of Object.entries(TOOLS)) {
    assert.equal(typeof m.class, 'string', `${name}.class`);
    assert.ok(Array.isArray(m.summary) && m.summary.length, `${name}.summary`);
    assert.equal(typeof m.arg, 'string', `${name}.arg`);
    assert.ok(renders.has(m.render), `${name}.render invalid: ${m.render}`);
    if (m.pick !== 'multiedit') {
      for (const [out, spec] of Object.entries(m.pick)) {
        assert.equal(typeof spec.from, 'string', `${name}.pick.${out}.from`);
        if (spec.cap !== undefined) assert.equal(typeof spec.cap, 'number', `${name}.pick.${out}.cap`);
      }
    }
  }
});
