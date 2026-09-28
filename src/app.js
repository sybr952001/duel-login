// ============================================================================
// Browser front end: a duel puzzle that gates the password field.
//
// The rules engine is a generator that yields request objects; this file turns
// each request into DOM and feeds the player's answer back with game.resume().
// Clearing a puzzle reveals the password field; the password then admits the
// rest of the app and mints a session.
// ============================================================================

import {
  Game, ACTION, PHASE, ZONE, POS, makeDatabase, effectCoverage,
} from './engine.js';
import { registerTriggers } from './effects.js';
import { listPuzzles, makePuzzle, verifyAll } from './puzzle.js';
import { openSession, resumeSession, closeSession } from './auth.js';

// Replaced by build.py. Kept as a placeholder so the module also loads
// straight from disk during development.
const CARD_DB_B64 = '__CARD_DB_B64__';
// Replaced by build.py with {salt, iterations, hash}; no plaintext password is
// ever embedded.
const CREDENTIAL = '__CREDENTIAL__';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const state = {
  db: null,
  game: null,
  template: null,
  req: null,
  pick: null,
  verified: new Map(),
  hintIdx: 0,
  wired: false,
  unlocked: false,
};

// --- database --------------------------------------------------------------

async function loadDatabase() {
  const raw = atob(CARD_DB_B64.trim());
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const json = new TextDecoder().decode(await new Response(stream).arrayBuffer());
  return makeDatabase(JSON.parse(json));
}

// --- rendering -------------------------------------------------------------

function posClass(c) {
  if (!c.isMonster) return '';
  if (c.pos === POS.FACEUP_ATTACK) return 'atkpos';
  if (c.pos === POS.FACEUP_DEFENSE) return 'defpos';
  if (c.pos === POS.FACEDOWN_ATTACK) return 'face-down-atk';
  return '';
}

function cardEl(c, opts = {}) {
  const el = document.createElement('div');
  const addClass = (name) => { if (name) el.classList.add(name); };
  const faceDown = !c.faceup && c.zone !== ZONE.HAND && c.zone !== ZONE.GRAVE
    && c.zone !== ZONE.EXTRA && c.zone !== ZONE.BANISH;
  el.className = 'card';
  el.dataset.uid = c.uid;
  if (faceDown) {
    el.classList.add('down');
    addClass(posClass(c));
    el.title = 'Face-down card';
  } else {
    addClass(posClass(c));
    if (c.negated) el.classList.add('negated');
    if (c.attacked) el.classList.add('attacked');
    el.innerHTML = `<div class="nm">${esc(c.name)}</div>`
      + (c.isMonster ? `<div class="st">${c.atk} / ${c.def}</div>` : '')
      + (c.isXyz && c.card.rank ? `<div class="st">Rank ${c.card.rank}</div>` : '')
      + (c.isLink ? `<div class="st">LINK-${c.card.link}</div>` : '');
    el.title = `${c.name}${c.isMonster ? ` (${c.atk}/${c.def})` : ''}`;
  }
  if (state.pick && opts.pickable) {
    el.classList.add('pickable');
    if (state.pick.chosen.includes(c.uid)) el.classList.add('sel');
  }
  return el;
}

function renderSide(sel, p, isMe) {
  const root = $(sel);
  root.querySelector('.pname').textContent = p.name;
  root.querySelector('.lp').textContent = `LP ${p.lp}`;
  root.querySelector('.turnflag').textContent = state.game && state.game.current === p.index
    ? `turn ${state.game.turn}` : '';
  const deck = root.querySelector('.deck');
  const gy = root.querySelector('.gy');
  deck.textContent = `Deck ${p.deck.length}`;
  gy.textContent = `GY ${p.grave.length}`;
  deck.onclick = () => showZone(p, 'deck');
  gy.onclick = () => showZone(p, 'grave');

  const mrow = root.querySelector('.monsters');
  mrow.textContent = '';
  for (const c of p.monsters) mrow.append(c ? cardEl(c, { pickable: true }) : document.createElement('div'));

  const srow = root.querySelector('.spells');
  srow.textContent = '';
  for (const c of p.spells) srow.append(c ? cardEl(c, { pickable: true }) : document.createElement('div'));

  const hrow = root.querySelector(isMe ? '.hand.me' : '.hand.foe');
  hrow.textContent = '';
  if (isMe) {
    for (const c of p.hand) hrow.append(cardEl(c, { pickable: true }));
    if (!p.hand.length) hrow.append(Object.assign(document.createElement('span'), {
      className: 'backcount', textContent: 'hand empty',
    }));
  } else {
    for (const c of p.hand) {
      const b = document.createElement('div');
      b.className = 'back';
      hrow.append(b);
    }
    hrow.append(Object.assign(document.createElement('span'), {
      className: 'backcount', textContent: `${p.hand.length} in hand`,
    }));
  }
}

function showZone(p, which) {
  const list = p[which];
  const box = $('#prompt');
  box.textContent = '';
  const h = document.createElement('h4');
  h.textContent = `${p.name} - ${which === 'deck' ? 'Deck (order hidden)' : 'Graveyard'} (${list.length})`;
  box.append(h);
  const acts = document.createElement('div');
  acts.className = 'acts';
  if (which === 'deck') {
    acts.append(Object.assign(document.createElement('p'), {
      className: 'hint-text', textContent: 'Card order is hidden. Draw order matters only for the shuffle.',
    }));
  } else {
    for (const c of list) acts.append(cardEl(c));
    if (!list.length) acts.append(Object.assign(document.createElement('p'), { className: 'hint-text', textContent: 'Empty.' }));
  }
  const back = document.createElement('button');
  back.className = 'ghost';
  back.textContent = 'Back';
  back.onclick = () => renderPrompt();
  acts.append(back);
  box.append(acts);
}

function renderChain() {
  const box = $('#chain');
  box.textContent = '';
  for (const link of state.game.chain) {
    const el = document.createElement('div');
    el.className = 'lk';
    const tg = (link.targets || []).map((t) => t.name).filter(Boolean).join(', ');
    el.textContent = `${link.label}${tg ? ` -> ${tg}` : ''}${link.negated ? ' (negated)' : ''}`;
    box.append(el);
  }
}

function renderPrompt() {
  const box = $('#prompt');
  const req = state.req;
  box.textContent = '';
  if (!req) {
    box.append(Object.assign(document.createElement('p'), { className: 'hint-text', textContent: 'Waiting...' }));
    return;
  }

  const h = document.createElement('h4');
  const who = req.kind === 'priority' ? state.game.players[req.player].name : '';
  h.textContent = req.kind === 'priority'
    ? `${who} to act (${req.game.phase})`
    : (req.spec.question || 'Choose');
  box.append(h);

  const acts = document.createElement('div');
  acts.className = 'acts';

  if (req.kind === 'priority') {
    for (const a of req.actions) {
      const b = document.createElement('button');
      b.textContent = a.label || a.type;
      if (a.type === ACTION.PASS || a.type === ACTION.END_PHASE) b.className = 'ghost';
      b.onclick = () => answer(a);
      acts.append(b);
    }
    if (!req.actions.length) acts.append(Object.assign(document.createElement('p'), { className: 'hint-text', textContent: 'No legal actions.' }));
    box.append(acts);
    return;
  }

  const spec = req.spec;
  if (spec.kind === 'yesno') {
    for (const o of spec.options || []) {
      const b = document.createElement('button');
      b.textContent = o.label;
      b.className = o.value ? 'primary' : 'ghost';
      b.onclick = () => answer(o.value);
      acts.append(b);
    }
    box.append(acts);
    return;
  }

  // Target / card selection. Candidates come as {card, note} descriptors, or
  // as {uid, direct} attack options.
  const cands = spec.candidates || spec.cards || [];
  const isAttack = cands.length > 0 && !cands[0].card && ('direct' in cands[0] || cands[0].uid !== undefined);
  state.pick = { req, chosen: [], min: spec.min ?? 1, max: spec.max ?? 1 };
  if (isAttack) {
    for (const c of cands) {
      const b = document.createElement('button');
      b.textContent = c.direct ? 'Direct Attack (player)' : `Attack: ${state.game.findCard(c.uid)?.name || 'unknown'}`;
      b.onclick = () => answer([c]);
      acts.append(b);
    }
  } else {
    for (const c of cands) {
      const card = c.card || c;
      const b = document.createElement('button');
      b.textContent = `${card.name}${c.note ? ` (${c.note})` : ''}`;
      b.onclick = () => togglePick(card);
      acts.append(b);
    }
    if (spec.allowCancel) {
      const b = document.createElement('button');
      b.className = 'ghost';
      b.textContent = 'Cancel';
      b.onclick = () => answer([]);
      acts.append(b);
    }
  }
  const tip = document.createElement('p');
  tip.className = 'hint-text';
  tip.textContent = 'You can also click cards on the board.';
  acts.append(tip);
  box.append(acts);
  render();
}

function togglePick(card) {
  if (!state.pick) return;
  const i = state.pick.chosen.indexOf(card.uid);
  if (i >= 0) state.pick.chosen.splice(i, 1);
  else {
    if (state.pick.chosen.length >= state.pick.max) state.pick.chosen.shift();
    state.pick.chosen.push(card.uid);
  }
  render();
  if (state.pick.chosen.length >= state.pick.min) {
    // Auto-confirm once the minimum is met, unless more are wanted.
    if (state.pick.chosen.length >= state.pick.max) answer(state.pick.chosen.map((uid) => cardByUid(uid)));
  }
}

function cardByUid(uid) {
  for (const p of state.game.players) {
    const fields = ['hand', 'monsters', 'spells', 'grave', 'extra', 'banish', 'deck'];
    for (const f of fields) {
      for (const c of p[f] || []) if (c && c.uid === uid) return c;
    }
  }
  return null;
}

function answer(value) {
  const req = state.req;
  if (!req) return;
  state.req = null;
  state.pick = null;
  $('#prompt').textContent = '';
  state.game.resume(value);
  if (!state.game.over) renderPrompt();
  else render();
}

function render() {
  if (!state.game) return;
  renderSide('#side-foe', state.game.players[1], false);
  renderSide('#side-me', state.game.players[0], true);
  renderChain();
  if (state.req) markPickables();
}

/** Highlight board cards that the current prompt could accept. */
function markPickables() {
  const cands = state.req.kind === 'priority' ? [] : (state.req.spec.candidates || state.req.spec.cards || []);
  if (!cands.length || (cands[0] && !cands[0].card)) return;
  const uids = new Set(cands.map((c) => (c.card || c).uid));
  for (const el of document.querySelectorAll('.card[data-uid]')) {
    if (uids.has(Number(el.dataset.uid))) el.classList.add('pickable');
  }
}

document.addEventListener('click', (ev) => {
  if (!state.pick) return;
  const el = ev.target.closest('.card[data-uid]');
  if (!el || !el.classList.contains('pickable')) return;
  const card = cardByUid(Number(el.dataset.uid));
  if (card) togglePick(card);
});

function addLog(line) {
  const box = $('#log');
  const d = document.createElement('div');
  d.textContent = line;
  box.append(d);
  while (box.childElementCount > 300) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

// --- puzzle lifecycle ------------------------------------------------------

function currentPuzzleId() { return $('#puzzle-pick').value; }

function startPuzzle(id) {
  const { template, config } = makePuzzle(state.db, id);
  state.template = template;
  state.hintIdx = 0;
  state.req = null;
  state.pick = null;
  $('#overlay').hidden = true;
  $('#p-title').textContent = template.title;
  $('#p-goal').textContent = `Goal: ${template.goalText}`;
  $('#p-brief').textContent = template.brief;
  $('#log').textContent = '';

  const game = new Game(state.db, {
    strict: true,
    p0name: 'You',
    p1name: 'Opponent',
    turnLimit: 20,
  });
  state.game = game;
  game.on((ev) => {
    if (ev.type === 'log') addLog(ev.data);
    else if (ev.type === 'request') { state.req = ev.data; renderPrompt(); }
    else if (ev.type === 'gameOver') showOverlay(ev.data);
    else render();
  });
  game.startPuzzle(config);
  renderPrompt();
}

function showOverlay(info) {
  const solved = !!(state.game.puzzle && state.game.puzzle.solved);
  // A cleared puzzle is the gate's payload, so it opens the password field -
  // but only while locked. Inside the app a clear is just a win.
  if (solved && !state.unlocked) { openGate(); return; }
  $('#ov-title').textContent = solved ? 'Puzzle solved' : 'Puzzle failed';
  $('#ov-text').textContent = solved
    ? `${state.game.puzzle.title} complete in ${state.game.turn - 1} turn(s).`
    : `${info.reason} - try a different line.`;
  $('#overlay').hidden = false;
  render();
}

function showHint() {
  if (!state.template || !state.template.hints.length) return;
  const hints = state.template.hints;
  const i = Math.min(state.hintIdx, hints.length - 1);
  $('#p-brief').innerHTML = `<b>Hint ${i + 1}:</b> ${esc(hints[i])}`;
  state.hintIdx++;
}

// --- boot ------------------------------------------------------------------

/** Wires the shared controls once. The challenge and the app both need them. */
function setupUi() {
  if (state.wired) return;
  state.wired = true;
  const cov = effectCoverage(state.db);
  $('#coverage').textContent = `Card database: ${state.db.size} cards. `
    + `Effect coverage: ${cov.exact} exact, ${cov.interpreted} interpreted, ${cov.inert} inert. `
    + `Unimplemented effects are treated as inert and are reported honestly rather than guessed at.`;

  const sel = $('#puzzle-pick');
  sel.textContent = '';
  for (const p of listPuzzles()) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = `${'★'.repeat(p.difficulty)} ${p.title}`;
    sel.append(o);
  }
  // Mark which puzzles are provably solvable, in the background.
  verifyAll(state.db).then((rows) => {
    for (const r of rows) {
      state.verified.set(r.id, r.verify.solved);
      const o = sel.querySelector(`option[value="${r.id}"]`);
      if (o && !r.verify.solved) o.textContent += ' (unverified)';
    }
  });

  sel.onchange = () => startPuzzle(sel.value);
  $('#btn-restart').onclick = () => startPuzzle(sel.value);
  $('#btn-hint').onclick = showHint;
  $('#btn-lock').onclick = () => {
    closeSession();
    state.game = null;
    startChallenge();
  };
  $('#ov-retry').onclick = () => startPuzzle(currentPuzzleId());
  $('#ov-next').onclick = () => {
    const opts = [...sel.options].map((o) => o.value);
    const i = opts.indexOf(sel.value);
    sel.value = opts[(i + 1) % opts.length];
    startPuzzle(sel.value);
  };
}

/**
 * Shows or hides the password field. It only ever opens on a cleared puzzle (or
 * on a session that was already unlocked), so the reveal is the gate's payload.
 */
function setGateOpen(open) {
  $('#gate-open').hidden = !open;
  $('#gate-locked').hidden = open;
  $('#gate-note').hidden = open;
  // Keep the controls out of constraint validation while they are not on screen.
  $('#pw').disabled = !open;
  $('#login-go').disabled = !open;
  $('#login-sub').textContent = open ? 'Password required' : 'Clear a puzzle to unlock';
  $('#gate-done').hidden = true;
  $('#login-err').hidden = true;
  $('#pw').value = '';
  if (open) $('#pw').focus();
}

/** Reveals the password field after a puzzle is cleared. */
function openGate() {
  const g = state.game.puzzle;
  $('#game').hidden = true;
  $('#login').hidden = false;
  setGateOpen(true);
  const done = $('#gate-done');
  done.textContent = `Puzzle cleared: ${g.title} in ${state.game.turn - 1} turn(s).`;
  done.hidden = false;
}

/** The locked state: the board is playable, the password field is not. */
function startChallenge() {
  setupUi();
  state.unlocked = false;
  $('#login').hidden = true;
  $('#game').hidden = false;
  $('#overlay').hidden = true;
  $('#btn-lock').hidden = true;
  setGateOpen(false);
  startPuzzle($('#puzzle-pick').value);
}

function enterApp() {
  setupUi();
  state.unlocked = true;
  $('#login').hidden = true;
  $('#game').hidden = false;
  $('#btn-lock').hidden = false;
  setGateOpen(true);
  startPuzzle($('#puzzle-pick').value);
}

async function boot() {
  try {
    state.db = await loadDatabase();
    registerTriggers();
    $('#load-state').textContent = `${state.db.size} cards loaded.`;
  } catch (err) {
    // Stay on the gate panel so the failure is actually visible.
    $('#login').hidden = false;
    $('#gate-locked').hidden = true;
    $('#load-state').textContent = `Failed to load the card database: ${err.message}`;
    return;
  }

  const cred = typeof CREDENTIAL === 'string' ? JSON.parse(CREDENTIAL) : CREDENTIAL;
  if (await resumeSession()) { enterApp(); return; }

  $('#login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = $('#login-err');
    err.hidden = true;
    const ok = await openSession(cred, $('#pw').value);
    if (!ok) {
      err.textContent = 'Wrong password.';
      err.hidden = false;
      $('#pw').select();
      return;
    }
    enterApp();
  });
  startChallenge();
}

boot();
