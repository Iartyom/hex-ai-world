/*
 * Session quality flags, from Claude Code's best practices (code.claude.com/docs/en/best-practices).
 * One place for the thresholds: the server ranks sessions with them, the hover and the 'd' panel show
 * them. `q` = { branches, corrections, compactions, uncheckedEdits } (see qualityOf in server/state.mjs).
 */
export const QUALITY = {
  branches: 2,        // git branches in one session → unrelated tasks share one context ("kitchen sink")
  corrections: 3,     // "corrected more than twice" → /clear and restate the task
  compactions: 2,     // working from summaries of summaries
  uncheckedEdits: 5,  // edits since the last check that passed
};
/** Which flags a session trips: { branches: bool, ... }. */
export const flagsOf = (q) => Object.fromEntries(Object.entries(QUALITY).map(([k, min]) => [k, (q[k] || 0) >= min]));
export const flagCount = (q) => Object.values(flagsOf(q)).filter(Boolean).length;
