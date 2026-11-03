/* Star Review student page. Plain JS, no libraries, so it loads and responds instantly. */
(() => {
  'use strict';
  const C = window.SRCore;
  const $ = (id) => document.getElementById(id);
  const KEYS = { q: ['state', 'quiescent'], a: ['state', 'alert'], m: ['state', 'moving'],
                 e: ['eating', 'eating'], n: ['eating', 'not_eating'], u: ['eating', 'cant_tell'],
                 x: ['cant_tell', 'cant_tell'] };

  // Per-device storage. It can be unavailable (private windows), so every call is guarded.
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* keep going without it */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  const S = {
    site: null, key: '', hash: '', assigned: [], round: null, seq: [],
    current: 0, pos: 0, labels: {}, watched: new Set(), queue: [], labelLog: [], stopSaving: false,
    pending: {},  // answers chosen for the clip on screen, until both are in
  };
  const lk = (name) => `sr:${S.hash.slice(0, 16)}:${S.round.id}:${name}`;
  const show = (screen) => {
    for (const id of ['screen-key', 'screen-rounds', 'screen-review', 'screen-done']) $(id).hidden = id !== screen;
  };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2));

  async function sha256hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function note(text, kind) {
    const el = $('note');
    el.textContent = text || '';
    el.className = 'note' + (kind ? ' ' + kind : '');
  }

  // ---- Sign in ----
  async function signIn(raw, remember) {
    const key = raw.trim().toLowerCase();
    $('key-error').textContent = '';
    if (!key) { $('key-error').textContent = 'Enter your key.'; return; }
    $('key-submit').disabled = true;
    try {
      const hash = await sha256hex(key);
      const found = await Promise.all(S.site.rounds.map(async (r) => {
        const res = await fetch(`data/r/${r.id}/${hash.slice(0, 32)}.json`, { cache: 'no-cache' });
        return res.ok ? { ...r, order: await res.json() } : null;
      }));
      S.assigned = found.filter(Boolean).sort((a, b) => a.id.localeCompare(b.id));
      if (!S.assigned.length) {
        $('key-error').textContent = "That key isn't recognized for any open round. Check it and try again.";
        store.del('sr:key');
        return;
      }
      S.key = key;
      S.hash = hash;
      if (remember) store.set('sr:key', key); else store.del('sr:key');
      $('who').textContent = 'Signed in';
      if (S.assigned.length === 1) openRound(S.assigned[0]); else listRounds();
    } catch (err) {
      $('key-error').textContent = "Couldn't reach the site. Check your connection and try again.";
    } finally {
      $('key-submit').disabled = false;
    }
  }

  function listRounds() {
    const list = $('round-list');
    list.replaceChildren(...S.assigned.map((r) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      const name = document.createElement('span');
      name.textContent = r.label;
      const meta = document.createElement('span');
      meta.className = 'muted';
      const saved = Object.keys(C.mergeLabels(store.get(`sr:${S.hash.slice(0, 16)}:${r.id}:labels`, []))).length;
      meta.textContent = `${saved} of ${r.order.sequence.length} on this device`;
      b.append(name, meta);
      b.addEventListener('click', () => openRound(r));
      li.append(b);
      return li;
    }));
    show('screen-rounds');
  }

  // ---- Round ----
  async function openRound(r) {
    S.round = r;
    S.seq = r.order.sequence;
    S.labelLog = store.get(lk('labels'), []);
    S.queue = store.get(lk('queue'), []);
    S.watched = new Set();
    S.stopSaving = false;
    let server = [];
    show('screen-review');
    stageMsg('Loading your progress');
    try {
      server = await inbox({ action: 'progress', round: r.id });
    } catch {
      note("Couldn't reach the save service. Your labels stay on this device and are sent when it's back.", 'warn');
    }
    const pending = S.queue.filter((e) => e.type === 'label' || e.type === 'revise');
    const merged = C.mergeLabels(server.labels || [], S.labelLog, pending);
    S.labels = {};
    for (const [p, v] of Object.entries(merged)) S.labels[+p] = v.label;
    for (const p of Object.keys(S.labels)) S.watched.add(+p);
    S.current = C.firstUnlabeled(S.labels, S.seq.length);
    $('round-name').textContent = r.label;
    log('session_start', { resume_at: S.current, labeled: Object.keys(S.labels).length });
    flush();
    if (S.current >= S.seq.length) { showDone(); return; }
    goTo(S.current);
  }

  // ---- Clips: fetched ahead as blobs, shown by swapping two players ----
  const vids = [$('video-a'), $('video-b')];
  let active = 0;
  let showToken = 0;
  const blobs = new Map();

  function fetchClip(id) {
    if (!blobs.has(id)) {
      const p = fetch(`c/${id}.mp4`).then((res) => {
        if (!res.ok) throw new Error(`clip ${res.status}`);
        return res.blob();
      }).then((b) => URL.createObjectURL(b));
      p.catch(() => blobs.delete(id));
      blobs.set(id, p);
    }
    return blobs.get(id);
  }

  function prefetchAround(pos) {
    const n = S.seq.length;
    const keep = new Set();
    for (let p = Math.max(0, S.current - S.round.back_limit); p <= Math.min(n - 1, pos + 2); p++) keep.add(S.seq[p]);
    for (let p = pos; p <= Math.min(n - 1, pos + 2); p++) fetchClip(S.seq[p]).catch(() => {});
    for (const [id, prom] of blobs) {
      if (!keep.has(id) && !vids.some((v) => v.dataset.clip === id)) {
        prom.then((u) => URL.revokeObjectURL(u)).catch(() => {});
        blobs.delete(id);
      }
    }
  }

  function stageMsg(text) {
    $('stage-msg').hidden = !text;
    $('stage-msg').textContent = text || '';
  }

  async function goTo(pos) {
    const token = ++showToken;
    S.pos = pos;
    S.pending = {};
    render();
    const id = S.seq[pos];
    const slow = setTimeout(() => token === showToken && stageMsg('Loading clip'), 200);
    let url;
    try {
      url = await fetchClip(id);
    } catch {
      clearTimeout(slow);
      if (token === showToken) {
        stageMsg("This clip didn't load. Retrying…");
        setTimeout(() => token === showToken && goTo(pos), 3000);
      }
      return;
    }
    clearTimeout(slow);
    if (token !== showToken) return;
    const next = vids[1 - active];
    const prev = vids[active];
    if (next.dataset.clip !== id) {
      next.src = url;
      next.dataset.clip = id;
    }
    next.currentTime = 0;
    try { await next.play(); } catch { /* autoplay of a muted video is allowed; ignore odd failures */ }
    if (token !== showToken) return;
    next.classList.add('on');
    prev.classList.remove('on');
    prev.pause();
    active = 1 - active;
    stageMsg(null);
    resetLoop();
    log('clip_shown', { pos, clip: id, revisit: pos < S.current });
    render();
    prefetchAround(pos);
  }

  // ---- Enforced viewing: a loop counts only if the clip really played, with the tab visible ----
  let played = 0;
  let lastTick = performance.now();
  let loops = 0;
  const resetLoop = () => { played = 0; loops = 0; lastTick = performance.now(); };

  function tick(now) {
    const v = vids[active];
    const dt = now - lastTick;
    lastTick = now;
    if (!v.paused && !v.ended && v.readyState >= 2 && document.visibilityState === 'visible') played += Math.min(dt, 250);
    if (!$('screen-review').hidden) {
      const d = v.duration || 15;
      $('loop-fill').style.width = `${Math.min(100, ((v.currentTime || 0) / d) * 100)}%`;
      const open = S.watched.has(S.pos);
      $('loop-hint').textContent = open
        ? (S.pos < S.current ? 'Change an answer, or go forward' : 'Answer both questions')
        : `Watch the full loop to answer · ${Math.max(0, Math.ceil(d - (v.currentTime || 0)))} s`;
    }
    requestAnimationFrame(tick);
  }

  for (const v of vids) {
    v.addEventListener('ended', () => {
      if (v !== vids[active]) return;
      if (played >= 0.9 * (v.duration || 15) * 1000) {
        loops += 1;
        if (!S.watched.has(S.pos) && loops >= S.round.loops_required) {
          S.watched.add(S.pos);
          log('loop_complete', { pos: S.pos, clip: S.seq[S.pos], played_s: +(played / 1000).toFixed(2) });
          render();
        }
      }
      played = 0;
      v.currentTime = 0;
      v.play().catch(() => {});
    });
    v.addEventListener('ratechange', () => {
      if (v.playbackRate !== 1) { v.playbackRate = 1; log('rate_reset', { pos: S.pos }); }
    });
    v.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  document.addEventListener('visibilitychange', () => {
    if (!S.round || $('screen-review').hidden) return;
    const v = vids[active];
    if (document.visibilityState === 'hidden') {
      v.pause();
      log('hidden', { pos: S.pos });
      flush(true);
    } else {
      v.play().catch(() => {});
      log('visible', { pos: S.pos });
    }
  });

  // ---- Labels and moving around ----
  function render() {
    const n = S.seq.length;
    $('count').textContent = `Clip ${Math.min(S.pos + 1, n)} of ${n}`;
    $('round-fill').style.width = `${(S.current / n) * 100}%`;
    const open = S.watched.has(S.pos);
    const shown = shownAnswers();
    for (const b of document.querySelectorAll('.label')) {
      b.classList.toggle('locked', !open);
      const on = b.dataset.kind === 'cant_tell' ? shown.cantTell : shown[b.dataset.kind] === b.dataset.value;
      b.setAttribute('aria-pressed', String(Boolean(on)));
    }
    $('back').disabled = !C.canVisit(S.pos - 1, S.current, S.round.back_limit, n);
    $('forward').disabled = S.pos >= S.current;
    if (S.pos < S.current) note(`Revising an earlier clip. You can go back up to ${S.round.back_limit} clips.`);
    else if (!$('note').classList.contains('warn')) note('');
  }

  // What the buttons show for the clip on screen: answers chosen now, else the saved ones.
  function shownAnswers() {
    const saved = C.parseLabel(S.labels[S.pos]) || {};
    const p = S.pending;
    if (p.state || p.eating) return { state: p.state || saved.state, eating: p.eating || saved.eating, cantTell: false };
    return { state: saved.state, eating: saved.eating, cantTell: Boolean(saved.cantTell) };
  }

  function answer(kind, value) {
    if ($('screen-review').hidden) return;
    if (!S.watched.has(S.pos)) {
      note('Answers unlock after one full loop.');
      $('labels').classList.remove('shake');
      void $('labels').offsetWidth;
      $('labels').classList.add('shake');
      return;
    }
    if (kind === 'cant_tell') { commit(S.pos, 'cant_tell'); return; }
    const shown = shownAnswers();
    S.pending = { state: shown.cantTell ? null : shown.state, eating: shown.cantTell ? null : shown.eating, [kind]: value };
    render();
    if (S.pending.state && S.pending.eating) commit(S.pos, C.makeLabel(S.pending.state, S.pending.eating));
    else note(S.pending.state ? 'Now choose whether it was eating (E, N or U).' : 'Now choose the state (Q, A or M).');
  }

  function commit(pos, label) {
    const n = S.seq.length;
    const clip = S.seq[pos];
    const prev = S.labels[pos];
    const parts = C.parseLabel(label);
    const detail = { pos, clip, label, state: parts.state, eating: parts.eating };
    S.pending = {};
    if (pos < S.current) {
      if (prev !== label) {
        S.labels[pos] = label;
        record('revise', { ...detail, prev });
      }
      if (S.current >= n) showDone(); else goTo(S.current);
      return;
    }
    S.labels[pos] = label;
    record('label', detail);
    S.current = C.firstUnlabeled(S.labels, n);
    render();
    // A short pause so the second answer is seen before the next clip
    setTimeout(() => (S.current >= n ? showDone() : goTo(S.current)), 120);
  }

  function back() {
    const t = S.pos - 1;
    if (!C.canVisit(t, S.current, S.round.back_limit, S.seq.length)) return;
    log('back', { from: S.pos, to: t });
    goTo(t);
  }

  function forward() {
    if (S.pos >= S.current) return;
    log('forward', { from: S.pos, to: S.pos + 1 });
    if (S.pos + 1 >= S.seq.length) showDone(); else goTo(S.pos + 1);
  }

  function showDone() {
    for (const v of vids) v.pause();
    const n = S.seq.length;
    log('round_done', { labeled: Object.keys(S.labels).length });
    flush();
    $('done-detail').textContent = `${n} clips labelled.`;
    show('screen-done');
    S.pos = n;
  }

  // ---- Logging and saving: queued on this device, sent in the background ----
  function log(type, data) {
    if (!S.round) return;
    S.queue.push({ id: uuid(), t: new Date().toISOString(), type, ...data });
    store.set(lk('queue'), S.queue);
    scheduleFlush(type === 'label' || type === 'revise' ? 0 : 4000);
  }

  function record(type, data) {
    S.labelLog.push({ pos: data.pos, label: data.label, t: new Date().toISOString() });
    store.set(lk('labels'), S.labelLog);
    log(type, data);
  }

  async function inbox(body) {
    if (!S.site.inbox_url) return {};
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetch(S.site.inbox_url, {
        method: 'POST', body: JSON.stringify({ ...body, key: S.key }), signal: ctl.signal,
      });
      const j = await res.json();
      if (!j.ok) throw Object.assign(new Error(j.error || 'refused'), { refused: j.error });
      return j;
    } finally {
      clearTimeout(timer);
    }
  }

  let flushing = false;
  let flushTimer = null;
  let backoff = 0;

  function scheduleFlush(ms) {
    if (flushTimer && ms > 0) return;
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => { flushTimer = null; flush(); }, ms);
  }

  async function flush(beacon) {
    if (!S.round || !S.site.inbox_url || S.stopSaving || !S.queue.length) { renderSave(); return; }
    const batch = S.queue.slice(0, 100);
    const body = JSON.stringify({ action: 'events', key: S.key, round: S.round.id, events: batch });
    if (beacon && navigator.sendBeacon) {
      // Page is going away: hand off what's left. Duplicates are removed when labels are collected.
      navigator.sendBeacon(S.site.inbox_url, new Blob([body], { type: 'text/plain' }));
      return;
    }
    if (flushing) return;
    flushing = true;
    renderSave('saving');
    try {
      await inbox({ action: 'events', round: S.round.id, events: batch });
      const sent = new Set(batch.map((e) => e.id));
      S.queue = S.queue.filter((e) => !sent.has(e.id));
      store.set(lk('queue'), S.queue);
      backoff = 0;
    } catch (err) {
      if (err.refused === 'unknown_key') {
        S.stopSaving = true;
        note("The save service doesn't accept your key. Your labels stay on this device; contact the lab.", 'warn');
      } else {
        backoff = Math.min(60000, backoff ? backoff * 2 : 2000);
        setTimeout(() => flush(), backoff);
      }
    } finally {
      flushing = false;
      renderSave();
      if (S.queue.length && !backoff && !S.stopSaving) scheduleFlush(300);
    }
  }

  function renderSave(state) {
    const el = $('save-status');
    if (!S.round) { el.textContent = ''; return; }
    el.classList.remove('warn');
    if (!S.site.inbox_url) { el.textContent = 'Test site: saving is off'; el.classList.add('warn'); return; }
    const waiting = S.queue.filter((e) => e.type === 'label' || e.type === 'revise').length;
    if (state === 'saving') el.textContent = 'Saving…';
    else if (S.stopSaving || backoff) { el.textContent = `Not saved yet: ${waiting} label(s) waiting`; el.classList.add('warn'); }
    else el.textContent = waiting ? 'Saving…' : 'Saved';
  }

  // ---- Wiring ----
  for (const b of document.querySelectorAll('.label')) b.addEventListener('click', () => { b.blur(); answer(b.dataset.kind, b.dataset.value); });
  $('back').addEventListener('click', back);
  $('forward').addEventListener('click', forward);
  $('done-rounds').addEventListener('click', () => (S.assigned.length > 1 ? listRounds() : location.reload()));
  $('sign-out').addEventListener('click', () => { store.del('sr:key'); location.reload(); });
  $('key-form').addEventListener('submit', (e) => { e.preventDefault(); signIn($('key-input').value, $('key-remember').checked); });
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target instanceof HTMLInputElement) return;
    if ($('screen-review').hidden) return;
    const key = KEYS[e.key.toLowerCase()];
    if (key && !e.repeat) { e.preventDefault(); answer(key[0], key[1]); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); forward(); }
  });
  window.addEventListener('pagehide', () => flush(true));
  requestAnimationFrame(tick);

  (async function start() {
    try {
      const res = await fetch('data/site.json', { cache: 'no-cache' });
      S.site = await res.json();
    } catch {
      $('key-error').textContent = "The review site isn't set up yet. Try again later.";
      return;
    }
    if (!S.site.rounds.length) {
      $('key-error').textContent = 'There are no rounds to review right now.';
      return;
    }
    const remembered = store.get('sr:key', '');
    if (remembered) {
      $('key-input').value = remembered;
      signIn(remembered, true);
    }
  })();
})();
