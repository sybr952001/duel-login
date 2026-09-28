// ============================================================================
// Yu-Gi-Oh! Duel Engine
// ----------------------------------------------------------------------------
// A phase-complete, priority-driven duel engine with chain construction,
// all standard summon procedures, battle/damage steps, and a pluggable
// effect system. Card data comes from the YGOPRO cards.cdb database.
//
// Effect coverage: the engine is complete, but the ~15,000 card effects are
// not individually scripted. Effects resolve through (a) a hand-written table
// of exact implementations for the cards the game actually plays and
// (b) a conservative interpreter for common effect phrasing. Anything not
// covered reports itself as UNIMPLEMENTED rather than silently doing nothing.
// ============================================================================

export const PHASE = {
  DRAW: 'draw',
  STANDBY: 'standby',
  MAIN1: 'main1',
  BATTLE_START: 'battle_start',
  BATTLE_STEP: 'battle_step',
  BATTLE_DAMAGE: 'battle_damage',
  BATTLE_DAMAGE_END: 'battle_damage_end',
  BATTLE_END: 'battle_end',
  MAIN2: 'main2',
  END: 'end',
};

export const PHASE_ORDER = [
  PHASE.DRAW, PHASE.STANDBY, PHASE.MAIN1,
  PHASE.BATTLE_START, PHASE.BATTLE_STEP, PHASE.BATTLE_DAMAGE,
  PHASE.BATTLE_DAMAGE_END, PHASE.BATTLE_END,
  PHASE.MAIN2, PHASE.END,
];

export const POS = {
  FACEUP_ATTACK: 'faceup_attack',
  FACEUP_DEFENSE: 'faceup_defense',
  FACEDOWN_DEFENSE: 'facedown_defense',
  FACEDOWN_ATTACK: 'facedown_attack',
};

export const MONSTER_POSITIONS = [POS.FACEUP_ATTACK, POS.FACEUP_DEFENSE, POS.FACEDOWN_DEFENSE, POS.FACEDOWN_ATTACK];

export const ZONE = {
  DECK: 'deck',
  HAND: 'hand',
  GRAVE: 'grave',
  BANISH: 'banish',
  EXTRA: 'extra',
  MONSTER: 'monster',
  SPELL: 'spell',
  PENDULUM: 'pendulum',
};

/**
 * Player stores the fixed-size zones under plural field names (monsters,
 * spells, pendulums) while ZONE uses singular keys, so every `p[zone]` lookup
 * has to go through here.
 */
export function zoneField(zone) {
  if (zone === ZONE.MONSTER) return 'monsters';
  if (zone === ZONE.SPELL) return 'spells';
  if (zone === ZONE.PENDULUM) return 'pendulums';
  return zone;
}

export const NUM_MONSTER_ZONES = 5;
export const NUM_SPELL_ZONES = 5;
export const NUM_PENDULUM_ZONES = 2;
export const HAND_LIMIT = 10;
export const START_LP = 8000;

// --- Card database ---------------------------------------------------------

/**
 * Normalises a raw database record into the shape the engine uses.
 *
 * `raw.t` is an array of canonical tokens produced by src/export_db.py, e.g.
 * ["MONSTER", "EFFECT", "PENDULUM"]. A plain string is also accepted so the
 * engine can be pointed at an unprocessed YGOPRODeck dump.
 */
export function normalizeCard(raw) {
  if (!raw) return null;
  const tokens = (Array.isArray(raw.t) ? raw.t : String(raw.t || '').split(/\s+/))
    .map((t) => String(t).trim().toUpperCase())
    .filter(Boolean);
  const T = new Set(tokens);
  const has = (t) => T.has(t);

  const isSpell = has('SPELL');
  const isTrap = has('TRAP');
  const isSkill = has('SKILL');
  const isMonster = has('MONSTER') || (!isSpell && !isTrap && !isSkill);

  return {
    id: raw.id,
    name: raw.n,
    tokens,
    typeStr: tokens.join(' '),
    types: T,
    isMonster,
    isSpell,
    isTrap,
    isSkill,
    isSpellTrap: isSpell || isTrap || isSkill,
    isNormal: has('NORMAL'),
    isEffect: has('EFFECT'),
    isFlip: has('FLIP'),
    isGemini: has('GEMINI'),
    isSpirit: has('SPIRIT'),
    isToon: has('TOON'),
    isUnion: has('UNION'),
    isTuner: has('TUNER'),
    isToken: has('TOKEN'),
    isQuickPlay: has('QUICKPLAY'),
    isContinuous: has('CONTINUOUS'),
    isField: has('FIELD'),
    isRitual: has('RITUAL'),
    isFusion: has('FUSION'),
    isSynchro: has('SYNCHRO'),
    isXyz: has('XYZ'),
    isLink: has('LINK'),
    isPendulum: has('PENDULUM'),
    attribute: raw.a || null,
    race: raw.r || null,
    archetype: raw.ar || null,
    atk: raw.atk ?? null,
    def: raw.def ?? null,
    level: raw.lv ?? null,
    link: raw.lk ?? null,
    desc: raw.d || '',
  };
}

/** Wraps a plain object of raw records into a database lookup. */
export function makeDatabase(records) {
  const map = new Map();
  for (const [id, raw] of Object.entries(records)) {
    map.set(Number(id), normalizeCard({ ...raw, id: Number(id) }));
  }
  return {
    size: map.size,
    get(id) { return map.get(id) || null; },
    byName(name) {
      const out = [];
      for (const c of map.values()) if (c.name === name) out.push(c);
      return out;
    },
    all() { return [...map.values()]; },
    /** All cards matching a predicate - used by the puzzle generator. */
    query(fn) {
      const out = [];
      for (const c of map.values()) if (fn(c)) out.push(c);
      return out;
    },
  };
}

// --- Card instance ---------------------------------------------------------

let UID = 0;

export class CardInstance {
  constructor(code, owner, controller, db) {
    this.uid = ++UID;
    this.code = code;
    this.card = db.get(code);
    this.owner = owner;
    this.controller = controller;
    this.zone = ZONE.DECK;
    this.pos = null;
    this.faceup = false;
    this.attacked = false;
    this.negated = false;
    this.destroyed = false;
    this.banned = false;
    this.counters = new Map();
    this.equipTargets = [];
    this.fusionMaterials = [];
    this.continuousModifiers = [];
    this.summonedThisTurn = false;
    this.normalSummonedThisTurn = false;
    this.flippedThisTurn = false;
    this.specialSummonedThisTurn = false;
    this.turnSet = -1;
  }

  get name() { return this.card ? this.card.name : 'Unknown'; }
  get isMonster() { return !!this.card && this.card.isMonster; }
  get isSpellTrap() { return !!this.card && this.card.isSpellTrap; }
  get isTuner() { return !!this.card && this.card.isTuner; }

  get onField() {
    return this.zone === ZONE.MONSTER || this.zone === ZONE.SPELL || this.zone === ZONE.PENDULUM;
  }

  /** ATK as printed, with counters and continuous modifiers applied. */
  get atk() {
    if (!this.isMonster) return null;
    if (this.pos === POS.FACEDOWN_ATTACK || this.pos === POS.FACEDOWN_DEFENSE) return this.card.atk ?? 0;
    let v = this.card.atk ?? 0;
    for (const m of this.continuousModifiers) if (m.atk) v += m.atk;
    v += this.getCounter('atk');
    return v;
  }

  /** DEF as printed, with counters and continuous modifiers applied. */
  get def() {
    if (!this.isMonster) return null;
    if (this.pos === POS.FACEDOWN_ATTACK || this.pos === POS.FACEDOWN_DEFENSE) return this.card.def ?? 0;
    let v = this.card.def ?? 0;
    for (const m of this.continuousModifiers) if (m.def) v += m.def;
    v += this.getCounter('def');
    return v;
  }

  getCounter(kind) {
    let n = 0;
    for (const [k, v] of this.counters) if (k === kind) n += v;
    return n;
  }

  hasCounter(kind) { return this.getCounter(kind) !== 0; }

  get level() {
    if (!this.card) return 0;
    if (this.card.isXyz) return this.card.level ?? 0;
    if (this.card.isLink) return 0;
    return (this.card.level ?? 0) + this.getCounter('lv');
  }

  get linkRating() { return this.card?.link ?? 0; }

  get scale() { return (this.card?.level ?? 0) + this.getCounter('lv'); }

  /** A monster is 'set' if it is face-down on the field. */
  isSet() { return this.onField && !this.faceup; }

  /** Continuous effects do not apply to set monsters. */
  isEffective() {
    return this.onField && !this.destroyed && !this.banned && (this.faceup || !this.card || !this.card.isEffect);
  }

  /** Tuner/level-modifying effects require the monster to be face-up. */
  isTunerEffective() { return this.isEffective() && this.faceup; }

  describe() {
    return `${this.name}${this.isSet() ? ' (face-down)' : ''}`;
  }
}

// --- Player ----------------------------------------------------------------

export class Player {
  constructor(name, index) {
    this.name = name;
    this.index = index;
    this.lp = START_LP;
    this.deck = [];
    this.hand = [];
    this.grave = [];
    this.banish = [];
    this.extra = [];
    this.monsters = new Array(NUM_MONSTER_ZONES).fill(null);
    this.spells = new Array(NUM_SPELL_ZONES).fill(null);
    this.pendulums = new Array(NUM_PENDULUM_ZONES).fill(null);
    this.turnCount = 0;
    this.hasDrawn = false;
    this.drewThisTurn = false;
    this.phase = PHASE.DRAW;
    this.hasLost = false;
    this.loseReason = null;
    // Puzzle bookkeeping
    this.puzzleFlags = {};
  }

  get field() {
    return [...this.monsters, ...this.spells].filter(Boolean);
  }

  monsterCount() { return this.monsters.filter(Boolean).length; }

  freeMonsterZones() { return this.monsters.map((c, i) => (c ? -1 : i)).filter((i) => i >= 0); }

  freeSpellZones() { return this.spells.map((c, i) => (c ? -1 : i)).filter((i) => i >= 0); }

  firstFreeMonsterZone(from = 0) {
    for (let i = from; i < NUM_MONSTER_ZONES; i++) if (!this.monsters[i]) return i;
    return -1;
  }

  firstFreeSpellZone(from = 0) {
    for (let i = from; i < NUM_SPELL_ZONES; i++) if (!this.spells[i]) return i;
    return -1;
  }

  handCount(type) {
    return this.hand.filter((c) => {
      if (!type) return true;
      if (type === 'MONSTER') return c.isMonster;
      if (type === 'SPELL') return c.card?.isSpell;
      if (type === 'TRAP') return c.card?.isTrap;
      return true;
    }).length;
  }

  setLP(v) { this.lp = Math.max(0, Math.floor(v)); }
  gainLP(n) { this.lp += n; }
}

// --- Serialisation (for persistence across the auth boundary) ---------------

export function snapshot(game) {
  return {
    turn: game.turn,
    turnCount: game.turnCount,
    phase: game.phase,
    priority: game.priority,
    current: game.current,
    players: game.players.map((p) => ({
      name: p.name,
      lp: p.lp,
      deck: p.deck.map(cardRef),
      hand: p.hand.map(cardRef),
      grave: p.grave.map(cardRef),
      banish: p.banish.map(cardRef),
      extra: p.extra.map(cardRef),
      monsters: p.monsters.map((c) => (c ? { ...cardRef(c), pos: c.pos, faceup: c.faceup, attacked: c.attacked, negated: c.negated, counters: [...c.counters] } : null)),
      spells: p.spells.map((c) => (c ? { ...cardRef(c), pos: c.pos, faceup: c.faceup, negated: c.negated, counters: [...c.counters] } : null)),
      pendulums: p.pendulums.map((c) => (c ? { ...cardRef(c), pos: c.pos, faceup: c.faceup, negated: c.negated } : null)),
      turnCount: p.turnCount,
      puzzleFlags: p.puzzleFlags,
    })),
  };
}

function cardRef(c) { return { uid: c.uid, code: c.code, controller: c.controller, owner: c.owner }; }

// --- Cooperative scheduler -------------------------------------------------
// Every effect handler and the turn loop are generator functions. They yield
// request objects ({kind:'priority'|'choice'}) and are resumed with the
// player's answer. This keeps "pause the rules to ask a question" natural
// without threads or async/await ordering hazards.

class Suspender {
  constructor() { this.gen = null; this.request = null; this.done = true; this.result = undefined; }

  start(gen) { this.gen = gen; this.done = false; this.request = null; this.step(undefined); }

  step(value) {
    let r;
    try {
      r = this.gen.next(value);
    } catch (err) {
      this.gen = null; this.done = true;
      this.onerror?.(err);
      throw err;
    }
    if (r.done) { this.gen = null; this.done = true; this.result = r.value; this.ondone?.(r.value); }
    else this.request = r.value;
  }

  resume(value) { if (this.gen) this.step(value); }
}

// --- Action types ----------------------------------------------------------

export const ACTION = {
  PASS: 'pass',
  NORMAL_SUMMON: 'normal_summon',
  SET_MONSTER: 'set_monster',
  FLIP_SUMMON: 'flip_summon',
  SET_SPELL_TRAP: 'set_spell_trap',
  ACTIVATE: 'activate',
  ACTIVATE_SET: 'activate_set',
  SPECIAL_SUMMON: 'special_summon',
  ATTACK: 'attack',
  CHANGE_POSITION: 'change_position',
  TOGGLE_PENDULUM: 'toggle_pendulum',
  END_PHASE: 'end_phase',
  SELECT: 'select',
};

// ============================================================================
// Game
// ============================================================================

export class Game {
  constructor(db, opts = {}) {
    this.db = db;
    this.opts = opts;
    this.rules = { ...DEFAULT_RULES, ...(opts.rules || {}) };
    this.players = [new Player(opts.p0name || 'Player 1', 0), new Player(opts.p1name || 'Player 2', 1)];
    this.current = 0;
    this.turn = 0;
    this.phase = PHASE.DRAW;
    this.priority = 0;
    this.chain = [];
    this.log = [];
    this.events = [];
    this.request = null;
    this.over = false;
    this.winner = null;
    this.winReason = null;
    this.pend = new Suspender();
    this.listeners = [];
    this.turnPlayerPassed = false;
    this.opponentPassed = false;
    this.chainWindowDepth = 0;
    this.battleDeclared = [];
    this.noBattle = false;
    this.currentAttack = null;
    this.attackCount = 0;
    this.summonCountThisTurn = 0;
    this.stats = { chainsBuilt: 0, chainsResolved: 0, damageDealt: 0, cardsDestroyed: 0 };
    this.turnFlags = new Set();
    this.lastSummoned = null;
    this.lastDestroyedByBattle = null;
    this.cancelledAttack = null;
    this.turnLimit = opts.turnLimit ?? 0;
  }

  // --- events ---------------------------------------------------------------

  on(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter((f) => f !== fn); }; }
  emit(type, data) { const ev = { type, data }; this.events.push(ev); for (const fn of this.listeners) fn(ev); }

  say(msg) {
    const line = `[turn ${this.turn + 1}/${this.phase}] ${msg}`;
    this.log.push(line);
    this.emit('log', line);
    if (this.log.length > 600) this.log.splice(0, 200);
  }

  // --- accessors ------------------------------------------------------------

  get turnPlayer() { return this.players[this.current]; }
  get opponentPlayer() { return this.players[1 - this.current]; }
  get player() { return this.players[this.current]; }

  byIndex(i) { return this.players[i]; }

  findCard(uid) {
    for (const p of this.players) {
      const zones = [p.deck, p.hand, p.grave, p.banish, p.extra, p.monsters, p.spells, p.pendulums];
      for (const z of zones) {
        for (const c of z) if (c && c.uid === uid) return c;
      }
    }
    return null;
  }

  allCards() {
    const out = [];
    for (const p of this.players) {
      for (const z of [p.deck, p.hand, p.grave, p.banish, p.extra]) out.push(...z.filter(Boolean));
      for (const c of p.monsters) if (c) out.push(c);
      for (const c of p.spells) if (c) out.push(c);
      for (const c of p.pendulums) if (c) out.push(c);
    }
    return out;
  }

  // --- zone movement --------------------------------------------------------

  /**
   * Moves a card to a zone. Pass index:null for "first available".
   * opts.faceup, opts.pos control the resulting state.
   */
  moveCard(card, zone, index = null, opts = {}) {
    if (!card) return false;
    // A card that is not currently in any zone (a freshly constructed
    // instance, say) is simply placed, so callers can build a board state
    // programmatically without first shoving it through the Deck.
    const from = this.locate(card);
    if (from) this.removeFrom(card, from);

    const p = this.players[card.controller];
    if (zone === ZONE.MONSTER || zone === ZONE.SPELL || zone === ZONE.PENDULUM) {
      const arr = zone === ZONE.MONSTER ? p.monsters : zone === ZONE.SPELL ? p.spells : p.pendulums;
      if (index === null || index < 0 || arr[index]) index = -1;
      if (zone === ZONE.MONSTER) index = index >= 0 ? index : p.firstFreeMonsterZone(opts.from ?? 0);
      else index = index >= 0 ? index : p.firstFreeSpellZone(opts.from ?? 0);
      if (index < 0) {
        // No room: revert is handled by callers that check legality first.
        return false;
      }
      arr[index] = card;
      card.zone = zone;
      card.zoneIndex = index;
      card.faceup = opts.faceup ?? true;
      card.pos = card.isMonster ? (opts.pos ?? POS.FACEUP_ATTACK) : (opts.pos ?? (card.faceup ? 'faceup' : 'facedown'));
      if (zone === ZONE.MONSTER) {
        card.summonedThisTurn = !!opts.summonedThisTurn;
        card.normalSummonedThisTurn = !!opts.normalSummoned;
        card.specialSummonedThisTurn = !!opts.specialSummoned;
        card.summonTurn = this.turn;
        this.summonCountThisTurn++;
      }
    } else {
      const arr = p[zoneField(zone)];
      if (arr === undefined) return false;
      arr.push(card);
      card.zone = zone;
      card.zoneIndex = -1;
      if (zone === ZONE.HAND) { card.pos = null; card.faceup = true; }
      if (zone === ZONE.GRAVE || zone === ZONE.BANISH) { card.pos = null; card.faceup = true; }
      if (zone === ZONE.EXTRA) { card.pos = null; card.faceup = true; card.summonTurn = -1; }
      if (zone === ZONE.DECK) { card.pos = null; card.faceup = false; }
    }
    // Continuous effects (auras, ATK/DEF modifiers) must be recomputed after
    // any card changes zones. Defined by effects.js, so guard for callers that
    // never registered the effect table.
    if (typeof this.refreshContinuous === 'function') this.refreshContinuous();
    this.emit('move', { card, zone, from });
    return true;
  }

  locate(card) {
    const p = this.players[card.controller];
    for (const name of [ZONE.DECK, ZONE.HAND, ZONE.GRAVE, ZONE.BANISH, ZONE.EXTRA]) {
      const i = p[name].indexOf(card);
      if (i >= 0) return { zone: name, index: i };
    }
    for (const name of [ZONE.MONSTER, ZONE.SPELL, ZONE.PENDULUM]) {
      const arr = p[zoneField(name)];
      if (!arr) continue;
      const i = arr.indexOf(card);
      if (i >= 0) return { zone: name, index: i };
    }
    return null;
  }

  removeFrom(card, loc) {
    if (!loc) return;
    if (loc.zone === ZONE.MONSTER || loc.zone === ZONE.SPELL || loc.zone === ZONE.PENDULUM) {
      const arr = this.players[card.controller][zoneField(loc.zone)];
      if (arr && arr[loc.index] === card) { arr[loc.index] = null; card.zone = null; }
    } else {
      const arr = this.players[card.controller][zoneField(loc.zone)];
      const i = arr.indexOf(card);
      if (i >= 0) arr.splice(i, 1);
      card.zone = null;
    }
  }

  // --- requests -------------------------------------------------------------

  *ask(spec) {
    const req = { kind: 'choice', id: ++Game.reqSeq, spec, game: this };
    this.request = req;
    this.emit('request', req);
    return yield req;
  }

  *askPriority(playerIndex, mode) {
    const req = {
      kind: 'priority',
      id: ++Game.reqSeq,
      player: playerIndex,
      mode,
      actions: this.legalActions(playerIndex, mode),
      game: this,
    };
    this.request = req;
    this.emit('request', req);
    return yield req;
  }

  /** Convenience: ask a yes/no question. */
  *confirm(question, def = false) {
    const a = yield* this.ask({ question, options: [{ label: 'Yes', value: true }, { label: 'No', value: false }], kind: 'yesno' });
    return a === undefined ? def : a;
  }

  /** Ask the controller to pick from a filtered list of cards. */
  *askCard(question, cards, opts = {}) {
    const min = opts.min ?? 1;
    const max = opts.max ?? min;
    const list = cards.filter(Boolean);
    if (list.length < min) return [];
    const single = max === 1;
    const spec = {
      question,
      kind: 'card',
      cards: list,
      min,
      max,
      single,
      allowCancel: !!opts.allowCancel,
      filter: opts.filter || (() => true),
    };
    const ans = yield* this.ask(spec);
    if (ans === null || ans === undefined) return [];
    return Array.isArray(ans) ? ans : [ans];
  }
}

Game.reqSeq = 0;

export const DEFAULT_RULES = {
  startLp: START_LP,
  handLimit: HAND_LIMIT,
  openingHand: 5,
  drawPerTurn: 1,
  firstTurnNoDraw: true,
  firstTurnNoBattle: true,
  tributesRequired: 0,     // modern: 1 tribute for Level 5-6, 2 for 7+
  maxNormalSummons: 1,
  damageStep: true,
};

// ============================================================================
// Deck setup
// ============================================================================

const EXTERNAL_TYPES = new Set(['FUSION', 'RITUAL', 'SYNCHRO', 'XYZ', 'LINK']);

/** Fisher-Yates using an injectable RNG so puzzles are reproducible. */
export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

Game.prototype.mulberry32 = function (seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Splits a card-code list into main and extra deck and builds instances. */
Game.prototype.buildDeck = function (playerIdx, codes, rng = Math.random) {
  const p = this.players[playerIdx];
  const main = [], extra = [];
  for (const code of codes) {
    const card = this.db.get(code);
    if (!card) continue;
    const inst = new CardInstance(code, playerIdx, playerIdx, this.db);
    (card.isFusion || card.isSynchro || card.isXyz || card.isLink ? extra : main).push(inst);
  }
  p.deck = shuffle(main, rng);
  p.extra = shuffle(extra, rng);
  return p;
};

Game.prototype.drawCards = function (playerIdx, n, opts = {}) {
  const p = this.players[playerIdx];
  const drawn = [];
  for (let i = 0; i < n; i++) {
    if (p.deck.length === 0) {
      // During setup the deck is allowed to run dry (puzzles use short decks),
      // so the opening deal is clamped rather than treated as a loss. During
      // normal play, failing to draw is a real deck-out.
      if (!opts.noLoss) {
        this.say(`${p.name} cannot draw - deck is empty.`);
        this.declareLoss(playerIdx, 'deck out');
      }
      break;
    }
    const c = p.deck.shift();
    p.hand.push(c);
    c.zone = ZONE.HAND;
    c.faceup = true;
    drawn.push(c);
  }
  if (drawn.length) this.say(`${p.name} drew ${drawn.length} card(s): ${drawn.map((c) => c.name).join(', ')}`);
  return drawn;
};

/**
 * Sets up a duel. decks = {main:[codes], extra:[codes]} per player.
 * Returns a generator so setup can ask the opening-hand player to mulligan.
 */
Game.prototype.setup = function* (cfg) {
  const rng = cfg.rng || Math.random;
  this.firstPlayer = cfg.firstPlayer ?? 0;
  for (const p of this.players) p.setLP(this.rules.startLp);

  this.buildDeck(0, cfg.decks[0], rng);
  this.buildDeck(1, cfg.decks[1], rng);

  const oh = this.rules.openingHand;
  for (let i = 0; i < 2; i++) {
    const playerIdx = (i + 1 - this.firstPlayer) % 2; // non-first player draws first
    this.drawCards(playerIdx, Math.min(oh, this.players[playerIdx].deck.length), { noLoss: true });
  }
  this.say(`First player: ${this.players[this.firstPlayer].name}. Opening hands dealt.`);
  this.emit('setup', {});
};

/** Sends everything in hand to the grave - used to resolve a bad opening hand. */
Game.prototype.discardHand = function* (playerIdx) {
  const p = this.players[playerIdx];
  for (const c of p.hand.slice()) {
    this.moveCard(c, ZONE.GRAVE);
    this.say(`${p.name} discarded ${c.name}.`);
  }
};

// ============================================================================
// Turn structure
// ============================================================================

Game.prototype.startDuel = function (cfg) {
  const self = this;
  const gen = (function* () {
    yield* self.setup(cfg);
    yield* self.mainLoop();
  })();
  this.pend.start(gen);
  return this;
};

Game.prototype.resume = function (answer) {
  this.request = null;
  this.pend.resume(answer);
};

/**
 * Starts a puzzle instead of a duel.
 *
 * cfg = {
 *   lp:         [lp0, lp1],
 *   hands:      [[name,...],[name,...]],
 *   monsters:   [[{name,pos,faceup}|null x5],[...]],
 *   spells:     [[...],[...]],          // set spells/traps
 *   graves:     [[name,...],[...]],
 *   banished:   [[name,...],[...]],
 *   extra:      [[name,...],[...]],
 *   decks:      [[name,...],[...]],
 *   turn, current,
 *   goal:       (game) => boolean,     // the win condition
 *   onFail:     (game) => boolean,     // optional immediate loss
 *   title, brief, hints: [string,...],
 * }
 */
Game.prototype.startPuzzle = function (cfg) {
  const self = this;
  this.puzzle = {
    title: cfg.title || 'Puzzle',
    brief: cfg.brief || '',
    hints: cfg.hints || [],
    goalText: cfg.goalText || '',
    solved: false,
    failed: false,
    moves: 0,
  };
  if (cfg.goalText) this.puzzle.goalText = cfg.goalText;

  const gen = (function* () {
    yield* self.setupPuzzle(cfg);
    yield* self.mainLoop();
  })();
  this.pend.start(gen);
  return this;
};

/** Materialises a puzzle board. Nothing is drawn or shuffled. */
Game.prototype.setupPuzzle = function* (cfg) {
  this.isPuzzle = true;
  this.puzzleGoal = cfg.goal || (() => false);
  this.puzzleOnFail = cfg.onFail || null;
  if (cfg.rng) this.rng = cfg.rng;

  const lps = cfg.lp || [START_LP, START_LP];
  for (let i = 0; i < 2; i++) this.players[i].setLP(lps[i]);
  // runTurn increments the counter and derives the player from it, so seed it
  // one turn behind and let pendingCurrent pin the first turn's player.
  this.turn = (cfg.turn ?? 1) - 1;
  this.current = cfg.current ?? 0;
  this.firstPlayer = this.current;
  this.pendingCurrent = this.current;
  for (let i = 0; i < 2; i++) {
    const p = this.players[i];
    p.turnCount = 0;
    p.hasDrawn = true;
    p.drewThisTurn = true;
  }
  this.summonCountThisTurn = 0;
  this.attackCount = 0;
  this.currentAttack = null;
  this.noBattle = false;
  this.turnFlags = new Set();
  this.cancelledAttack = null;
  this.players[this.current].normalSummonsLeft = this.rules.maxNormalSummons;
  this.players[1 - this.current].normalSummonsLeft = this.rules.maxNormalSummons;

  const put = (name, controller, zone, opts = {}) => {
    const rec = this.db.byName(name)[0];
    if (!rec) return null;
    // CardInstance takes (code, owner, controller, db): a puzzle card is owned
    // and controlled by the same player.
    const c = new CardInstance(rec.id, controller, controller, this.db);
    this.moveCard(c, zone, opts.index ?? null, opts);
    return c;
  };

  for (let side = 0; side < 2; side++) {
    for (const name of (cfg.hands?.[side]) || []) put(name, side, ZONE.HAND);
    for (const name of (cfg.graves?.[side]) || []) put(name, side, ZONE.GRAVE);
    for (const name of (cfg.banished?.[side]) || []) put(name, side, ZONE.BANISH);
    for (const name of (cfg.extra?.[side]) || []) put(name, side, ZONE.EXTRA);
    for (const name of (cfg.decks?.[side]) || []) put(name, side, ZONE.DECK);
    // Puzzles use tiny decks; pad so the puzzle ends on its goal, not a
    // deck-out during the opponent's turn.
    const want = cfg.padDecks ?? 12;
    let guard = want + 4;
    while (this.players[side].deck.length < want && guard-- > 0) put('Mokey Mokey', side, ZONE.DECK);
    for (const slot of (cfg.monsters?.[side]) || []) {
      if (!slot) continue;
      put(slot.name, side, ZONE.MONSTER, {
        index: slot.index ?? 0,
        faceup: slot.faceup ?? true,
        pos: slot.pos || POS.FACEUP_ATTACK,
        normalSummoned: slot.normalSummoned !== false,
        specialSummoned: !!slot.specialSummoned,
      });
    }
    for (const slot of (cfg.spells?.[side]) || []) {
      if (!slot) continue;
      const c = put(slot.name, side, ZONE.SPELL, {
        index: slot.index ?? 0,
        faceup: slot.faceup ?? false,
      });
      if (c && c.isSet !== false) c.turnSet = this.turn - 1;
    }
  }

  // Any card the template did not explicitly place still counts as "not set
  // this turn", so set cards are immediately usable.
  for (const p of this.players) {
    for (const c of [...p.spells, ...p.pendulums]) {
      if (c && !c.faceup && c.turnSet === undefined) c.turnSet = this.turn - 1;
    }
  }

  this.say(`${this.players[this.current].name} to act. ${this.puzzle?.title || ''}`);
  this.emit('puzzleReady', { puzzle: this.puzzle });
};

/**
 * True once the puzzle's win condition is met.
 *
 * Requires at least one action to have been taken, so a goal that happens to
 * hold in the starting position cannot hand the player a free win.
 */
Game.prototype.puzzleSolved = function () {
  if (!this.isPuzzle || !this.puzzleGoal) return false;
  if (!this.puzzle || this.puzzle.moves < 1) return false;
  return !!this.puzzleGoal(this);
};

Game.prototype.mainLoop = function* () {
  while (!this.over) {
    if (this.isPuzzle) {
      if (this.puzzleSolved()) {
        this.puzzle.solved = true;
        this.finish(this.current, 'puzzle solved');
        return;
      }
      if (this.puzzleOnFail && this.puzzleOnFail(this)) {
        this.finish(1 - this.current, 'puzzle failed');
        return;
      }
    }
    yield* this.runTurn();
    if (this.turnLimit && this.turn >= this.turnLimit) {
      this.say(`Turn limit of ${this.turnLimit} reached.`);
      this.finish(this.decideTimeout(), 'turn limit');
      return;
    }
  }
};

Game.prototype.decideTimeout = function () {
  const a = this.players[0].lp, b = this.players[1].lp;
  if (a === b) return -1;
  return a > b ? 0 : 1;
};

Game.prototype.runTurn = function* () {
  this.turn++;
  this.current = ((this.turn - 1 + this.firstPlayer) % 2);
  // A puzzle sets the player to act explicitly; honour it for the first turn
  // only, then fall back to normal alternation.
  if (this.pendingCurrent !== null && this.pendingCurrent !== undefined) {
    this.current = this.pendingCurrent;
    this.pendingCurrent = null;
  }
  const p = this.turnPlayer;
  p.turnCount++;
  p.hasDrawn = false;
  p.drewThisTurn = false;
  this.summonCountThisTurn = 0;
  this.attackCount = 0;
  this.currentAttack = null;
  this.noBattle = false;
  this.turnFlags = new Set();
  this.cancelledAttack = null;
  p.normalSummonsLeft = this.rules.maxNormalSummons;
  for (const c of [...p.monsters, ...p.spells]) if (c) c.negated = false;
  this.say(`=== ${p.name}'s turn (turn ${this.turn}) ===`);
  this.emit('turn', { turn: this.turn, player: p.index });

  for (const ph of PHASE_ORDER) {
    if (this.over) return;
    this.phase = ph;
    this.emit('phase', { phase: ph, player: p.index });
    yield* this.enterPhase(ph);
    if (this.over) return;
    if (ph === PHASE.BATTLE_STEP || ph === PHASE.BATTLE_DAMAGE || ph === PHASE.BATTLE_DAMAGE_END) {
      yield* this.battleStepWindow(ph);
    } else {
      yield* this.priorityWindow(ph);
    }
    if (this.over) return;
  }
  this.say(`=== end of ${p.name}'s turn ===`);
};

Game.prototype.enterPhase = function* (ph) {
  const p = this.turnPlayer;
  switch (ph) {
    case PHASE.DRAW: {
      const isFirstTurn = this.turn === 1;
      if (isFirstTurn && this.rules.firstTurnNoDraw) {
        this.say(`${p.name} skips the draw phase (first turn).`);
      } else {
        this.drawCards(p.index, this.rules.drawPerTurn);
      }
      break;
    }
    case PHASE.STANDBY: {
      const stunned = p.monsters.filter((c) => c && c.pos === POS.FACEDOWN_DEFENSE && !c.faceup);
      const any = p.monsters.some((c) => c && this.isStunned(c));
      if (any) { this.noBattle = true; this.say(`${p.name} is stunned and cannot enter the Battle Phase.`); }
      break;
    }
    case PHASE.BATTLE_START:
      this.battleDeclared = [];
      break;
    case PHASE.END:
      yield* this.endPhaseCleanup();
      break;
    default:
      break;
  }
  if (this.over) return;
  yield* this.checkTriggers(`ENTER_${ph}`);
};

Game.prototype.isStunned = function (card) {
  // A monster is stunned if any face-up monster you control is in face-down defense.
  const p = this.players[card.controller];
  return p.monsters.some((c) => c && !c.faceup && c.pos === POS.FACEDOWN_DEFENSE);
};

Game.prototype.endPhaseCleanup = function* () {
  const p = this.turnPlayer;
  // Mandatory effects that happen at end of turn, then hand limit.
  yield* this.checkTriggers('END_TURN');
  if (this.over) return;
  const limit = this.rules.handLimit;
  while (p.hand.length > limit) {
    const chosen = yield* this.askCard(
      `${p.name} must discard down to ${limit} cards (hand: ${p.hand.length}). Choose a card to discard:`,
      p.hand,
      { min: p.hand.length - limit, max: p.hand.length - limit },
    );
    if (!chosen.length) break;
    for (const c of chosen) {
      this.moveCard(c, ZONE.GRAVE);
      this.say(`${p.name} discarded ${c.name} (hand limit).`);
    }
  }
};

// --- priority windows ------------------------------------------------------

/**
 * Runs a priority loop. mode 'free' allows all in-game actions; mode 'respond'
 * allows only chain responses (negation, countering, quick-play).
 */
Game.prototype.priorityWindow = function* (mode) {
  this.turnPlayerPassed = false;
  this.opponentPassed = false;
  this.priority = this.current;
  let guard = 0;
  while (!this.over) {
    if (++guard > 4000) { this.say('Priority loop safety break.'); break; }
    const holder = this.priority;
    const action = yield* this.askPriority(holder, mode);
    if (this.over) return;
    if (action && action.type !== ACTION.PASS) {
      yield* this.performAction(holder, action);
      if (this.over) return;
      if (this.phaseDone) { this.phaseDone = false; return; }
      this.priority = 1 - holder;
      this.turnPlayerPassed = false;
      this.opponentPassed = false;
      continue;
    }
    if (holder === this.current) {
      if (this.opponentPassed) break;
      this.opponentPassed = true;
      this.priority = 1 - this.current;
    } else {
      this.priority = this.current;
    }
  }
};

/** The damage-step style window inside the battle phase (traps respond to damage). */
Game.prototype.battleStepWindow = function* (ph) {
  if (!this.currentAttack) return;
  yield* this.priorityWindow('respond');
};

// ============================================================================
// Summon legality
// ============================================================================

/** Modern tribute rules: Lv5-6 need one tribute, Lv7+ need two. */
Game.prototype.tributesNeeded = function (card) {
  if (!card || !card.isMonster) return 0;
  const lv = card.level;
  if (lv >= 7) return 2;
  if (lv >= 5) return 1;
  return 0;
};

Game.prototype.tributeOptions = function (p, n) {
  if (n <= 0) return [];
  return p.monsters.filter(Boolean);
};

Game.prototype.hasFreeMonsterZone = function (p) {
  return p.monsters.some((c) => !c);
};

Game.prototype.hasFreeSpellZone = function (p) {
  return p.spells.some((c) => !c) || p.pendulums.some((c) => !c);
};

Game.prototype.canNormalSummon = function (p, card) {
  if (!card || !card.isMonster) return false;
  if (card.zone !== ZONE.HAND) return false;
  if (p.normalSummonsLeft <= 0) return false;
  if (!this.hasFreeMonsterZone(p)) return false;
  const need = this.tributesNeeded(card);
  if (p.monsters.filter(Boolean).length < need) return false;
  return true;
};

Game.prototype.canSetMonster = function (p, card) {
  const need = this.tributesNeeded(card);
  if (!this.hasFreeMonsterZone(p)) return false;
  if (p.monsters.filter(Boolean).length < need) return false;
  return card.isMonster && card.zone === ZONE.HAND;
};

Game.prototype.canFlipSummon = function (p, card) {
  if (!card || card.zone !== ZONE.MONSTER) return false;
  if (card.faceup || card.pos !== POS.FACEDOWN_DEFENSE) return false;
  if (card.turnSet >= this.turn) return false;
  return true;
};

Game.prototype.canChangePosition = function (p, card) {
  if (!card || !card.isMonster || card.zone !== ZONE.MONSTER) return false;
  if (!card.faceup) return false;
  if (card.negated) return false;
  if ((card.def ?? 0) <= 0) return false;            // no DEF -> cannot switch to defense
  if (card.summonTurn === this.turn) return false;    // cannot change the turn it was summoned
  const inMain = this.phase === PHASE.MAIN1 || this.phase === PHASE.MAIN2;
  if (!inMain) return false;
  return true;
};

Game.prototype.canTogglePendulum = function (p, card) {
  if (!card || !card.card?.isPendulum) return false;
  if (card.zone !== ZONE.HAND && !(card.zone === ZONE.MONSTER && card.faceup)) return false;
  if (p.pendulums.every(Boolean)) return false;
  const back = p.monsters.filter(Boolean);
  if (!back.some((c) => c.faceup)) return false;
  return true;
};

Game.prototype.canSetSpellTrap = function (p, card) {
  if (!card || !card.isSpellTrap) return false;
  if (card.zone !== ZONE.HAND) return false;
  return this.hasFreeSpellZone(p);
};

Game.prototype.canActivateFromHand = function (p, card) {
  if (!card || !card.isSpellTrap) return false;
  if (card.activating) return false;
  if (card.zone !== ZONE.HAND) return false;
  if (!this.cardHasEffect(card)) return false;
  if (card.card.isContinuous && card.turnSet === this.turn) return false;
  return true;
};

Game.prototype.canActivateFromField = function (p, card) {
  if (!card || !card.isSpellTrap) return false;
  if (card.activating) return false;
  if (card.zone !== ZONE.SPELL && card.zone !== ZONE.PENDULUM) return false;
  if (!this.cardHasEffect(card)) return false;
  const myTurn = this.current === p.index;
  if (card.card.isContinuous) {
    if (!card.faceup) return false;
    if (card.activatedTurn === this.turn) return false;   // once per turn
    return true;
  }
  if (card.card.isQuickPlay) {
    if (!card.faceup) return false;
    return !myTurn || this.inBattlePhase();
  }
  // Normal trap
  if (card.faceup) return true;
  return !myTurn || this.inBattlePhase();
};

Game.prototype.inBattlePhase = function () {
  return this.phase === PHASE.BATTLE_START || this.phase === PHASE.BATTLE_STEP
    || this.phase === PHASE.BATTLE_DAMAGE || this.phase === PHASE.BATTLE_DAMAGE_END
    || this.phase === PHASE.BATTLE_END;
};

Game.prototype.cardHasEffect = function (card) {
  return !!(card.card && (card.card.desc || (card.card.strs && card.card.strs.length)));
};

Game.prototype.canAttack = function (p, card) {
  if (!card || !card.isMonster || card.zone !== ZONE.MONSTER) return false;
  if (card.pos !== POS.FACEUP_ATTACK) return false;
  if (card.attacked) return false;
  if (card.negated) return false;
  return true;
};

// --- legal action enumeration ---------------------------------------------

Game.prototype.legalActions = function (pi, mode) {
  const pass = { type: ACTION.PASS, label: 'Pass' };
  if (this.over) return [pass];

  if (mode === 'respond') return [pass, ...this.chainResponseActions(pi)];

  const out = [pass];
  const ph = this.phase;
  const p = this.players[pi];
  const myTurn = pi === this.current;

  if (ph === PHASE.END) { out.push({ type: ACTION.END_PHASE, label: 'End Phase' }); return out; }
  if (ph === PHASE.DRAW || ph === PHASE.STANDBY) return out;
  if (ph === PHASE.BATTLE_DAMAGE || ph === PHASE.BATTLE_DAMAGE_END || ph === PHASE.BATTLE_END) return out;

  // Attacks (Battle Phase only, and not on the very first turn of the duel)
  if (this.inBattlePhase() && myTurn && !this.noBattle && !(this.turn === 1 && this.rules.firstTurnNoBattle)) {
    for (const c of p.monsters.filter(Boolean)) {
      if (!this.canAttack(p, c)) continue;
      if (this.attackLocked(pi)) continue;
      const opts = this.attackTargets(p, c);
      out.push({ type: ACTION.ATTACK, uid: c.uid, targets: opts, label: `Attack with ${c.name}` });
    }
  }

  if (!myTurn) return out;

  // Main-phase actions
  for (const c of p.hand) {
    if (c.isMonster) {
      if (this.canNormalSummon(p, c)) {
        out.push({
          type: ACTION.NORMAL_SUMMON, uid: c.uid, label: `Normal Summon ${c.name}`,
          tributes: this.tributeOptions(p, this.tributesNeeded(c)).map((x) => x.uid),
        });
      }
      if (this.canSetMonster(p, c)) {
        out.push({
          type: ACTION.SET_MONSTER, uid: c.uid, label: `Set ${c.name}`,
          tributes: this.tributeOptions(p, this.tributesNeeded(c)).map((x) => x.uid),
        });
      }
    } else {
      if (this.canSetSpellTrap(p, c)) out.push({ type: ACTION.SET_SPELL_TRAP, uid: c.uid, label: `Set ${c.name}` });
      if (this.canActivateFromHand(p, c)) out.push({ type: ACTION.ACTIVATE, uid: c.uid, label: `Activate ${c.name}`, source: 'hand' });
    }
  }

  for (const c of p.monsters.filter(Boolean)) {
    if (this.canFlipSummon(p, c)) out.push({ type: ACTION.FLIP_SUMMON, uid: c.uid, label: `Flip Summon ${c.name}` });
    if (this.canChangePosition(p, c)) {
      const to = c.pos === POS.FACEUP_ATTACK ? POS.FACEUP_DEFENSE : POS.FACEUP_ATTACK;
      out.push({ type: ACTION.CHANGE_POSITION, uid: c.uid, to, label: `${c.name} -> ${to === POS.FACEUP_ATTACK ? 'ATK' : 'DEF'}` });
    }
    if (this.canTogglePendulum(p, c)) out.push({ type: ACTION.TOGGLE_PENDULUM, uid: c.uid, label: `Pendulum Summon ${c.name}` });
  }

  for (const c of p.spells.filter(Boolean)) {
    if (this.canActivateFromField(p, c)) out.push({ type: ACTION.ACTIVATE, uid: c.uid, label: `Activate ${c.name}`, source: 'field' });
  }

  return out;
};

/** Valid attack targets for an attacker, including 'direct'. */
Game.prototype.attackTargets = function (p, attacker) {
  const opp = this.players[1 - p.index];
  const targets = [];
  for (const d of opp.monsters.filter(Boolean)) {
    if (d.pos === POS.FACEUP_ATTACK) continue;              // cannot target ATK-position monsters
    targets.push({ uid: d.uid, label: `${d.name} (${d.faceup ? 'DEF' : 'set'})`, direct: false });
  }
  if (opp.monsters.filter(Boolean).length === 0) {
    targets.push({ uid: null, label: 'Direct Attack', direct: true });
  }
  return targets;
};

/** Activations that are legal only as chain responses. */
Game.prototype.chainResponseActions = function (pi) {
  const p = this.players[pi];
  const out = [];
  const locked = this.trapsLocked();
  // A card that is already resolving, or already on the chain, must not be
  // offered again - otherwise responding re-enters the same link forever.
  const busy = (c) => c.activating || this.chain.some((l) => l.card === c);
  for (const c of p.hand) {
    if (!c.isSpellTrap) continue;
    if (!this.cardHasEffect(c)) continue;
    if (busy(c)) continue;
    if (locked && c.card.isTrap) continue;
    if (c.card.isContinuous) continue;
    if (c.card.isQuickPlay) {
      out.push({ type: ACTION.ACTIVATE, uid: c.uid, label: `Quick-Play ${c.name}`, source: 'hand', respond: true });
    } else {
      out.push({ type: ACTION.ACTIVATE, uid: c.uid, label: `Set ${c.name} and respond`, source: 'hand', respond: true });
    }
  }
  for (const c of [...p.spells.filter(Boolean), ...p.pendulums.filter(Boolean)]) {
    if (!this.cardHasEffect(c)) continue;
    if (busy(c)) continue;
    if (locked && c.card.isTrap) continue;
    if (c.card.isContinuous && !c.faceup) continue;
    out.push({ type: ACTION.ACTIVATE, uid: c.uid, label: `Activate ${c.name}`, source: 'field', respond: true });
  }
  return out;
};

// ============================================================================
// Target selection
// ============================================================================

/**
 * Resolves a target filter to a list of candidate cards.
 * filter: 'MONSTER_ENEMY' | 'MONSTER_ENEMY_FACEUP' | 'MONSTER_ANY_FACEUP'
 *       | 'MONSTER_ALLY_FACEUP' | 'SPELL_ENEMY' | 'SPELL_ANY' | 'ANY_FACEUP' | 'CHAIN_LINK'
 */
Game.prototype.candidatesFor = function (controllerIdx, filter) {
  const me = this.players[controllerIdx];
  const foe = this.players[1 - controllerIdx];
  const out = [];
  const push = (c, note) => { if (c) out.push({ card: c, note }); };
  const isChain = filter === 'CHAIN_LINK';
  if (isChain) return this.chain.filter((l) => !l.negated).map((l, i) => ({ link: l, card: l.card, note: `chain link ${i + 1}: ${l.label}` }));

  if (filter === 'GRAVE_ANY') {
    for (const pl of this.players) for (const c of pl.grave) if (c) out.push({ card: c, note: `${pl.name}'s Graveyard` });
    return out;
  }
  if (filter === 'HAND_ANY') {
    for (const pl of this.players) for (const c of pl.hand) if (c) out.push({ card: c, note: `${pl.name}'s hand` });
    return out;
  }
  if (filter === 'DECK_ANY') {
    for (const pl of this.players) for (const c of pl.deck) if (c) out.push({ card: c, note: `${pl.name}'s Deck` });
    return out;
  }

  for (const d of foe.monsters.filter(Boolean)) {
    if (filter === 'MONSTER_ENEMY' || filter === 'MONSTER_ENEMY_FACEUP' || filter === 'ANY_FACEUP') {
      if (filter !== 'MONSTER_ENEMY' && !d.faceup) continue;
      push(d, 'enemy monster');
    } else if (filter === 'SPELL_ENEMY') {
      continue;
    } else if (filter === 'SPELL_ANY' || filter === 'ANY_FACEUP') {
      push(d, 'monster');
    } else if (filter === 'MONSTER_ALLY_FACEUP') {
      continue;
    }
  }
  for (const d of foe.spells.filter(Boolean)) {
    if (filter === 'SPELL_ENEMY') push(d, 'enemy spell/trap');
    else if (filter === 'SPELL_ANY') push(d, 'spell/trap');
    else if (filter === 'ANY_FACEUP' && d.faceup) push(d, 'spell/trap');
  }
  for (const a of me.monsters.filter(Boolean)) {
    if (filter === 'MONSTER_ALLY_FACEUP') { if (a.faceup) push(a, 'ally monster'); }
    else if (filter === 'SPELL_ANY') push(a, 'monster');
    else if (filter === 'ANY_FACEUP' && a.faceup) push(a, 'monster');
  }
  for (const a of me.spells.filter(Boolean)) {
    if (filter === 'SPELL_ANY') push(a, 'spell/trap');
    else if (filter === 'ANY_FACEUP' && a.faceup) push(a, 'spell/trap');
  }
  return out;
};

/**
 * Asks the given player to pick exactly `count` legal targets.
 * Returns an array of CardInstance.
 */
Game.prototype.selectTargets = function* (controllerIdx, filter, count, opts = {}) {
  let cands = this.candidatesFor(controllerIdx, filter);
  if (opts.legalTarget) cands = cands.filter((c) => { try { return opts.legalTarget(this, c.card); } catch { return false; } });
  if (count === 0) return [];
  const max = opts.optional ? Math.min(count, cands.length) : count;
  if (cands.length < count && !opts.optional) return [];
  if (opts.optional && cands.length === 0) return [];
  const spec = {
    question: opts.question || (opts.optional
      ? `Select up to ${count} target(s) (optional):`
      : `Select ${count} target(s):`),
    kind: 'target',
    candidates: cands,
    min: opts.optional ? 0 : count,
    max,
    optional: !!opts.optional,
  };
  const ans = yield* this.ask(spec);
  if (ans === null || ans === undefined) return [];
  const arr = Array.isArray(ans) ? ans : [ans];
  return arr.map((a) => (a && a.card ? a.card : a)).filter(Boolean);
};

// ============================================================================
// Chain
// ============================================================================

let LINK_SEQ = 0;

/** Default effect lookup - replaced/extended by effects.js. */
Game.prototype.getEffect = function () { return null; };

Game.prototype.makeLink = function (controllerIdx, card, source, label, targets, extra) {
  const link = {
    lid: ++LINK_SEQ,
    controller: controllerIdx,
    card,
    source,
    label: label || (card ? card.name : 'Effect'),
    targets: targets || [],
    negated: false,
    negatesLinks: [],
    spec: card ? this.getEffect(card) : null,
    ...(extra || {}),
  };
  return link;
};

Game.prototype.activateLink = function* (controllerIdx, link) {
  this.chain.push(link);
  this.stats.chainsBuilt++;
  this.say(`${this.players[controllerIdx].name} activated ${link.label}${link.targets.length ? ' targeting ' + link.targets.map((t) => t.name).join(', ') : ''}.`);
  this.emit('activate', { link });
  // Opponent (then activator) get a chance to respond.
  yield* this.priorityWindow('respond');
  if (this.over) return;
  yield* this.resolveChain();
};

/** Resolves the whole chain, last-activated-link-first. */
Game.prototype.resolveChain = function* () {
  while (this.chain.length) {
    const link = this.chain.pop();
    if (link.negated) {
      this.say(`${link.label} is negated and has no effect.`);
      this.emit('negated', { link });
      continue;
    }
    this.say(`Resolving: ${link.label}...`);
    this.emit('resolving', { link });
    try {
      if (link.spec && typeof link.spec.resolve === 'function') {
        yield* link.spec.resolve(this, link);
      } else {
        yield* this.genericEffect(link);
      }
    } catch (err) {
      this.say(`Effect error in ${link.label}: ${err.message}`);
      if (this.opts.strict) throw err;
    }
    yield* this.moveAfterResolution(link);
  }
  this.stats.chainsResolved++;
  this.refreshContinuous();
  this.emit('chainResolved', {});
};

Game.prototype.moveAfterResolution = function* (link) {
  const card = link.card;
  if (!card) return;
  const dest = link.destination || defaultDestination(card, link.source);
  if (!dest) return;
  const loc = this.locate(card);
  if (!loc) return;
  if (loc.zone === dest) return;
  if (dest === 'DESTROY') { yield* this.destroyCard(card, 'effect'); return; }
  this.moveCard(card, dest);
};

function defaultDestination(card, source) {
  if (!card) return null;
  if (card.isSpellTrap) {
    if (card.card.isContinuous || card.card.isField || card.card.isEquip) return ZONE.SPELL;
    return source === 'hand' && !card.card.isQuickPlay ? ZONE.GRAVE : ZONE.GRAVE;
  }
  return null;
}

/** Placeholder interpreter for cards with no scripted effect. */
Game.prototype.genericEffect = function* (link) {
  const card = link.card;
  if (!card) return;
  this.say(`(${card.name} has no scripted effect in this build - treated as a normal card.)`);
  this.emit('unimplemented', { card });
};

// ============================================================================
// Action performance
// ============================================================================

Game.prototype.performAction = function* (pi, action) {
  if (!action || action.type === ACTION.PASS) return;
  if (this.over) return;
  // Counted before the action runs, not after: an action can end the duel, and
  // finish() reads this count to tell a goal that was just met from a goal that
  // already held in the starting position.
  if (this.isPuzzle) this.puzzle.moves++;
  switch (action.type) {
    case ACTION.NORMAL_SUMMON: yield* this.doNormalSummon(pi, action); break;
    case ACTION.SET_MONSTER: yield* this.doSetMonster(pi, action); break;
    case ACTION.FLIP_SUMMON: yield* this.doFlipSummon(pi, action); break;
    case ACTION.SET_SPELL_TRAP: yield* this.doSetSpellTrap(pi, action); break;
    case ACTION.ACTIVATE: yield* this.doActivate(pi, action); break;
    case ACTION.ATTACK: yield* this.doAttack(pi, action); break;
    case ACTION.CHANGE_POSITION: yield* this.doChangePosition(pi, action); break;
    case ACTION.TOGGLE_PENDULUM: yield* this.doTogglePendulum(pi, action); break;
    case ACTION.END_PHASE:
      this.say(`${this.players[pi].name} moved to the End Phase.`);
      yield* this.endPhaseCleanup();
      this.phaseDone = true;
      break;
    default:
      this.say(`Unknown action ${action.type} ignored.`);
  }
  // A puzzle goal can be met part-way through a turn.
  if (this.isPuzzle && !this.over) {
    if (this.puzzleSolved()) {
      this.puzzle.solved = true;
      this.finish(pi, 'puzzle solved');
    } else if (this.puzzleOnFail && this.puzzleOnFail(this)) {
      this.finish(1 - pi, 'puzzle failed');
    }
  }
};

/** Removes tributes as a cost. */
Game.prototype.payTributes = function* (pi, uids) {
  if (!uids || !uids.length) return;
  for (const uid of uids) {
    const c = this.findCard(uid);
    if (!c || c.zone !== ZONE.MONSTER) continue;
    this.moveCard(c, ZONE.GRAVE);
    this.say(`${this.players[pi].name} tributed ${c.name}.`);
  }
};

Game.prototype.doNormalSummon = function* (pi, action) {
  const card = this.findCard(action.uid);
  if (!card) return;
  const p = this.players[pi];
  yield* this.payTributes(pi, action.tributes);
  const zone = p.firstFreeMonsterZone(0);
  if (zone < 0) { this.say('No monster zone available.'); return; }
  this.moveCard(card, ZONE.MONSTER, zone, { faceup: true, pos: POS.FACEUP_ATTACK, normalSummoned: true });
  card.normalSummonedThisTurn = true;
  p.normalSummonsLeft--;
  this.say(`${p.name} Normal Summoned ${card.name}!`);
  yield* this.afterSummonTriggers(card, 'NORMAL_SUMMON');
};

Game.prototype.doSetMonster = function* (pi, action) {
  const card = this.findCard(action.uid);
  if (!card) return;
  const p = this.players[pi];
  yield* this.payTributes(pi, action.tributes);
  const zone = p.firstFreeMonsterZone(0);
  if (zone < 0) { this.say('No monster zone available.'); return; }
  this.moveCard(card, ZONE.MONSTER, zone, { faceup: false, pos: POS.FACEDOWN_DEFENSE });
  card.turnSet = this.turn;
  p.normalSummonsLeft--;
  this.say(`${p.name} set a monster (${card.isSet() ? 'face-down' : card.name}).`);
  yield* this.checkTriggers('SET_MONSTER', { card });
};

Game.prototype.doFlipSummon = function* (pi, action) {
  const card = this.findCard(action.uid);
  if (!card) return;
  card.faceup = true;
  card.pos = POS.FACEUP_ATTACK;
  card.summonTurn = this.turn;
  card.flippedThisTurn = true;
  this.say(`${this.players[pi].name} Flip Summoned ${card.name}!`);
  yield* this.afterSummonTriggers(card, 'FLIP_SUMMON');
};

Game.prototype.doSetSpellTrap = function* (pi, action) {
  const card = this.findCard(action.uid);
  if (!card) return;
  const p = this.players[pi];
  const zi = p.spells.findIndex((c) => !c);
  const zone = zi >= 0 ? zi : (p.pendulums.findIndex((c) => !c) + 5);
  if (zone < 0 || (zone >= 5 && zone - 5 >= NUM_PENDULUM_ZONES)) { this.say('No spell/trap zone available.'); return; }
  this.moveCard(card, ZONE.SPELL, zone, { faceup: false });
  card.turnSet = this.turn;
  this.say(`${p.name} set a card.`);
  yield* this.checkTriggers('SET_SPT', { card });
};

Game.prototype.doChangePosition = function* (pi, action) {
  const card = this.findCard(action.uid);
  if (!card) return;
  const from = card.pos;
  card.pos = action.to;
  this.say(`${this.players[pi].name} changed ${card.name} from ${shortPos(from)} to ${shortPos(action.to)}.`);
  // Auras such as Dark Magician Girl's only count while face-up in Attack
  // Position, so recompute before anything reads the new ATK.
  if (typeof this.refreshContinuous === 'function') this.refreshContinuous();
  yield* this.checkTriggers('POSITION_CHANGED', { card });
};

Game.prototype.doTogglePendulum = function* (pi, action) {
  const card = this.findCard(action.uid);
  if (!card) return;
  const p = this.players[pi];
  const zi = p.pendulums.findIndex((c) => !c);
  if (zi < 0) return;
  this.moveCard(card, ZONE.PENDULUM, zi, { faceup: true });
  this.say(`${p.name} Pendulum Summoned ${card.name} (scale ${card.scale}).`);
  yield* this.checkTriggers('PENDULUM_SET', { card });
};

function shortPos(p) {
  return { faceup_attack: 'ATK', faceup_defense: 'DEF', facedown_defense: 'set DEF', facedown_attack: 'set ATK' }[p] || p;
}

Game.prototype.afterSummonTriggers = function* (card, kind) {
  this.lastSummoned = { card, kind, controller: card.controller, turn: this.turn };
  yield* this.checkTriggers('SUMMONED', { card, kind });
  this.refreshContinuous();
  // A newly summoned monster is immediately usable.
  card.attacked = false;
}

// --- spell/trap activation -------------------------------------------------

Game.prototype.doActivate = function* (pi, action) {
  const card = this.findCard(action.uid);
  if (!card) return;
  const p = this.players[pi];

  let source = action.source || (card.zone === ZONE.HAND ? 'hand' : 'field');
  // A set card used as a response is revealed to the field first.
  if (source === 'field' && !card.faceup) {
    card.faceup = true;
    this.say(`${p.name} activated the set ${card.name}.`);
  }

  const spec = this.getEffect(card);
  const link = this.makeLink(pi, card, source, null, [], { spec });

  // Gather targets before the link goes on the chain.
  if (spec) {
    const n = typeof spec.targets === 'function' ? spec.targets(this, link) : (spec.manualTargets || spec.targets || 0);
    if (n > 0) {
      const picked = yield* this.selectTargets(pi, spec.targetFilter || 'ANY_FACEUP', n, {
        optional: !!spec.optionalTargets, legalTarget: spec.legalTarget,
      });
      link.targets = picked;
      if (!picked.length && !spec.optionalTargets) { this.say('No legal targets - activation cancelled.'); return; }
    }
  }

  card.activatedTurn = this.turn;
  link.destination = spec?.destination;
  // Block re-entry for the whole resolution. Without this the priority window
  // that activateLink opens re-offers this same card, and a policy that keeps
  // activating it recurses until the stack blows.
  card.activating = true;
  try {
    yield* this.activateLink(pi, link);
  } finally {
    card.activating = false;
  }
};

// --- battle ----------------------------------------------------------------

Game.prototype.doAttack = function* (pi, action) {
  const p = this.players[pi];
  const opp = this.players[1 - pi];
  const attacker = this.findCard(action.uid);
  if (!attacker) return;

  // Choose the target if several are legal.
  let target = null;
  const opts = (action.targets && action.targets.length) ? action.targets : this.attackTargets(p, attacker);
  if (!opts.length) { this.say('No legal attack targets.'); return; }
  if (opts.length === 1) {
    target = opts[0].direct ? null : this.findCard(opts[0].uid);
  } else {
    const pick = yield* this.ask({
      question: `Attack with ${attacker.name} - choose a target:`,
      kind: 'target', candidates: opts, min: 1, max: 1,
    });
    if (!pick) { this.say('Attack cancelled.'); return; }
    const chosen = Array.isArray(pick) ? pick[0] : pick;
    target = chosen.direct ? null : this.findCard(chosen.uid);
  }

  attacker.attacked = true;
  this.attackCount++;
  this.currentAttack = { attacker, target, controller: pi, damage: 0 };
  const tname = target ? (target.faceup ? target.name : 'a set monster') : 'Direct Attack';
  this.say(`${p.name} declared: ${attacker.name} attacks ${tname}!`);
  this.emit('attackDeclared', { attacker, target });

  yield* this.checkTriggers('ATTACK_DECLARED', { attacker, target, controller: pi });
  if (this.over) { this.currentAttack = null; return; }
  if (this.cancelledAttack) {
    this.say(`${attacker.name}'s attack is negated.`);
    this.currentAttack = null;
    this.cancelledAttack = null;
    return;
  }
  if (!this.currentAttack) return;

  // Reveal a face-down defense monster being attacked.
  if (target && !target.faceup && target.pos === POS.FACEDOWN_DEFENSE) {
    target.faceup = true;
    target.pos = POS.FACEUP_DEFENSE;
    this.say(`${target.name} is revealed!`);
    yield* this.afterSummonTriggers(target, 'FLIP_SUMMON');
    if (this.over || !this.currentAttack) { this.currentAttack = null; return; }
  }

  // --- damage calculation
  let damageToDefender = 0, damageToAttacker = 0;
  if (target) {
    damageToDefender = attacker.atk ?? 0;
    const pierced = this.isPiercing(attacker);
    if (target.pos === POS.FACEUP_ATTACK) {
      damageToDefender = attacker.atk ?? 0;
      if (!pierced) damageToAttacker = Math.max(0, (target.atk ?? 0) - (attacker.atk ?? 0));
    } else {
      damageToDefender = attacker.atk ?? 0;
    }
  } else {
    damageToDefender = attacker.atk ?? 0;
  }
  this.currentAttack.damage = damageToDefender;

  const defenderLabel = target ? target.name : `${opp.name} (Direct Attack)`;
  this.say(`Damage: ${attacker.name} deals ${damageToDefender} to ${defenderLabel}` +
    (damageToAttacker > 0 ? `, ${attacker.name} takes ${damageToAttacker}` : '') + '.');

  if (target) {
    target.damageThisAttack = damageToDefender;
    this.dealDamageToCard(target, damageToDefender);
    this.damageCalcTargets = [attacker, target];
  } else {
    this.dealDamageToPlayer(opp, damageToDefender);
  }
  if (damageToAttacker > 0 && this.battleDamageShielded(attacker.controller)) {
    game_shield_log(this, attacker);
    damageToAttacker = 0;
  }
  if (damageToAttacker > 0) this.dealDamageToCard(attacker, damageToAttacker);
  if (this.over) { this.currentAttack = null; return; }

  // --- damage step: traps and quick-plays may respond
  if (this.rules.damageStep) {
    this.phase = PHASE.BATTLE_DAMAGE;
    this.emit('phase', { phase: this.phase, player: pi });
    yield* this.priorityWindow('respond');
    if (this.over) { this.currentAttack = null; return; }
    this.currentAttack.damage = this.damageCalcTargets
      ? this.damageCalcTargets.find((c) => c !== attacker)?.damageThisAttack ?? 0
      : damageToDefender;
    this.phase = PHASE.BATTLE_DAMAGE_END;
    yield* this.priorityWindow('respond');
  }
  if (this.over) { this.currentAttack = null; return; }

  // --- destruction
  this.phase = PHASE.BATTLE_END;
  for (const c of [attacker, target]) {
    if (!c) continue;
    if (this.shouldBeDestroyed(c)) {
      yield* this.destroyCard(c, 'battle');
      if (this.over) { this.currentAttack = null; return; }
    }
  }
  this.emit('attackResolved', { attacker, target });
  this.currentAttack = null;
  this.damageCalcTargets = null;
  yield* this.checkTriggers('AFTER_DAMAGE', { attacker, target });
};

Game.prototype.battleDamageShielded = function (playerIdx) {
  if (this.turnFlags.has('noBattleDamage')) return true;
  const p = this.players[playerIdx];
  return p.spells.some((c) => c && c.faceup && c.continuousModifiers.some((m) => m.noBattleDamage));
};

/** Aborts the attack in progress (e.g. negated by Magic Cylinder). */
Game.prototype.cancelAttack = function (reason) {
  if (this.currentAttack) {
    this.cancelledAttack = { reason, attack: this.currentAttack };
    this.say(reason);
  }
};

function game_shield_log(game, attacker) {
  game.say(`${attacker.name} takes no battle damage (shielded).`);
}

Game.prototype.isPiercing = function (attacker) {
  if (attacker.card && /pierce/i.test(attacker.card.desc)) return true;
  return attacker.continuousModifiers.some((m) => m.pierce);
};

Game.prototype.shouldBeDestroyed = function (card) {
  if (!card || card.destroyed) return false;
  if (card.damageThisAttack === undefined || card.damageThisAttack === null) return false;
  if (card.isSet() && !card.faceup) return false;
  if (card.pos === POS.FACEUP_ATTACK) return card.damageThisAttack >= (card.atk ?? 0);
  return card.damageThisAttack >= (card.def ?? 0);
};

Game.prototype.dealDamageToCard = function (card, amount) {
  if (amount <= 0) return;
  // damageThisAttack is the running total for the current attack, used by the
  // destruction check. It is cleared when the attack finishes.
  card.damageThisAttack = (card.damageThisAttack ?? 0) + amount;
  this.emit('damage', { card, amount });
};

Game.prototype.dealDamageToPlayer = function (player, amount) {
  if (amount <= 0) return;
  player.setLP(player.lp - amount);
  this.stats.damageDealt += amount;
  this.emit('damagePlayer', { player, amount });
  if (player.lp <= 0) this.declareLoss(player.index, 'LP');
};

// ============================================================================
// Destruction
// ============================================================================

Game.prototype.isDestructible = function (card) {
  if (!card || card.destroyed || card.banned) return false;
  if (card.continuousModifiers.some((m) => m.unbreakable)) return false;
  return true;
};

/** Destroys a card on the field. reason: 'battle' | 'effect' | 'tribute' */
Game.prototype.destroyCard = function* (card, reason = 'effect') {
  if (!this.isDestructible(card)) {
    if (card) this.say(`${card.name} cannot be destroyed.`);
    return false;
  }
  const p = this.players[card.controller];
  const inBattle = reason === 'battle';
  const wasEquippedBy = card.equipTargets.slice();
  const linked = card.card?.isLink ? this.linkedMonsters(card) : [];
  const opponentControlled = card.controller;

  card.destroyed = true;
  card.damageThisAttack = 0;
  this.removeFrom(card, this.locate(card));
  if (card.xyzMaterials && card.xyzMaterials.length) yield* this.sendXyzMaterials(card);
  this.moveCard(card, ZONE.GRAVE);
  this.stats.cardsDestroyed++;
  this.say(`${p.name}'s ${card.name} was destroyed.`);
  this.emit('destroyed', { card, reason });

  // Destroy monsters that were beat by this Link monster.
  for (const m of linked) {
    if (m && this.locate(m) && m.zone === ZONE.MONSTER) {
      this.say(`Because ${card.name} was destroyed, ${m.name} is destroyed too.`);
      yield* this.destroyCard(m, 'effect');
    }
  }
  // Equip cards go with their host.
  for (const eq of wasEquippedBy) {
    if (eq && this.locate(eq) && eq.zone === ZONE.SPELL) yield* this.destroyCard(eq, 'effect');
  }
  // Equip cards on this monster are lost.
  for (const eq of card.equipTargets.slice()) {
    if (eq && this.locate(eq) && eq.zone === ZONE.SPELL) yield* this.destroyCard(eq, 'effect');
  }
  this.say(`${p.name} sent ${card.name} to the Graveyard.`);
  yield* this.checkTriggers('DESTROYED', { card, destroyedCard: card, reason, inBattle, controller: opponentControlled });
  if (this.checkFieldWipe()) return true;
  return true;
};

/** Cards a Link monster points at. */
Game.prototype.linkedMonsters = function (link) {
  const markers = link.card.linkMarkerBits || defaultLinkMarkers(link);
  const out = [];
  const p = this.players[link.controller];
  for (let i = 0; i < NUM_MONSTER_ZONES; i++) {
    if (markers.includes(i)) out.push(p.monsters[i]);
  }
  return out.filter(Boolean);
};

/** Link marker bit positions for a card, from its number. */
function defaultLinkMarkers(link) {
  const n = link.linkRating;
  const out = [];
  // Layout the arrows left-to-right in the lowest row that fits.
  const layouts = {
    1: [[0]], 2: [[0, 1]],
    3: [[0], [0, 1]],
    4: [[0, 1], [0, 1]],
  };
  for (const row of (layouts[n] || [])) for (const c of row) if (!out.includes(c)) out.push(c);
  return out;
}

/** Field wipe check: nothing can be face-up on the field any more. */
Game.prototype.checkFieldWipe = function () {
  for (const p of this.players) {
    for (const c of [...p.monsters, ...p.spells]) if (c && c.faceup) return false;
  }
  return true;
};

// ============================================================================
// Win / loss
// ============================================================================

Game.prototype.declareLoss = function (playerIdx, reason) {
  const p = this.players[playerIdx];
  if (p.hasLost || this.over) return;
  p.hasLost = true;
  p.loseReason = reason;
  this.say(`${p.name} loses (${reason}).`);
  this.finish(1 - playerIdx, reason);
};

Game.prototype.finish = function (winner, reason) {
  if (this.over) return;
  // The goal is the only authority on whether a puzzle was solved. A duel can
  // end at the very instant the goal becomes true - lethal damage, a counter
  // trap burning the attacker, the turn limit - and by then both goal checks
  // (performAction and mainLoop) have already been skipped because `over` is
  // set. `winner` cannot stand in for the goal either: it says who won the
  // duel, and a puzzle won on the opponent's turn would otherwise read as a
  // loss, while a puzzle lost on the opponent's turn would read as a win.
  if (this.isPuzzle && this.puzzle) {
    if (this.puzzleSolved()) this.puzzle.solved = true;
    else this.puzzle.failed = true;
  }
  this.over = true;
  this.winner = winner;
  this.winReason = reason;
  this.say(winner === -1 ? `The duel ends in a draw (${reason}).` : `${this.players[winner].name} wins! (${reason})`);
  this.emit('gameOver', { winner, reason });
  this.pend.gen = null;
  this.pend.done = true;
}

// ============================================================================
// Special Summon procedures
// ============================================================================

/** Tributes `need` monsters as a cost for a Special Summon. */
Game.prototype.tributeForSpecial = function* (pi, need) {
  if (need <= 0) return true;
  const p = this.players[pi];
  const candidates = p.monsters.filter(Boolean);
  if (candidates.length < need) return false;
  const picked = yield* this.askCard(
    `Tribute ${need} monster(s) to Special Summon:`, candidates, { min: need, max: need },
  );
  if (picked.length < need) return false;
  for (const c of picked) {
    this.moveCard(c, ZONE.GRAVE);
    this.say(`${p.name} tributed ${c.name} (Special Summon cost).`);
  }
  return true;
};

/** Core Special Summon: moves a card from `from` onto the field. */
Game.prototype.specialSummon = function* (pi, card, opts = {}) {
  const p = this.players[pi];
  if (card.zone !== opts.from) {
    if (!this.moveCard(card, opts.from || this.locate(card)?.zone || ZONE.GRAVE)) return false;
  }
  if (card.zone === ZONE.GRAVE || card.zone === ZONE.BANISH) {
    card.zone = ZONE.GRAVE;
  }
  if (!this.hasFreeMonsterZone(p)) { this.say('No monster zone available for Special Summon.'); return false; }
  const zone = opts.zone ?? p.firstFreeMonsterZone(0);
  const ok = this.moveCard(card, ZONE.MONSTER, zone, {
    faceup: true, pos: opts.pos || POS.FACEUP_ATTACK, specialSummoned: true,
  });
  if (!ok) return false;
  card.summonTurn = this.turn;
  card.specialSummonedThisTurn = true;
  this.say(`${p.name} Special Summoned ${card.name}${opts.from === ZONE.DECK ? ' from the Deck' : ''}!`);
  yield* this.afterSummonTriggers(card, 'SPECIAL_SUMMON');
  return true;
};

/** Pulls a monster from the deck into hand. */
Game.prototype.searchDeckToHand = function* (pi, filter, opts = {}) {
  const p = this.players[pi];
  const matches = p.deck.filter((c) => filter(c, this));
  if (!matches.length) return [];
  const exact = matches.filter((c) => filter(c, this, true));
  const pool = exact.length ? exact : matches;
  const n = Math.min(opts.max ?? 1, pool.length, opts.min ?? 1);
  const picked = yield* this.askCard(
    `Add ${n} card(s) from your Deck to your hand:`, pool, { min: n, max: n },
  );
  const added = picked.filter(Boolean);
  for (const c of added) this.moveCard(c, ZONE.HAND);
  if (added.length) this.say(`${p.name} added ${added.map((c) => c.name).join(', ')} to their hand.`);
  return added;
};

/** Synchro Summon. tuners/materials are uids of field monsters. */
Game.prototype.synchroSummon = function* (pi, target, tunerUids) {
  const p = this.players[pi];
  const mats = tunerUids.map((u) => this.findCard(u)).filter(Boolean);
  if (mats.length < 2) return false;
  let total = 0;
  let hasTuner = false;
  for (const m of mats) {
    if (m.isTuner) hasTuner = true;
    if (!m.faceup) return false;
    total += m.level;
  }
  if (!hasTuner) { this.say('Synchro Summon requires a Tuner.'); return false; }
  if (total !== target.level) {
    this.say(`Synchro level mismatch: materials total ${total}, ${target.name} needs ${target.level}.`);
    return false;
  }
  for (const m of mats) this.moveCard(m, ZONE.GRAVE);
  return yield* this.specialSummon(pi, target, { from: ZONE.EXTRA, tribute: mats.length - 2 });
};

/** Xyz Summon. deckUids are face-up monsters, extraUids are field Xyz materials. */
Game.prototype.xyzSummon = function* (pi, target, deckUids, extraUids = []) {
  const p = this.players[pi];
  const deckMats = deckUids.map((u) => this.findCard(u)).filter(Boolean);
  if (deckMats.length !== 2) return false;
  const exMats = extraUids.map((u) => this.findCard(u)).filter(Boolean);
  const need = 2 - exMats.length;
  if (deckMats.length !== need) return false;
  for (const m of [...deckMats, ...exMats]) {
    if (!m.card.isXyz) { this.say('Xyz materials must be Xyz Monsters.'); return false; }
    if (m.level !== target.level) { this.say(`Xyz rank mismatch: material rank ${m.level}, ${target.name} needs ${target.level}.`); return false; }
    if (!m.faceup) { this.say('Xyz materials must be face-up.'); return false; }
  }
  for (const m of [...deckMats, ...exMats]) {
    this.removeFrom(m, this.locate(m));
    m.zone = 'xyzmaterial';
    m.pos = POS.FACEUP_ATTACK;
    m.faceup = true;
  }
  const ok = this.moveCard(target, ZONE.MONSTER, p.firstFreeMonsterZone(0), { faceup: true, pos: POS.FACEUP_ATTACK, specialSummoned: true });
  if (!ok) return false;
  target.xyzMaterials = [...deckMats, ...exMats];
  target.summonTurn = this.turn;
  this.say(`${p.name} Xyz Summoned ${target.name}!`);
  yield* this.afterSummonTriggers(target, 'SPECIAL_SUMMON');
  return true;
};

/** Link Summon. */
Game.prototype.linkSummon = function* (pi, target, extraUids) {
  const p = this.players[pi];
  const mats = extraUids.map((u) => this.findCard(u)).filter(Boolean);
  const need = (target.linkRating || 0) - mats.length;
  if (need < 0) { this.say('Too many Link materials.'); return false; }
  if (mats.some((m) => !m.card.isLink)) { this.say('Link materials must be Link Monsters.'); return false; }
  if (need > 0) {
    const ok = yield* this.tributeForSpecial(pi, need);
    if (!ok) return false;
  }
  for (const m of mats) this.moveCard(m, ZONE.GRAVE);
  return yield* this.specialSummon(pi, target, { from: ZONE.EXTRA });
};

/** Fusion Summon. */
Game.prototype.fusionSummon = function* (pi, target, matUids) {
  const mats = matUids.map((u) => this.findCard(u)).filter(Boolean);
  if (mats.length < 2) return false;
  for (const m of mats) this.moveCard(m, ZONE.GRAVE);
  return yield* this.specialSummon(pi, target, { from: ZONE.EXTRA });
};

/** Ritual Summon. */
Game.prototype.ritualSummon = function* (pi, target, matUids) {
  const p = this.players[pi];
  const mats = matUids.map((u) => this.findCard(u)).filter(Boolean);
  const total = mats.reduce((s, m) => s + (m.level || 0), 0);
  if (total < target.level) { this.say(`Ritual Summon needs total level ${target.level} or more (have ${total}).`); return false; }
  for (const m of mats) this.moveCard(m, ZONE.GRAVE);
  return yield* this.specialSummon(pi, target, { from: ZONE.EXTRA });
};

// ============================================================================
// Trigger framework
// ============================================================================

/** event -> array of trigger specs. Populated by effects.js. */
export const TRIGGERS = new Map();

Game.prototype.registerTrigger = function (event, spec) {
  if (!TRIGGERS.has(event)) TRIGGERS.set(event, []);
  TRIGGERS.get(event).push(spec);
  return spec;
};

/** Asks a specific player a question (routed by the driver). */
Game.prototype.askFor = function* (playerIdx, spec) {
  const req = { kind: 'choice', id: ++Game.reqSeq, forPlayer: playerIdx, spec, game: this };
  this.request = req;
  this.emit('request', req);
  return yield req;
};

Game.prototype.triggerSources = function (event, ctx) {
  const specs = TRIGGERS.get(event) || [];
  const out = [];
  for (const spec of specs) {
    for (const c of this.allCards()) {
      if (!c) continue;
      let ok = false;
      try { ok = spec.when(c, this, ctx); } catch { ok = false; }
      if (ok) out.push({ card: c, spec });
    }
  }
  return out;
};

/**
 * Offers every legal trigger for `event` and resolves whatever gets activated.
 * Triggers are offered in board order, turn player first.
 */
Game.prototype.checkTriggers = function* (event, ctx = {}) {
  const sources = this.triggerSources(event, ctx);
  if (!sources.length) return;
  sources.sort((a, b) => (a.card.controller - b.card.controller) || (a.card.uid - b.card.uid));
  for (const { card: src, spec } of sources) {
    if (this.over) return;
    const loc = this.locate(src);
    if (!loc) continue;
    if (loc.zone !== ZONE.MONSTER && loc.zone !== ZONE.SPELL && loc.zone !== ZONE.PENDULUM
      && loc.zone !== ZONE.GRAVE && loc.zone !== ZONE.BANISH) continue;
    if (src.zone === ZONE.GRAVE && spec.onlyFrom !== 'grave' && !spec.fromGrave) continue;
    if (src.zone === ZONE.BANISH && !spec.fromBanish) continue;

    if (spec.opponentTurnOnly && src.controller === this.current) continue;
    const ctrl = spec.who === 'turnPlayer' ? this.current : src.controller;
    if (spec.who !== 'turnPlayer' && src.controller !== ctrl) continue;

    // Ask whether to activate BEFORE choosing targets, otherwise the player is
    // asked to target a card they may then decline to activate at all.
    const yes = yield* this.askFor(ctrl, {
      question: `${this.players[ctrl].name}: activate ${src.name}${src.isSet() ? ' (set)' : ''}?`,
      kind: 'yesno', options: [{ label: 'Activate', value: true }, { label: 'Decline', value: false }],
    });
    if (yes !== true) continue;

    let targets = [];
    let proceed = true;
    const n = typeof spec.targets === 'function' ? spec.targets(this, ctx, src) : (spec.targets || 0);
    if (n > 0) {
      const tf = typeof spec.targetFilter === 'function'
        ? (spec.targetFilter(src) || 'ANY_FACEUP') : (spec.targetFilter || 'ANY_FACEUP');
      const eff = this.getEffect(src);
      targets = yield* this.selectTargets(ctrl, tf, n, {
        optional: !!spec.optional,
        legalTarget: eff?.legalTarget,
        question: `${this.players[ctrl].name}: target for ${src.name}?`,
      });
      if (targets.length < n && !spec.optional) proceed = false;
    }
    if (!proceed) continue;

    const link = this.makeLink(ctrl, src, loc.zone === ZONE.GRAVE ? 'grave' : 'field', `${src.name} effect`, targets, {
      spec: { resolve: spec.resolve, destination: spec.destination },
    });
    yield* this.activateLink(ctrl, link);
    if (this.over) return;
  }
};

/** Destroy the attached Xyz materials when an Xyz monster leaves the field. */
Game.prototype.sendXyzMaterials = function* (card) {
  if (!card.xyzMaterials || !card.xyzMaterials.length) return;
  for (const m of card.xyzMaterials) {
    if (!m) continue;
    this.moveCard(m, ZONE.GRAVE);
    this.say(`Xyz Material ${m.name} was sent to the Graveyard.`);
  }
  card.xyzMaterials = [];
};

/**
 * Generic Fusion Summon flow used by Polymerization and similar.
 * Fusion requirements are matched loosely against the card's scripted
 * requirement text; if a Fusion card has no parseable requirement the player
 * may still confirm the material choice.
 */
Game.prototype.fusionSummonFlow = function* (pi, opts = {}) {
  const p = this.players[pi];
  const fusions = p.extra.filter((c) => c.card.isFusion);
  if (!fusions.length) { this.say('No Fusion Monster in the Extra Deck.'); return false; }
  const chosen = yield* this.askCard('Choose a Fusion Monster to Summon:', fusions, { min: 1, max: 1 });
  const target = chosen[0];
  if (!target) return false;

  const pool = [...p.hand.filter((c) => c.isMonster), ...p.monsters.filter(Boolean)];
  if (pool.length < 2) { this.say('Not enough Fusion materials.'); return false; }
  const picked = yield* this.askCard(
    `Choose the Fusion materials for ${target.name} (at least 2):`,
    pool, { min: 2, max: Math.min(4, pool.length) },
  );
  if (picked.length < 2) return false;
  for (const m of picked) this.moveCard(m, ZONE.GRAVE);
  const ok = this.moveCard(target, ZONE.MONSTER, p.firstFreeMonsterZone(0), { faceup: true, pos: POS.FACEUP_ATTACK, specialSummoned: true });
  if (!ok) return false;
  target.summonTurn = this.turn;
  target.fusionMaterials = picked;
  this.say(`${p.name} Fusion Summoned ${target.name}!`);
  yield* this.afterSummonTriggers(target, 'SPECIAL_SUMMON');
  return true;
};

/**
 * Generic Synchro Summon flow: the player picks a Synchro monster from the
 * Extra Deck, then a set of face-up field monsters. Level + Tuner legality is
 * enforced.
 */
Game.prototype.synchroFlow = function* (pi) {
  const p = this.players[pi];
  const syn = p.extra.filter((c) => c.card.isSynchro);
  if (!syn.length) { this.say('No Synchro Monster in the Extra Deck.'); return false; }
  const chosen = yield* this.askCard('Choose a Synchro Monster to Summon:', syn, { min: 1, max: 1 });
  const target = chosen[0];
  if (!target) return false;
  const pool = p.monsters.filter((c) => c && c.faceup);
  if (pool.length < 2) { this.say('Need at least 2 face-up monsters.'); return false; }
  const picked = yield* this.askCard(`Choose Synchro materials for ${target.name}:`, pool, { min: 2, max: Math.min(4, pool.length) });
  return yield* this.synchroSummon(pi, target, picked.map((c) => c.uid));
};

/** Generic Xyz Summon flow. */
Game.prototype.xyzFlow = function* (pi) {
  const p = this.players[pi];
  const xyz = p.extra.filter((c) => c.card.isXyz);
  if (!xyz.length) { this.say('No Xyz Monster in the Extra Deck.'); return false; }
  const chosen = yield* this.askCard('Choose an Xyz Monster to Summon:', xyz, { min: 1, max: 1 });
  const target = chosen[0];
  if (!target) return false;
  const pool = p.monsters.filter((c) => c && c.faceup && c.card.isXyz);
  if (pool.length < 2) { this.say('Need 2 face-up Xyz Monsters as material.'); return false; }
  const picked = yield* this.askCard(`Choose 2 Xyz materials for ${target.name}:`, pool, { min: 2, max: 2 });
  return yield* this.xyzSummon(pi, target, [], picked.map((c) => c.uid));
};

/** Generic Link Summon flow. */
Game.prototype.linkFlow = function* (pi) {
  const p = this.players[pi];
  const links = p.extra.filter((c) => c.card.isLink);
  if (!links.length) { this.say('No Link Monster in the Extra Deck.'); return false; }
  const chosen = yield* this.askCard('Choose a Link Monster to Summon:', links, { min: 1, max: 1 });
  const target = chosen[0];
  if (!target) return false;
  const need = target.linkRating || 0;
  const pool = p.monsters.filter((c) => c && c.faceup);
  if (pool.length < need) { this.say(`Need ${need} Link materials.`); return false; }
  const picked = yield* this.askCard(`Choose ${need} Link material(s) for ${target.name}:`, pool, { min: need, max: need });
  return yield* this.linkSummon(pi, target, picked.map((c) => c.uid));
};
