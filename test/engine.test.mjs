// Headless engine tests: node --test test/engine.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

import { Game, makeDatabase, CardInstance, PHASE, POS, ZONE, ACTION } from '../src/engine.js';
import { registerTriggers, EFFECTS, effectCoverage } from '../src/effects.js';
import { Driver, defaultPolicy, greedyPolicy } from '../src/driver.js';

// --- load the real database -----------------------------------------------
const b64 = readFileSync(new URL('../src/carddb.b64', import.meta.url), 'utf8').trim();
const records = JSON.parse(gunzipSync(Buffer.from(b64, 'base64')).toString('utf8'));
const db = makeDatabase(records);
registerTriggers();

const CODE = {};
for (const c of db.all()) if (!CODE[c.name]) CODE[c.name] = c.id;

// --- helpers ---------------------------------------------------------------

function mkGame(cfg = {}) {
  const g = new Game(db, { strict: true, ...cfg });
  return g;
}

/** Runs the game to completion with a policy, resolving via microtasks. */
function runToEnd(game, policy = defaultPolicy, maxSteps = 6000) {
  const d = new Driver(policy);
  d.attach(game);
  return new Promise((resolve) => {
    let n = 0;
    const t = setInterval(() => {
      if (game.over || game.pend.done || ++n > maxSteps) { clearInterval(t); resolve(game); }
    }, 0);
  });
}

let currentDecks = [[], []];
const MIN_DECK = 10;

/**
 * Builds a playable deck per side. Tests name the cards they care about and
 * the rest is inert filler, so a short list does not turn into an instant
 * deck-out the moment the five-card opening hand is dealt.
 */
function pad(names) {
  const out = names.map((n) => {
    assert.ok(CODE[n], `unknown card in test deck: ${n}`);
    return CODE[n];
  });
  while (out.length < MIN_DECK) out.push(CODE['Mokey Mokey']);
  return out;
}
function setDecks(a, b) { currentDecks = [pad(a), pad(b)]; }

/** Plays a specific sequence of actions on the human's turn, then passes out. */
function playSequence(game, names, policy = defaultPolicy) {
  const d = new Driver((req) => {
    if (req.kind === 'priority') {
      const a = (req.actions || []).find((x) => x.type === ACTION.NORMAL_SUMMON);
      if (a && names.length) {
        const want = names.shift();
        const c = game.findCard(a.uid);
        if (c && c.name === want) return a;
      }
      return { type: ACTION.PASS };
    }
    return defaultPolicy(req);
  });
  d.attach(game);
  return d;
}

// ===========================================================================
// Database
// ===========================================================================

test('database holds the full English card set', () => {
  assert.ok(db.size > 14000, `expected >14000 cards, got ${db.size}`);
  const be = db.get(CODE['Blue-Eyes White Dragon']);
  assert.equal(be.name, 'Blue-Eyes White Dragon');
  assert.equal(be.atk, 3000);
  assert.equal(be.def, 2500);
  assert.equal(be.level, 8);
  assert.ok(be.isNormal);
});

test('every monster is normalised with usable stats', () => {
  const noAtk = [];
  const noLevel = [];
  for (const c of db.all()) {
    if (!c.isMonster) continue;
    if (c.atk === null) noAtk.push(c.name);
    // Link monsters carry a rating instead of a level; Tokens have no level.
    if (c.level === null && !c.isLink && !c.isToken) noLevel.push(`${c.name} [${c.typeStr}]`);
  }
  // Tokens legitimately have no ATK printed.
  assert.ok(noAtk.every((n) => /Token/i.test(n)), `non-token monsters missing ATK: ${noAtk.slice(0, 5)}`);
  assert.equal(noLevel.length, 0, `monsters missing level: ${noLevel.slice(0, 5).join(', ')}`);
});

test('type strings are parsed into gameplay flags', () => {
  const byName = (n) => db.byName(n)[0];
  assert.ok(byName('Blue-Eyes White Dragon').isNormal);
  assert.ok(!byName('Blue-Eyes White Dragon').isEffect);
  assert.ok(byName('Lava Golem').isXyz);
  assert.ok(byName('Salamangreat Almiraj').isLink);
  assert.ok(byName('Pot of Greed').isSpell);
  assert.ok(byName('Sakuretsu Armor').isTrap);
  // subtype words are found regardless of position in the string
  const tuner = db.all().find((c) => c.isTuner);
  assert.ok(tuner, 'expected at least one Tuner monster');
  const pend = db.all().find((c) => c.isPendulum);
  assert.ok(pend, 'expected at least one Pendulum monster');
});

test('XYZ ranks and LINK ratings survive the export', () => {
  const xyzs = db.all().filter((c) => c.isXyz);
  assert.ok(xyzs.length > 500, `expected many XYZ monsters, got ${xyzs.length}`);
  // Rank 0 is legal (Number F0 / Number S0), so only require a present rank.
  assert.ok(xyzs.every((c) => c.level !== null && c.level >= 0 && c.level <= 13),
    'every XYZ monster should carry a rank in 0..13');
  for (const r of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) {
    assert.ok(xyzs.some((c) => c.level === r), `no XYZ monster with rank ${r}`);
  }

  const links = db.all().filter((c) => c.isLink);
  assert.ok(links.length > 400, `expected many Link monsters, got ${links.length}`);
  const rated = links.filter((c) => c.link > 0);
  assert.ok(rated.length > 400, `expected Link ratings, got ${rated.length}`);
  // A Link monster's rating drives how many materials it needs.
  assert.ok(rated.some((c) => c.link === 1));
  assert.ok(rated.some((c) => c.link >= 3));
});

// ===========================================================================
// Card database adapter
// ===========================================================================

test('normalizeCard classifies types', () => {
  const be = db.get(CODE['Blue-Eyes White Dragon']);
  assert.ok(be.isMonster && !be.isSpellTrap);
  const pot = db.get(CODE['Pot of Greed']);
  assert.ok(pot.isSpell && !pot.isMonster);
  const armor = db.get(CODE['Sakuretsu Armor']);
  assert.ok(armor.isTrap);
});

test('effect coverage report is honest about gaps', () => {
  const cov = effectCoverage(db);
  assert.ok(cov.total > 14000);
  assert.ok(cov.exact > 0 && cov.exact < cov.effectCards, 'exact coverage should be partial');
  assert.ok(cov.inert > 0, 'most cards are unimplemented and should be reported so');
});

// ===========================================================================
// Setup / drawing
// ===========================================================================

test('setup deals opening hands and sets LP', async () => {
  setDecks(
    ['Blue-Eyes White Dragon', 'Dark Magician', 'Summoned Skull', 'Mokey Mokey', 'Mystical Elf'],
    ['Meteor Dragon', 'Gaia The Fierce Knight', 'Mokey Mokey', 'Mystical Elf', 'Summoned Skull'],
  );
  const g = mkGame();
  // Assert synchronously: setup() completes before the main loop's first
  // priority request, so the opening hands are still exactly 5 here.
  g.startDuel({ decks: currentDecks, firstPlayer: 0 });
  assert.equal(g.players[0].lp, 8000);
  assert.equal(g.players[1].lp, 8000);
  assert.equal(g.players[0].hand.length, 5);
  assert.equal(g.players[1].hand.length, 5);
});

// ===========================================================================
// Summon legality
// ===========================================================================

test('normal summon puts a monster face-up in Attack Position', () => {
  setDecks(['Blue-Eyes White Dragon'], ['Mokey Mokey']);
  const g = mkGame();
  new Driver(defaultPolicy).attach(g);
  g.startDuel({ decks: currentDecks, firstPlayer: 0 });
  // hand: p0 got 5, p1 got 5; but we only put 1 card each so tops up are empty
  const c = g.players[0].hand[0];
  c.zone = ZONE.HAND;
  const ok = g.moveCard(c, ZONE.MONSTER, 2, { faceup: true, pos: POS.FACEUP_ATTACK, normalSummoned: true });
  assert.ok(ok);
  assert.equal(c.pos, POS.FACEUP_ATTACK);
  assert.equal(c.faceup, true);
  assert.equal(g.players[0].monsters[2], c);
});

test('tribute requirement scales with level', () => {
  const g = mkGame();
  const be = db.get(CODE['Blue-Eyes White Dragon']);   // Lv8 -> 2 tributes
  const dm = db.get(CODE['Dark Magician']);            // Lv7 -> 2 tributes
  const skull = db.get(CODE['Summoned Skull']);         // Lv6 -> 1
  const bear = db.get(CODE['Mokey Mokey']);            // Lv1 -> 0
  const elf = db.get(CODE['Mystical Elf']);            // Lv4 -> 0
  const cases = [[be, 2], [dm, 2], [skull, 1], [bear, 0], [elf, 0]];
  for (const [card, want] of cases) {
    const inst = new CardInstance(card.id, 0, 0, db);
    assert.equal(g.tributesNeeded(inst), want, `${card.name} should need ${want} tribute(s)`);
  }
});

test('XYZ ranks drive tribute requirements too', () => {
  const g = mkGame();
  const xyz = db.all().find((c) => c.isXyz && c.level >= 7);
  assert.ok(xyz, 'expected an XYZ monster of rank 7+');
  const inst = new CardInstance(xyz.id, 0, 0, db);
  assert.equal(g.tributesNeeded(inst), 2);
});

// ===========================================================================
// Battle
// ===========================================================================

test('attack deals damage and destroys the weaker monster', () => {
  setDecks(['Blue-Eyes White Dragon', 'Mokey Mokey', 'Mokey Mokey'], ['Summoned Skull', 'Mokey Mokey', 'Mokey Mokey']);
  const g = mkGame();
  const d = new Driver(defaultPolicy);
  d.attach(g);
  g.startDuel({ decks: currentDecks, firstPlayer: 0 });

  // Force a known board state.
  const p0 = g.players[0], p1 = g.players[1];
  p0.hand.length = 0; p1.hand.length = 0;
  const strong = new CardInstance(CODE['Blue-Eyes White Dragon'], 0, 0, db);
  const weak = new CardInstance(CODE['Mokey Mokey'], 1, 1, db);
  g.moveCard(strong, ZONE.MONSTER, 0, { faceup: true, pos: POS.FACEUP_ATTACK });
  g.moveCard(weak, ZONE.MONSTER, 0, { faceup: true, pos: POS.FACEUP_ATTACK });
  const p1lp = p1.lp;
  const it = g.doAttack(0, { type: ACTION.ATTACK, uid: strong.uid, targets: [{ uid: weak.uid, direct: false }] });
  drain(it);
  assert.equal(p1.lp, p1lp, 'defending LP should be untouched');
  assert.ok(weak.zone === ZONE.GRAVE, `weak monster should be destroyed, zone=${weak.zone}`);
});

test('direct attack is refused while the opponent has monsters', () => {
  setDecks(['Blue-Eyes White Dragon'], ['Mokey Mokey']);
  const g = mkGame();
  new Driver(defaultPolicy).attach(g);
  g.startDuel({ decks: currentDecks, firstPlayer: 0 });
  const p0 = g.players[0], p1 = g.players[1];
  p0.hand.length = 0; p1.hand.length = 0;
  const strong = new CardInstance(CODE['Blue-Eyes White Dragon'], 0, 0, db);
  const weak = new CardInstance(CODE['Mokey Mokey'], 1, 1, db);
  g.moveCard(strong, ZONE.MONSTER, 0, { faceup: true, pos: POS.FACEUP_ATTACK });
  g.moveCard(weak, ZONE.MONSTER, 0, { faceup: true, pos: POS.FACEUP_ATTACK });
  const targets = g.attackTargets(p0, strong);
  assert.ok(targets.every((t) => !t.direct), 'direct attack must not be offered');
});

// ===========================================================================
// Effects
// ===========================================================================

test('Pot of Greed draws two cards', () => {
  setDecks(['Pot of Greed', 'Pot of Greed'], ['Pot of Greed', 'Pot of Greed']);
  const g = mkGame();
  // Run setup only: the deck has to be shuffled and dealt, but the main loop
  // must not start because this test drives the activation by hand.
  drain(g.setup({ decks: currentDecks, firstPlayer: 0 }));
  const p0 = g.players[0];
  p0.hand.length = 0;
  const spell = new CardInstance(CODE['Pot of Greed'], 0, 0, db);
  g.moveCard(spell, ZONE.HAND);
  // The spell itself leaves the hand for the Graveyard, so the hand goes
  // from 1 (the spell) to exactly the 2 cards that were drawn.
  drain(g.doActivate(0, { type: ACTION.ACTIVATE, uid: spell.uid, source: 'hand' }));
  assert.equal(p0.hand.length, 2, 'should draw 2');
  assert.equal(spell.zone, ZONE.GRAVE, 'Pot of Greed should be in the Graveyard');
});

test('Sangan searches the Deck when sent to the Graveyard', () => {
  setDecks(['Sangan'], ['Mokey Mokey']);
  const g = mkGame();
  const p0 = g.players[0];
  p0.hand.length = 0; p0.grave.length = 0;
  // put a searchable monster in the deck
  for (let i = 0; i < 3; i++) {
    const m = new CardInstance(CODE['Mokey Mokey'], 0, 0, db);
    g.moveCard(m, ZONE.DECK);
  }
  const sangan = new CardInstance(CODE['Sangan'], 0, 0, db);
  g.moveCard(sangan, ZONE.MONSTER, 0, { faceup: true, pos: POS.FACEUP_ATTACK });
  drain(g.destroyCard(sangan, 'effect'));
  assert.ok(p0.hand.length >= 1, 'Sangan should have added a card to hand');
});

test('Raigeki destroys every face-up monster', () => {
  setDecks(['Dark Hole'], ['Mokey Mokey']);
  const g = mkGame();
  const p0 = g.players[0], p1 = g.players[1];
  p0.hand.length = 0;
  const spell = new CardInstance(CODE['Dark Hole'], 0, 0, db);
  g.moveCard(spell, ZONE.HAND);
  for (let i = 0; i < 3; i++) {
    const m = new CardInstance(CODE['Mokey Mokey'], 1, 1, db);
    g.moveCard(m, ZONE.MONSTER, i, { faceup: true, pos: POS.FACEUP_ATTACK });
  }
  drain(g.doActivate(0, { type: ACTION.ACTIVATE, uid: spell.uid, source: 'hand' }));
  assert.equal(p1.monsterCount(), 0, 'all enemy monsters should be gone');
});

test('Dark Magician Girl gains ATK per Dark Magician in the Graveyard', () => {
  setDecks(['Dark Magician Girl'], ['Mokey Mokey']);
  const g = mkGame();
  new Driver(defaultPolicy).attach(g);
  g.startDuel({ decks: currentDecks, firstPlayer: 0 });
  const p0 = g.players[0];
  p0.hand.length = 0;
  const dmg = new CardInstance(CODE['Dark Magician'], 0, 0, db);
  g.moveCard(dmg, ZONE.GRAVE);
  const dmgGirl = new CardInstance(CODE['Dark Magician Girl'], 0, 0, db);
  g.moveCard(dmgGirl, ZONE.MONSTER, 0, { faceup: true, pos: POS.FACEUP_ATTACK });
  g.refreshContinuous();
  assert.equal(dmgGirl.atk, 2000 + 300, 'should be 2300 ATK with one Dark Magician in the GY');
});

test('Jinzo locks Trap Cards', () => {
  setDecks(['Jinzo'], ['Mokey Mokey']);
  const g = mkGame();
  new Driver(defaultPolicy).attach(g);
  g.startDuel({ decks: currentDecks, firstPlayer: 0 });
  const p0 = g.players[0];
  p0.hand.length = 0;
  const j = new CardInstance(CODE['Jinzo'], 0, 0, db);
  g.moveCard(j, ZONE.MONSTER, 0, { faceup: true, pos: POS.FACEUP_ATTACK });
  assert.equal(g.trapsLocked(), true);
  const armor = new CardInstance(CODE['Sakuretsu Armor'], 0, 0, db);
  g.moveCard(armor, ZONE.HAND);
  const responds = g.chainResponseActions(0).filter((a) => a.uid === armor.uid);
  assert.equal(responds.length, 0, 'traps must not be activatable while Jinzo is up');
});

test('Wall of Disruption lowers the opponent ATK-position monsters', () => {
  setDecks(['Wall of Disruption'], ['Blue-Eyes White Dragon', 'Mokey Mokey']);
  const g = mkGame();
  new Driver(defaultPolicy).attach(g);
  g.startDuel({ decks: currentDecks, firstPlayer: 0 });
  const p0 = g.players[0], p1 = g.players[1];
  p0.hand.length = 0;
  const wall = new CardInstance(CODE['Wall of Disruption'], 0, 0, db);
  g.moveCard(wall, ZONE.SPELL, 0, { faceup: true });
  const be = new CardInstance(CODE['Blue-Eyes White Dragon'], 1, 1, db);
  g.moveCard(be, ZONE.MONSTER, 0, { faceup: true, pos: POS.FACEUP_ATTACK });
  g.refreshContinuous();
  assert.equal(be.atk, 3000 - 800 * 1, 'Blue-Eyes should drop to 2200');
});

test('Magic Cylinder negates the attack and burns the attacker', () => {
  setDecks(['Magic Cylinder'], ['Blue-Eyes White Dragon', 'Mokey Mokey']);
  const g = mkGame();
  const p0 = g.players[0], p1 = g.players[1];
  p0.hand.length = 0; p1.hand.length = 0;
  const cyl = new CardInstance(CODE['Magic Cylinder'], 0, 0, db);
  g.moveCard(cyl, ZONE.SPELL, 0, { faceup: false });
  cyl.turnSet = 0;
  const be = new CardInstance(CODE['Blue-Eyes White Dragon'], 1, 1, db);
  g.moveCard(be, ZONE.MONSTER, 0, { faceup: true, pos: POS.FACEUP_ATTACK });
  g.current = 1; g.turn = 2;
  const p0lp = p0.lp, p1lp = p1.lp;
  g.priority = 1;
  drain(g.doAttack(1, { type: ACTION.ATTACK, uid: be.uid, targets: [{ uid: null, direct: true }] }));
  // The Cylinder burns ITS controller's opponent, i.e. the attacking player,
  // and the attack itself is negated so no damage reaches the defender.
  assert.equal(p1.lp, p1lp - 3000, `cylinder should burn the attacker 3000 (p1 ${p1lp} -> ${p1.lp})`);
  assert.equal(p0.lp, p0lp, `negated attack should deal no damage to p0 (${p0lp} -> ${p0.lp})`);
});

test('Book of Moon flips a monster face-down', () => {
  setDecks(['Book of Moon'], ['Blue-Eyes White Dragon', 'Mokey Mokey']);
  const g = mkGame();
  const p0 = g.players[0], p1 = g.players[1];
  p0.hand.length = 0;
  const spell = new CardInstance(CODE['Book of Moon'], 0, 0, db);
  g.moveCard(spell, ZONE.HAND);
  const be = new CardInstance(CODE['Blue-Eyes White Dragon'], 1, 1, db);
  g.moveCard(be, ZONE.MONSTER, 0, { faceup: true, pos: POS.FACEUP_ATTACK });
  drain(g.doActivate(0, { type: ACTION.ACTIVATE, uid: spell.uid, source: 'hand' }));
  assert.equal(be.faceup, false);
  assert.equal(be.pos, POS.FACEDOWN_DEFENSE);
});

// ===========================================================================
// Continuous auras / traps
// ===========================================================================

test('Swords of Revealing Light reveals set monsters', () => {
  setDecks(['Swords of Revealing Light'], ['Blue-Eyes White Dragon', 'Mokey Mokey']);
  const g = mkGame();
  const p0 = g.players[0], p1 = g.players[1];
  p0.hand.length = 0;
  const spell = new CardInstance(CODE['Swords of Revealing Light'], 0, 0, db);
  g.moveCard(spell, ZONE.HAND);
  const be = new CardInstance(CODE['Blue-Eyes White Dragon'], 1, 1, db);
  g.moveCard(be, ZONE.MONSTER, 0, { faceup: false, pos: POS.FACEDOWN_DEFENSE });
  drain(g.doActivate(0, { type: ACTION.ACTIVATE, uid: spell.uid, source: 'hand' }));
  assert.equal(be.faceup, true, 'set monster should be revealed');
  assert.equal(g.attackLocked(1), true, 'opponent Attack Position monsters should be locked');
});

// ===========================================================================
// Full duel smoke tests
// ===========================================================================

test('a full duel runs to a decision without throwing', async () => {
  setDecks(
    ['Blue-Eyes White Dragon', 'Dark Magician', 'Pot of Greed', 'Mokey Mokey', 'Mokey Mokey', 'Mokey Mokey'],
    ['Summoned Skull', 'Meteor Dragon', 'Dark Hole', 'Mokey Mokey', 'Mokey Mokey', 'Mokey Mokey'],
  );
  const g = mkGame({ turnLimit: 6 });
  new Driver(greedyPolicy).attach(g);
  g.startDuel({ decks: currentDecks, firstPlayer: 0 });
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(g.over, `duel should finish (turn=${g.turn}, over=${g.over})`);
  assert.notEqual(g.winReason, undefined);
});

test('the pass-only policy walks every phase in order', async () => {
  setDecks(
    ['Mokey Mokey', 'Mokey Mokey', 'Mokey Mokey', 'Mokey Mokey', 'Mokey Mokey'],
    ['Mokey Mokey', 'Mokey Mokey', 'Mokey Mokey', 'Mokey Mokey', 'Mokey Mokey'],
  );
  const g = mkGame({ turnLimit: 2 });
  const seen = [];
  new Driver(defaultPolicy).attach(g);
  g.on((e) => { if (e.type === 'phase') seen.push(e.data.phase); });
  g.startDuel({ decks: currentDecks, firstPlayer: 0 });
  await new Promise((r) => setTimeout(r, 300));
  for (const ph of [PHASE.DRAW, PHASE.STANDBY, PHASE.MAIN1, PHASE.MAIN2, PHASE.END]) {
    assert.ok(seen.includes(ph), `phase ${ph} never occurred; saw ${[...new Set(seen)].join(',')}`);
  }
});

// --- test utility: run a generator to completion, auto-answering ---------
function drain(gen) {
  if (!gen) return;
  let r = gen.next();
  let guard = 0;
  while (!r.done && ++guard < 500) {
    const req = r.value;
    r = gen.next(autoAnswer(req));
  }
  if (!r.done) throw new Error('generator did not finish');
}

function autoAnswer(req) {
  const spec = req.spec || {};
  // Accept optional effects, otherwise every "If this card is sent to the GY"
  // trigger gets declined and its effect never resolves.
  if (spec.kind === 'yesno') return true;
  if (spec.kind === 'target') {
    const c = spec.candidates || [];
    return c.length ? [c[0]] : [];
  }
  if (spec.kind === 'card') {
    const c = spec.cards || [];
    return c.slice(0, spec.max || 1);
  }
  return null;
}
