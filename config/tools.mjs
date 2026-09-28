/*
 * SINGLE SOURCE OF TRUTH for per-tool presentation metadata, shared by the server digest
 * (server/state.mjs: pickToolInput, cmdSummary) and the client mirror (public/terminal.mjs:
 * toolClass, renderTool). Before this, the same tool vocabulary was switch-duplicated in 3+
 * places — adding a tool now means editing ONLY this table. (Tool→category for the robot
 * animation lives in behaviors.mjs; that's a separate concern.)
 *
 * Per tool:
 *   class   — badge color class in the mirror header ('edit'|'write'|'run'|'read'|'spawn'|'')
 *   summary — ordered input fields; the first non-empty is the one-line ticker summary
 *   arg     — input field shown after the badge in the mirror header ('grep' = pattern[·path])
 *   render  — how the mirror draws the body: 'diff'|'multidiff'|'code'|'command'|'none'
 *   pick    — output field -> { from: <input field>, cap?: <max chars> } for the /chat digest;
 *             the string 'multiedit' is the special MultiEdit shape
 */
export const TOOLS = {
  Bash:         { class: 'run',   summary: ['command'], arg: 'description', render: 'command', pick: { command: { from: 'command', cap: 4000 }, description: { from: 'description' } } },
  PowerShell:   { class: 'run',   summary: ['command'], arg: 'description', render: 'command', pick: { command: { from: 'command', cap: 4000 }, description: { from: 'description' } } },
  Edit:         { class: 'edit',  summary: ['file_path'], arg: 'file_path', render: 'diff', pick: { file_path: { from: 'file_path' }, old_string: { from: 'old_string', cap: 8000 }, new_string: { from: 'new_string', cap: 8000 } } },
  MultiEdit:    { class: 'edit',  summary: ['file_path'], arg: 'file_path', render: 'multidiff', pick: 'multiedit' },
  Write:        { class: 'write', summary: ['file_path'], arg: 'file_path', render: 'code', pick: { file_path: { from: 'file_path' }, content: { from: 'content', cap: 12000 } } },
  NotebookEdit: { class: 'edit',  summary: ['notebook_path', 'file_path'], arg: 'file_path', render: 'code', pick: { file_path: { from: 'notebook_path' }, content: { from: 'new_source', cap: 8000 } } },
  Read:         { class: 'read',  summary: ['file_path'], arg: 'file_path', render: 'none', pick: { file_path: { from: 'file_path' } } },
  Grep:         { class: 'read',  summary: ['pattern'], arg: 'grep', render: 'none', pick: { pattern: { from: 'pattern' }, path: { from: 'path' }, glob: { from: 'glob' } } },
  Glob:         { class: 'read',  summary: ['pattern'], arg: 'pattern', render: 'none', pick: { pattern: { from: 'pattern' }, path: { from: 'path' } } },
  Agent:        { class: 'spawn', summary: ['description', 'subagent_type'], arg: 'description', render: 'none', pick: { description: { from: 'description' }, subagent_type: { from: 'subagent_type' } } },
  Task:         { class: 'spawn', summary: ['description', 'subagent_type'], arg: 'description', render: 'none', pick: { description: { from: 'description' }, subagent_type: { from: 'subagent_type' } } },
  WebFetch:     { class: '',      summary: ['url'], arg: 'url', render: 'none', pick: { url: { from: 'url' } } },
  WebSearch:    { class: '',      summary: ['query'], arg: 'query', render: 'none', pick: { query: { from: 'query' } } },
};

export const MULTIEDIT_CAP = 4000; // per old/new string inside a MultiEdit
