// ============================================================================
// Card effects
// ----------------------------------------------------------------------------
// Every entry below was written against the real card text in the YGOPRO
// database (src/cards.cdb). The `cardText` field records the text the
// implementation is based on, so drift is visible if the source changes.
//
//   - `resolve`  : manual activation (ACTIVATE action) or a triggered effect
//   - `onSummon` : effect of Normal Summoning this monster
//   - `aura`     : continuous modifier recalculated after every board change
//   - `trigger`  : event + condition under which it offers to activate
// ============================================================================

import { Game, ZONE, POS } from './engine.js';

// --- helpers used by handlers ---------------------------------------------

export const H = {
  burn(game, target, amount, source) {
    if (amount <= 0) return;
    const p = game.players[target];
    p.setLP(p.lp - amount);
    game.stats.damageDealt += amount;
    game.say(`${p.name} takes ${amount} damage from ${source ? source.name : 'an effect'}. (LP ${p.lp})`);
    game.emit('damagePlayer', { player: p, amount, source });
    if (p.lp <= 0) game.declareLoss(target, 'LP');
  },

  heal(game, target, amount, source) {
    const p = game.players[target];
    p.gainLP(amount);
    game.say(`${p.name} gains ${amount} LP from ${source ? source.name : 'an effect'}. (LP ${p.lp})`);
  },

  *destroy(game, card, reason) {
    if (!card) return;
    if (!game.locate(card)) return;
    if (reason === 'battle' && game.turnFlags.has('noBattleDestroy')) {
      game.say(`${card.name} is not destroyed by battle this turn.`);
      return;
    }
    yield* game.destroyCard(card, reason || 'effect');
  },

  faceupMonstersOnField(game) {
    const out = [];
    for (const p of game.players) for (const c of p.monsters) if (c && c.faceup) out.push(c);
    return out;
  },

  banish(game, card) {
    if (!game.locate(card)) return;
    game.removeFrom(card, game.locate(card));
    if (card.xyzMaterials) for (const m of card.xyzMaterials) if (m) game.moveCard(m, ZONE.BANISH);
    game.moveCard(card, ZONE.BANISH);
    game.say(`${card.name} was banished.`);
  },

  /** Ask which player is hit by a burn effect. */
  *askPlayerTarget(game, link, amount) {
    const t = yield* game.ask({
      question: `${link.card.name}: inflict ${amount} damage to which player?`,
      kind: 'target',
      candidates: [
        { value: 1 - link.controller, label: `${game.players[1 - link.controller].name} (opponent)` },
        { value: link.controller, label: `${game.players[link.controller].name} (you)` },
      ],
      min: 1, max: 1,
    });
    const v = (Array.isArray(t) ? t[0] : t)?.value;
    return v === undefined ? null : v;
  },
};

// --- the effect table ------------------------------------------------------

export const EFFECTS = {

  // ================= NORMAL MONSTERS (battle only) =================
  // These have no effect; they are listed so the UI can label them correctly.

  // ================= EFFECT MONSTERS =================

  'Sangan': {
    cardText: 'If this card is sent from the field to the GY: Add 1 monster with 1500 or less ATK from your Deck to your hand.',
    fromGrave: true,
    resolve: function* (game, link) {
      const found = yield* game.searchDeckToHand(
        link.controller,
        (c) => c.isMonster && (c.atk ?? 9999) <= 1500,
        { min: 1, max: 1, question: 'Sangan: add 1 monster with 1500 or less ATK to your hand:' },
      );
      if (!found.length) game.say('Sangan: no matching monster in the Deck.');
    },
  },

  'Witch of the Black Forest': {
    cardText: 'If this card is sent from the field to the GY: Add 1 monster with 1500 or less DEF from your Deck to your hand.',
    fromGrave: true,
    resolve: function* (game, link) {
      const found = yield* game.searchDeckToHand(
        link.controller,
        (c) => c.isMonster && (c.def ?? 0) <= 1500,
        { min: 1, max: 1, question: 'Witch of the Black Forest: add 1 monster with 1500 or less DEF to your hand:' },
      );
      if (!found.length) game.say('Witch of the Black Forest: no matching monster in the Deck.');
    },
  },

  'Mystic Tomato': {
    cardText: 'When this card is destroyed by battle and sent to the GY: You can Special Summon 1 DARK monster with 1500 or less ATK from your Deck in Attack Position.',
    destroyedByBattle: true,
    resolve: function* (game, link) {
      const p = game.players[link.controller];
      const cands = p.deck.filter((c) => c.isMonster && c.attribute === 'DARK' && (c.atk ?? 9999) <= 1500);
      if (!cands.length) { game.say('Mystic Tomato: no legal target in the Deck.'); return; }
      const picked = yield* game.askCard('Mystic Tomato: Special Summon 1 DARK monster (1500 or less ATK):', cands, { min: 1, max: 1 });
      if (picked[0]) yield* game.specialSummon(link.controller, picked[0], { from: ZONE.DECK, pos: POS.FACEUP_ATTACK });
    },
  },

  'Lonefire Blossom': {
    cardText: 'Once per turn: You can Tribute 1 face-up Plant monster; Special Summon 1 Plant monster from your Deck.',
    resolve: function* (game, link) {
      const p = game.players[link.controller];
      const plants = p.monsters.filter((c) => c && c.faceup && c.race === 'PLANT');
      if (!plants.length) { game.say('Lonefire Blossom: you control no face-up Plant to Tribute.'); return; }
      const t = yield* game.askCard('Lonefire Blossom: Tribute 1 face-up Plant monster:', plants, { min: 1, max: 1 });
      if (!t[0]) return;
      game.moveCard(t[0], ZONE.GRAVE);
      game.say(`${p.name} tributed ${t[0].name}.`);
      const pool = p.deck.filter((c) => c.isMonster && c.race === 'PLANT');
      if (!pool.length) { game.say('Lonefire Blossom: no Plant in the Deck.'); return; }
      const pick = yield* game.askCard('Lonefire Blossom: Special Summon 1 Plant monster from your Deck:', pool, { min: 1, max: 1 });
      if (pick[0]) yield* game.specialSummon(link.controller, pick[0], { from: ZONE.DECK });
    },
  },

  'Dark Magician Girl': {
    cardText: 'Gains 300 ATK for every "Dark Magician" or "Magician of Black Chaos" in the GYs.',
    aura: function (game, card) {
      let n = 0;
      for (const p of game.players) {
        for (const c of p.grave) {
          if (c && (c.name === 'Dark Magician' || c.name === 'Magician of Black Chaos')) n++;
        }
      }
      return { atk: 300 * n };
    },
  },

  'Jinzo': {
    cardText: 'Trap Cards, and their effects on the field, cannot be activated. Negate all Trap effects on the field.',
    aura: function () { return {}; },
  },

  'Kuriboh': {
    cardText: 'During damage calculation, if your opponent\'s monster attacks (Quick Effect): You can discard this card; you take no battle damage from that battle.',
    timing: 'QUICK_DAMAGE',
    resolve: function* (game, link) {
      const c = link.card;
      if (c.zone === ZONE.HAND) game.moveCard(c, ZONE.GRAVE);
      game.say('Kuriboh: you take no battle damage from this battle.');
      game.turnFlags.add('noBattleDamageThisAttack');
    },
  },

  'Goyo Guardian': {
    cardText: 'When this card destroys an opponent\'s monster by battle and sent to the GY: You can Special Summon that monster to your field in Defense Position.',
    destroyedByBattle: true,
    resolve: function* (game, link) {
      const dctx = game.lastDestroyedByBattle;
      if (!dctx) { game.say('Goyo Guardian: no monster was destroyed by battle.'); return; }
      yield* game.specialSummon(link.controller, dctx.card, { from: ZONE.GRAVE, pos: POS.FACEUP_DEFENSE });
    },
  },

  // ================= SPELLS =================

  'Pot of Greed': {
    cardText: 'Draw 2 cards.',
    resolve: function* (game, link) { game.drawCards(link.controller, 2); },
  },

  'Graceful Charity': {
    cardText: 'Draw 3 cards, then discard 2 cards.',
    resolve: function* (game, link) {
      const p = game.players[link.controller];
      game.drawCards(link.controller, 3);
      const n = p.hand.length - 2;
      if (n <= 0) { game.say('Graceful Charity: hand already small enough.'); return; }
      const picked = yield* game.askCard(`${p.name} must discard ${n} card(s):`, p.hand, { min: n, max: n });
      for (const c of picked) { game.moveCard(c, ZONE.GRAVE); game.say(`${p.name} discarded ${c.name}.`); }
    },
  },

  'Mystical Space Typhoon': {
    cardText: 'Target 1 Spell/Trap on the field; destroy that target.',
    targets: 1,
    targetFilter: 'SPELL_ANY',
    resolve: function* (game, link) { for (const t of link.targets) yield* H.destroy(game, t, 'effect'); },
  },

  'Galaxy Storm': {
    cardText: 'Target 1 face-up Xyz Monster on the field that has no Xyz Material; destroy that target.',
    targets: 1,
    targetFilter: 'ANY_FACEUP',
    legalTarget: (game, c) => c.card.isXyz && c.faceup && (!c.xyzMaterials || !c.xyzMaterials.length),
    resolve: function* (game, link) { for (const t of link.targets) yield* H.destroy(game, t, 'effect'); },
  },

  'Dark Hole': {
    cardText: 'Destroy all monsters on the field.',
    resolve: function* (game) {
      const all = H.faceupMonstersOnField(game);
      for (const c of all) yield* H.destroy(game, c, 'effect');
    },
  },

  'Book of Moon': {
    cardText: 'Target 1 face-up monster on the field; change that target to face-down Defense Position.',
    targets: 1,
    targetFilter: 'ANY_FACEUP',
    resolve: function* (game, link) {
      for (const t of link.targets) {
        t.pos = POS.FACEDOWN_DEFENSE;
        t.faceup = false;
        t.attacked = true;
        game.say(`${t.name} was flipped face-down into Defense Position by Book of Moon.`);
      }
    },
  },

  'Monster Reborn': {
    cardText: 'Target 1 monster in either GY; Special Summon it.',
    targets: 1,
    targetFilter: 'GRAVE_ANY',
    resolve: function* (game, link) {
      const t = link.targets[0];
      if (t) yield* game.specialSummon(link.controller, t, { from: ZONE.GRAVE });
    },
  },

  'Premature Burial': {
    cardText: 'Activate by paying 800 LP, then target 1 monster in your GY; Special Summon it in Attack Position and equip it with this card.',
    targets: 1,
    targetFilter: 'GRAVE_ANY',
    resolve: function* (game, link) {
      const p = game.players[link.controller];
      const t = link.targets[0];
      if (!t) return;
      H.burn(game, link.controller, 800, link.card);
      if (game.over) return;
      const ok = yield* game.specialSummon(link.controller, t, { from: ZONE.GRAVE, pos: POS.FACEUP_ATTACK });
      if (!ok) return;
      game.moveCard(link.card, ZONE.SPELL, -1, { faceup: true });
      t.equipTargets.push(link.card);
      game.say(`${link.card.name} equipped itself to ${t.name}.`);
    },
  },

  'Snatch Steal': {
    cardText: 'Equip only to an opponent\'s monster. Take control of the equipped monster.',
    targets: 1,
    targetFilter: 'MONSTER_ENEMY_FACEUP',
    resolve: function* (game, link) {
      const t = link.targets[0];
      if (!t) return;
      H.changeController(game, t, link.controller);
    },
  },

  'Enemy Controller': {
    cardText: 'Target 1 face-up monster your opponent controls; change that target\'s battle position.',
    targets: 1,
    targetFilter: 'MONSTER_ENEMY_FACEUP',
    resolve: function* (game, link) {
      const t = link.targets[0];
      if (!t) return;
      if (t.pos === POS.FACEUP_ATTACK) { t.pos = POS.FACEUP_DEFENSE; game.say(`${t.name} is now in Defense Position.`); }
      else { t.pos = POS.FACEUP_ATTACK; game.say(`${t.name} is now in Attack Position.`); }
    },
  },

  'Polymerization': {
    cardText: 'Fusion Summon 1 Fusion Monster from your Extra Deck, using monsters from your hand or field.',
    targets: 0,
    resolve: function* (game, link) {
      game.say('Polymerization: select a Fusion Monster from your Extra Deck.');
      yield* game.fusionSummonFlow(link.controller);
    },
  },

  'Swords of Revealing Light': {
    cardText: 'When activated: flip all face-down monsters your opponent controls face-up. Their Attack Position monsters cannot attack.',
    destination: ZONE.SPELL,
    resolve: function* (game, link) {
      const opp = game.players[1 - link.controller];
      for (const c of opp.monsters) {
        if (c && !c.faceup) {
          c.faceup = true;
          c.pos = POS.FACEUP_DEFENSE;
          game.say(`Swords of Revealing Light revealed ${c.name}.`);
        }
      }
      link.card.continuousModifiers.push({ noAttackByOpponent: true });
    },
  },

  // ================= TRAPS =================

  'Sakuretsu Armor': {
    cardText: 'When an opponent\'s monster declares an attack: Target the attacking monster; destroy that target.',
    trigger: 'ATTACK_DECLARED', targetFilter: 'MONSTER_ENEMY_FACEUP',
    resolve: function* (game, link) { for (const t of link.targets) yield* H.destroy(game, t, 'effect'); },
  },

  'Dimensional Prison': {
    cardText: 'When an opponent\'s monster declares an attack: Target that attacking monster; banish that target.',
    trigger: 'ATTACK_DECLARED', targetFilter: 'MONSTER_ENEMY_FACEUP',
    resolve: function* (game, link) { for (const t of link.targets) H.banish(game, t); },
  },

  'Magic Cylinder': {
    cardText: 'When an opponent\'s monster declares an attack: Target the attacking monster; negate the attack, and if you do, inflict damage to your opponent equal to its ATK.',
    trigger: 'ATTACK_DECLARED', targetFilter: 'MONSTER_ENEMY_FACEUP',
    resolve: function* (game, link) {
      game.cancelAttack('Magic Cylinder negated the attack.');
      const t = link.targets[0];
      if (!t) return;
      H.burn(game, 1 - link.controller, t.atk ?? 0, link.card);
    },
  },

  'Wall of Disruption': {
    cardText: 'All Attack Position monsters your opponent currently controls lose 800 ATK for each monster they control.',
    aura: function (game, card) { return {}; },
  },

  'Torrential Tribute': {
    cardText: 'When a monster(s) is Summoned: Destroy all monsters on the field.',
    trigger: 'SUMMONED',
    resolve: function* (game) {
      for (const c of H.faceupMonstersOnField(game)) yield* H.destroy(game, c, 'effect');
    },
  },

  'Bottomless Trap Hole': {
    cardText: 'When your opponent Summons a monster(s) with 1500 or more ATK: Destroy that monster(s) with 1500 or more ATK, and if you do, banish it.',
    trigger: 'SUMMONED', summonFilter: (c) => (c.atk ?? 0) >= 1500,
    resolve: function* (game, link) {
      const dctx = game.lastSummoned;
      if (!dctx) return;
      H.banish(game, dctx.card);
    },
  },

  'Call of the Haunted': {
    cardText: 'Target 1 monster in your GY; Special Summon that target in Attack Position. When this card leaves the field, destroy that monster.',
    trigger: null, manualTargets: 1, targetFilter: 'GRAVE_ANY',
    destination: ZONE.SPELL,
    resolve: function* (game, link) {
      const t = link.targets[0];
      if (!t) return;
      const ok = yield* game.specialSummon(link.controller, t, { from: ZONE.GRAVE, pos: POS.FACEUP_ATTACK });
      if (!ok) return;
      link.card.equipTargets = [t];
      t.equipTargets.push(link.card);
      game.say(`Call of the Haunted is bound to ${t.name}.`);
    },
  },

  'Waboku': {
    cardText: 'You take no battle damage this turn. Your monsters cannot be destroyed by battle this turn.',
    trigger: null, manual: false, destination: ZONE.SPELL,
    aura: function () { return {}; },
    onActivate: function (game, link) {
      game.turnFlags.add('noBattleDamage');
      game.turnFlags.add('noBattleDestroy');
      game.say('Waboku shields you from battle damage and battle destruction this turn.');
    },
  },
};

// Wall of Disruption is an aura, not an activation: recompute after board changes.
EFFECTS['Wall of Disruption'].aura = function () { return {}; };

// --- registration ----------------------------------------------------------

/** Finds an effect entry for a card, or a conservative interpretation. */
Game.prototype.getEffect = function (card) {
  if (!card) return null;
  const e = EFFECTS[card.name];
  if (e) {
    const n = e.trigger ? 0 : (e.manualTargets || 0);
    return {
      resolve: e.resolve,
      targets: e.targets || 0,
      manualTargets: e.manualTargets || 0,
      targetFilter: e.targetFilter,
      legalTarget: e.legalTarget,
      destination: e.destination,
      fromGrave: e.fromGrave,
      onActivate: e.onActivate,
      timing: e.cardText,
    };
  }
  return interpret(card);
};

/** True while any Jinzo is face-up on the field. */
Game.prototype.trapsLocked = function () {
  for (const p of this.players) {
    for (const c of p.monsters) {
      if (c && c.faceup && !c.negated && c.name === 'Jinzo') return true;
    }
  }
  return false;
};

/** True while the given controller's Attack Position monsters are locked. */
Game.prototype.attackLocked = function (playerIdx) {
  const opp = this.players[1 - playerIdx];
  return opp.spells.some((c) => c && c.faceup && c.continuousModifiers.some((m) => m.noAttackByOpponent));
};

/** Recomputes every continuous modifier. Call after any board change. */
Game.prototype.refreshContinuous = function () {
  for (const card of this.allCards()) card.continuousModifiers = [];

  // self-modifying auras
  for (const card of this.allCards()) {
    if (!card.onField || !card.faceup || card.negated) continue;
    const e = EFFECTS[card.name];
    if (e && typeof e.aura === 'function') {
      try {
        const m = e.aura(this, card);
        if (m && (m.atk || m.def)) card.continuousModifiers.push(m);
      } catch { /* leave unmodified */ }
    }
  }

  // Wall of Disruption: each face-up copy weakens the opponent's field.
  for (const owner of this.players) {
    const walls = owner.spells.filter((c) => c && c.faceup && !c.negated && c.name === 'Wall of Disruption');
    if (!walls.length) continue;
    const foe = this.players[1 - owner.index];
    const n = foe.monsters.filter(Boolean).length * walls.length;
    for (const c of foe.monsters) {
      if (c && c.faceup && c.pos === POS.FACEUP_ATTACK) c.continuousModifiers.push({ atk: -800 * n });
    }
  }

  // Swords of Revealing Light blocks attacks.
  for (const owner of this.players) {
    for (const c of owner.spells) {
      if (c && c.faceup && c.name === 'Swords of Revealing Light') c.continuousModifiers.push({ noAttackByOpponent: true });
    }
  }
};

/** Controller change used by Snatch Steal. */
Game.prototype.changeController = H.changeController = function (game, card, newController) {
  const wasFaceup = card.faceup, wasPos = card.pos;
  const loc = game.locate(card);
  game.removeFrom(card, loc);
  card.controller = newController;
  card.equipTargets = card.equipTargets.filter((e) => game.locate(e));
  const to = game.players[newController];
  const zone = to.firstFreeMonsterZone(0);
  const landed = zone >= 0 ? game.moveCard(card, ZONE.MONSTER, zone, { faceup: wasFaceup, pos: wasPos }) : false;
  if (!landed) {
    card.controller = 1 - newController;
    game.moveCard(card, ZONE.GRAVE);
    game.say(`${card.name} could not change hands - sent to the Graveyard instead.`);
    return;
  }
  card.summonTurn = game.turn;
  game.say(`${card.name} changes hands to ${to.name}.`);
  game.refreshContinuous();
};

// --- trigger registration --------------------------------------------------

/**
 * Traps that watch the board. Each is offered only on the opponent's turn and
 * only while set (face-down or face-up) in a spell/trap zone.
 */
export function registerTriggers() {
  const g = Game.prototype;

  const trapSpecs = [
    { name: 'Sakuretsu Armor', event: 'ATTACK_DECLARED', filter: null, tf: 'MONSTER_ENEMY_FACEUP' },
    { name: 'Dimensional Prison', event: 'ATTACK_DECLARED', filter: null, tf: 'MONSTER_ENEMY_FACEUP' },
    { name: 'Magic Cylinder', event: 'ATTACK_DECLARED', filter: null, tf: 'MONSTER_ENEMY_FACEUP' },
    { name: 'Torrential Tribute', event: 'SUMMONED', filter: null, tf: null },
    { name: 'Bottomless Trap Hole', event: 'SUMMONED', filter: (c) => (c.atk ?? 0) >= 1500, tf: null },
  ];

  for (const spec of trapSpecs) {
    g.registerTrigger(spec.event, {
      opponentTurnOnly: true,
      when: (c, game, ctx) => {
        if (c.name !== spec.name) return false;
        if (!c.card.isTrap) return false;
        if (c.zone !== ZONE.SPELL) return false;
        if (c.turnSet === game.turn) return false;      // cannot respond the turn it was set
        if (game.trapsLocked()) return false;
        if (spec.name === 'Bottomless Trap Hole' && (!ctx.card || ctx.card.controller === c.controller)) return false;
        if (spec.filter && !spec.filter(c)) return false;
        return true;
      },
      targets: (game, ctx) => {
        if (spec.name === 'Sakuretsu Armor' || spec.name === 'Dimensional Prison' || spec.name === 'Magic Cylinder') {
          return ctx.attacker ? 1 : 0;
        }
        return 0;
      },
      targetFilter: () => spec.tf,
      resolve: function* (game, link) {
        const e = EFFECTS[link.card.name];
        if (e && typeof e.resolve === 'function') yield* e.resolve(game, link);
      },
    });
  }

  // Grave effects: Sangan / Witch / Mystic Tomato / Goyo Guardian.
  g.registerTrigger('DESTROYED', {
    fromGrave: true,
    when: (c, game, ctx) => {
      const e = EFFECTS[c.name];
      if (!e || !e.fromGrave) return false;
      return true;
    },
    targets: 0,
    resolve: function* (game, link) {
      const e = EFFECTS[link.card.name];
      if (e && typeof e.resolve === 'function') yield* e.resolve(game, link);
    },
  });

  // "When this card is destroyed by battle and sent to the Graveyard"
  g.registerTrigger('DESTROYED', {
    fromGrave: true,
    when: (c, game, ctx) => {
      const e = EFFECTS[c.name];
      if (!e || !e.destroyedByBattle) return false;
      if (ctx.reason !== 'battle') return false;
      game.lastDestroyedByBattle = { card: ctx.destroyedCard || c, controller: c.controller };
      return true;
    },
    targets: 0,
    resolve: function* (game, link) {
      const e = EFFECTS[link.card.name];
      if (e && typeof e.resolve === 'function') yield* e.resolve(game, link);
    },
  });
}

// --- generic description interpreter --------------------------------------

const PATTERNS = [
  {
    name: 'BURN',
    test: /inflict (\d{3,5}) damage/i,
    build: (m) => function* (game, link) {
      const amount = parseInt(m[1], 10);
      const who = yield* H.askPlayerTarget(game, link, amount);
      if (who !== null) H.burn(game, who, amount, link.card);
    },
  },
  {
    name: 'DRAW_N',
    test: /\bDraw (\d) card/i,
    build: (m) => function* (game, link) { game.drawCards(link.controller, parseInt(m[1], 10)); },
  },
  {
    name: 'DESTROY_ALL_FACEUP_MONSTERS',
    test: /destroy all (?:face-up )?monsters on the field/i,
    build: () => function* (game) {
      for (const c of H.faceupMonstersOnField(game)) yield* H.destroy(game, c, 'effect');
    },
  },
  {
    name: 'DESTROY_ALL_OPPONENT_MONSTERS',
    test: /destroy all monsters your opponent controls/i,
    build: () => function* (game, link) {
      const foe = game.players[1 - link.controller];
      for (const c of foe.monsters) if (c && c.faceup) yield* H.destroy(game, c, 'effect');
    },
  },
];

/**
 * Best-effort effect for a card with no hand-written entry.
 * Returns null when nothing is recognised, in which case the card is inert and
 * the log says so - it never silently pretends to resolve.
 */
function interpret(card) {
  const desc = card.card?.desc || '';
  if (!desc) return null;
  for (const p of PATTERNS) {
    const m = desc.match(p.test);
    if (m) return { resolve: p.build(m), targets: 0, interpreted: p.name, timing: desc };
  }
  return null;
}

/** Honest effect-coverage report for the UI. */
export function effectCoverage(db) {
  const scripted = new Set(Object.keys(EFFECTS));
  let exact = 0, interpreted = 0, inert = 0;
  const effectCards = db.all().filter((c) => c.desc && (c.isEffect || c.isSpellTrap));
  for (const c of effectCards) {
    if (scripted.has(c.name)) exact++;
    else if (PATTERNS.some((p) => p.test.test(c.desc))) interpreted++;
    else inert++;
  }
  return { total: db.size, effectCards: effectCards.length, exact, interpreted, inert, scriptedNames: [...scripted] };
}
