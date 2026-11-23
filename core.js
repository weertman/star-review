/* Star Review: rules shared by the page and its tests (no DOM here). */
(function (root) {
  'use strict';
  const STATES = ['quiescent', 'alert', 'moving'];
  const EATING = ['eating', 'not_eating', 'cant_tell'];  // "cant_tell" here: can't see whether it's eating

  // A clip's answer is stored as one label: "<state>+<eating>" (e.g. "alert+not_eating" or
  // "alert+cant_tell"), or "cant_tell" alone for the whole clip. A bare state ("alert") comes from
  // before the eating question.
  function parseLabel(label) {
    if (label === 'cant_tell') return { cantTell: true, state: null, eating: null };
    const [state, eating, extra] = String(label || '').split('+');
    if (!STATES.includes(state) || extra !== undefined) return null;
    if (eating !== undefined && !EATING.includes(eating)) return null;
    return { cantTell: false, state, eating: eating || null };
  }

  function makeLabel(state, eating) {
    return `${state}+${eating}`;
  }

  // Latest label per position, from any number of event lists [{pos, label, t}].
  function mergeLabels(...lists) {
    const out = {};
    for (const list of lists) {
      for (const e of list || []) {
        if (e == null || e.pos == null || !parseLabel(e.label)) continue;
        const cur = out[e.pos];
        if (!cur || String(cur.t) <= String(e.t)) out[e.pos] = { label: e.label, t: e.t };
      }
    }
    return out;
  }

  // Where the student continues: the first position without a label (n when the round is done).
  function firstUnlabeled(labels, n) {
    for (let i = 0; i < n; i++) if (!labels[i]) return i;
    return n;
  }

  // Back can reach at most backLimit clips behind the newest one (current), never ahead of it.
  function canVisit(target, current, backLimit, n) {
    return Number.isInteger(target) && target >= 0 && target < n && target <= current && target >= current - backLimit;
  }

  // True when no clip's second showing can reach its first by going back.
  function repeatsUnreachable(seq, backLimit) {
    const firstAt = {};
    for (let p = 0; p < seq.length; p++) {
      const c = seq[p];
      if (c in firstAt && p - firstAt[c] <= backLimit) return false;
      if (!(c in firstAt)) firstAt[c] = p;
    }
    return true;
  }

  const api = { STATES, EATING, parseLabel, makeLabel, mergeLabels, firstUnlabeled, canVisit, repeatsUnreachable };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SRCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
