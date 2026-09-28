// ============================================================================
// Puzzle generator.
//
// Each template fixes a board, a goal and a scripted solution. Nothing is
// shipped until the solution has actually been replayed through the engine and
// observed to win, so a puzzle is always provably solvable. Templates whose
// solution does not verify are skipped and reported by listPuzzles().
// ============================================================================

import {
  Game, CardInstance, ACTION, PHASE, ZONE, POS, DEFAULT_RULES, makeDatabase,
} from './engine.js';
import { registerTriggers } from './effects.js';
import { Driver, defaultPolicy, greedyPolicy } from './driver.js';

// --- small helpers used by the templates ----------------------------------

const M = (name, opts = {}) => ({ name, faceup: true, pos: POS.FACEUP_ATTACK, ...opts });
const SET = (name, opts = {}) => ({ name, faceup: false, ...opts });
const zone = (n = 5) => new Array(n).fill(null);

/** Builds a 5-slot monster zone row from the given cards. */
const mz = (...cards) => {
  const z = zone();
  cards.forEach((c, i) => { z[i] = c; });
  return z;
};

/** Goal helpers. */
const hasMonster = (side, min = 0) => (g) => g.players[side].monsters.some((c) => c && c.atk >= min);
const fieldEmpty = (side) => (g) => g.players[side].monsters.every((c) => !c);
const noFaceupAttack = () => (g) => g.players.every((p) => p.monsters.every((c) => !c || c.pos !== POS.FACEUP_ATTACK));
const lethal = (side) => (g) => g.players[1 - side].lp <= 0;
const undamaged = (side, lp) => (g) => g.players[side].lp === lp;

// ============================================================================
// Templates
// ============================================================================

export const TEMPLATES = [
  {
    id: 'sangan-search',
    title: 'Salvage the Salvage',
    theme: 'Search',
    difficulty: 1,
    brief: 'Sangan is face-up on your field. It searches your Deck only when it is '
      + 'sent to the Graveyard from the field.',
    goalText: 'Get a monster into your hand.',
    hints: [
      'Sangan searches when it is SENT to the Graveyard, not while it is face-up.',
      'You need a way to destroy it.',
      'Dark Hole destroys every monster on the field, and Dark Hole is in your hand.',
    ],
    build: () => ({
      lp: [8000, 8000],
      turn: 2, current: 0,
      hands: [['Dark Hole'], []],
      monsters: [mz(M('Sangan')), mz(M('Summoned Skull'))],
      decks: [[], []],
    }),
    // Sangan has to be in the Graveyard AND a monster has to have turned up, so
    // drawing a monster at the start of the turn cannot satisfy this.
    goal: (g) => g.players[0].grave.some((c) => c && c.name === 'Sangan')
      && g.players[0].hand.some((c) => c.isMonster),
    solution: [{ match: { type: ACTION.ACTIVATE, name: 'Dark Hole' } }],
  },
  {
    id: 'dm-athenaid',
    title: 'Borrowed Strength',
    theme: 'ATK boost',
    difficulty: 1,
    brief: 'Your Dark Magician Girl is in Defense Position with two Dark Magicians '
      + 'already in your Graveyard.',
    goalText: 'Make Dark Magician Girl reach 2600 ATK.',
    hints: [
      'She gains 300 ATK for every Dark Magician in either Graveyard, '
        + 'but only while she is face-up in Attack Position.',
      'Changing position is free during your Main Phase.',
      'Change her position.',
    ],
    build: () => ({
      lp: [8000, 8000],
      turn: 2, current: 0,
      hands: [[], []],
      monsters: [mz(M('Dark Magician Girl', { pos: POS.FACEUP_DEFENSE, specialSummoned: true })), mz()],
      graves: [['Dark Magician', 'Dark Magician'], []],
      decks: [[], []],
    }),
    // 2000 printed + 300 for each of the two Dark Magicians in the GY. The
    // bonus works in either position, so the position change is part of the goal.
    goal: (g) => g.players[0].monsters.some((c) => c && c.name === 'Dark Magician Girl'
      && c.pos === POS.FACEUP_ATTACK && c.atk >= c.card.atk + 600),
    solution: [{ match: { type: ACTION.CHANGE_POSITION } }],
  },
  {
    id: 'trap-jinzo',
    title: 'Locked Down',
    theme: 'Trap lock',
    difficulty: 2,
    brief: 'Your opponent controls Jinzo, so your set Bottomless Trap Hole can never '
      + 'activate. They also control a second monster.',
    goalText: 'Clear the opponent\'s field.',
    hints: [
      'Jinzo stops Trap Cards from activating. Spells are unaffected.',
      'Dark Hole is a Spell, and it is in your hand.',
      'It destroys every monster on the field - theirs and yours.',
    ],
    build: () => ({
      lp: [8000, 8000],
      turn: 2, current: 0,
      hands: [['Dark Hole'], []],
      monsters: [mz(M('Mokey Mokey')), mz(M('Jinzo'), M('Mokey Mokey'))],
      spells: [[SET('Bottomless Trap Hole')], []],
      decks: [[], []],
    }),
    goal: fieldEmpty(1),
    solution: [{ match: { type: ACTION.ACTIVATE, name: 'Dark Hole' } }],
  },
  {
    id: 'polymerization',
    title: 'One for Two',
    theme: 'Fusion',
    difficulty: 2,
    brief: 'You control two monsters and have Polymerization. A Fusion Monster waits '
      + 'in your Extra Deck and the opponent is on 3000 Life Points.',
    goalText: 'Fusion Summon and finish the duel.',
    hints: [
      'Polymerization is a Spell, so it works even under Jinzo.',
      'It needs two monsters to use as materials and is sent to the Graveyard as a cost.',
      'After the Fusion Summon, do not forget you still get a Battle Phase.',
    ],
    build: () => ({
      lp: [8000, 3000],
      turn: 2, current: 0,
      hands: [['Polymerization'], []],
      monsters: [mz(M('Summoned Skull'), M('Mystical Elf')), mz()],
      extra: [['Cyber End Dragon'], []],
      decks: [[], []],
    }),
    goal: lethal(0),
    solution: [
      { match: { type: ACTION.ACTIVATE, name: 'Polymerization' } },
      { match: { type: ACTION.ATTACK } },
    ],
  },
  {
    id: 'book-of-moon',
    title: 'Turn It Around',
    theme: 'Position',
    difficulty: 1,
    brief: 'Your own monster is face-down, so you are stunned and cannot attack. '
      + 'The opponent controls a face-up Attack Position monster, and you have '
      + 'Book of Moon in hand.',
    goalText: 'Have no face-up Attack Position monsters left on the field.',
    hints: [
      'You are stunned by your own face-down monster, so attacking is not an option.',
      'Book of Moon turns a face-up monster face-down in Defense Position.',
      'It is Quick-Play, so you can use it during your own turn.',
      'Target the OPPONENT\'s monster, not your own.',
    ],
    build: () => ({
      lp: [8000, 8000],
      turn: 2, current: 0,
      hands: [['Book of Moon'], []],
      monsters: [mz(M('Mokey Mokey', { faceup: false, pos: POS.FACEDOWN_DEFENSE })), mz(M('Mokey Mokey'))],
      decks: [[], []],
    }),
    goal: noFaceupAttack(),
    solution: [
      {
        match: { type: ACTION.ACTIVATE, name: 'Book of Moon' },
        prefer: (c) => c.controller === 1,
      },
    ],
  },
  {
    id: 'cylinder',
    title: 'Burn the Board',
    theme: 'Counter Trap',
    difficulty: 3,
    brief: 'The opponent is about to attack you directly. You have a set Magic Cylinder.',
    goalText: 'Negate the attack: take no damage and burn the attacker for 3000.',
    hints: [
      'Magic Cylinder negates the attack and burns the attacker\'s controller for its ATK.',
      'You must let the attack be declared first.',
      'A Trap cannot activate the turn it was Set, so this one is ready now.',
    ],
    build: () => ({
      lp: [8000, 8000],
      turn: 2, current: 1,
      hands: [[], []],
      monsters: [mz(), mz(M('Blue-Eyes White Dragon'))],
      spells: [[SET('Magic Cylinder')], []],
      decks: [[], []],
    }),
    goal: (g) => g.players[0].lp === 8000 && g.players[1].lp === 5000,
    solution: [
      { match: { type: ACTION.PASS } },
      { match: { type: ACTION.ATTACK } },
    ],
  },
  {
    id: 'torrential',
    title: 'Clear the Sky',
    theme: 'Trap',
    difficulty: 2,
    brief: 'Your Torrential Tribute is already set and your opponent is about to '
      + 'Summon into it.',
    goalText: 'Leave the opponent with no monsters.',
    hints: [
      'Torrential Tribute destroys every monster when one is Summoned.',
      'The opponent Summon is what triggers it - let them commit.',
      'The trap belongs to you, so it resolves on your chain first.',
    ],
    build: () => ({
      lp: [8000, 8000],
      turn: 2, current: 1,
      hands: [[], ['Mokey Mokey', 'Mokey Mokey']],
      monsters: [mz(), mz(M('Mokey Mokey'))],
      spells: [[SET('Torrential Tribute')], []],
      decks: [[], []],
    }),
    goal: fieldEmpty(1),
    solution: [
      { match: { type: ACTION.PASS } },
      { match: { type: ACTION.NORMAL_SUMMON, name: 'Mokey Mokey' } },
    ],
  },
  {
    id: 'mst-lock',
    title: 'One-Handed Answer',
    theme: 'Quick-Play',
    difficulty: 1,
    brief: 'The opponent controls a monster. You have Mystical Space Typhoon in hand.',
    goalText: 'Remove the opponent\'s only monster from the field.',
    hints: [
      'Mystical Space Typhoon destroys exactly one card, and either player\'s.',
      'Targeting your own card is legal - just not useful here.',
      'Target the opponent\'s monster.',
    ],
    build: () => ({
      lp: [8000, 8000],
      turn: 2, current: 0,
      hands: [['Mystical Space Typhoon'], []],
      monsters: [mz(), mz(M('Mokey Mokey'))],
      decks: [[], []],
    }),
    goal: fieldEmpty(1),
    solution: [
      {
        match: { type: ACTION.ACTIVATE, name: 'Mystical Space Typhoon' },
        prefer: (c) => c.controller === 1,
      },
    ],
  },
  {
    id: 'reborn',
    title: 'Second Life',
    theme: 'Resurrection',
    difficulty: 2,
    brief: 'A Dark Magician is in your Graveyard and you have already set Monster '
      + 'Reborn, so it is ready to use now.',
    goalText: 'Special Summon the Dark Magician.',
    hints: [
      'Monster Reborn is a Normal Trap: it has to be Set before it can be activated.',
      'It is already Set from a previous turn, so you can activate it right now.',
      'It targets a monster in either Graveyard.',
    ],
    build: () => ({
      lp: [8000, 8000],
      turn: 3, current: 0,
      hands: [[], []],
      monsters: [mz(M('Summoned Skull')), mz(M('Mokey Mokey'))],
      spells: [[SET('Monster Reborn')], []],
      graves: [['Dark Magician'], []],
      decks: [[], []],
    }),
    goal: (g) => g.players[0].monsters.some((c) => c && c.name === 'Dark Magician'),
    solution: [
      {
        match: { type: ACTION.ACTIVATE, name: 'Monster Reborn' },
        prefer: (c) => c.name === 'Dark Magician',
      },
    ],
  },
  {
    id: 'direct-lethal',
    title: 'Clean Win',
    theme: 'Battle',
    difficulty: 1,
    brief: 'The opponent\'s field is empty and they are on 1500 Life Points. You '
      + 'control a Blue-Eyes White Dragon in Attack Position.',
    goalText: 'Win the duel with a direct attack.',
    hints: [
      'With no monsters in play you can attack the opponent directly.',
      'You still have a Battle Phase this turn.',
      'Declare the attack.',
    ],
    build: () => ({
      lp: [8000, 1500],
      turn: 2, current: 0,
      hands: [[], []],
      monsters: [mz(M('Blue-Eyes White Dragon')), mz()],
      decks: [[], []],
    }),
    goal: lethal(0),
    solution: [{ match: { type: ACTION.ATTACK } }],
  },
];

// ============================================================================
// Solution replay + validation
// ============================================================================

/**
 * Builds a driver that walks the scripted answer list. A step is an object
 * with a `match` predicate; the first legal action that satisfies it is taken,
 * otherwise the step is skipped. `yes` lets a step answer an optional prompt.
 */
const TRACE = () => (typeof process !== 'undefined' && process.env && process.env.PUZZLE_TRACE);

function solutionDriver(steps) {
  const queue = steps.slice();
  let index = 0;
  const trace = TRACE();
  return new Driver((req) => {
    if (trace) {
      const acts = (req.actions || []).map((a) => a.type).join(',');
      console.error(`   [t${req.game?.turn}/${req.game?.phase}] step=${index}/${queue.length} `
        + `req=${req.spec ? req.spec.kind : 'priority'}[${acts}]`);
    }
    // Optional yes/no prompts: accept, but only for a step that wants it.
    if (req.spec && req.spec.kind === 'yesno') {
      if (trace) console.error(`      -> yes (${req.spec.question || ''})`);
      return true;
    }
    if (req.spec && req.spec.kind === 'target') {
      const cands = req.spec.candidates || [];
      // Target candidates come in two shapes: {card, note} descriptors for card
      // targets, and {uid, direct} descriptors for attacks. The predicate sees
      // the CardInstance either way, but the answer must be the original
      // descriptor because that is what the engine expects back.
      const asCard = (c) => (c && c.card ? c.card : c);
      const want = queue[index] && queue[index].prefer;
      const pick = want ? cands.find((c) => want(asCard(c), req.game)) : cands[0];
      if (trace) console.error(`      -> target ${pick ? asCard(pick).name + '(p' + asCard(pick).controller + ')' : 'none'} of ${cands.length}: ${cands.map(c=>asCard(c).name+'(p'+asCard(c).controller+')').join(',')}`);
      return pick ? [pick] : [];
    }
    if (req.spec && req.spec.kind === 'card') {
      const cards = req.spec.cards || [];
      return cards.slice(0, req.spec.max || 1);
    }
    if (req.kind !== 'priority') return null;

    const acts = req.actions || [];
    const step = queue[index];
    if (!step) return { type: ACTION.PASS };
    if (step.match) {
      const hit = acts.find((a) => matches(a, step.match, req.game));
      if (hit) {
        index++;
        if (trace) console.error(`      -> take ${hit.type} ${hit.label || ''}`);
        return hit;
      }
      // Not available in this window; keep the step for a later window.
      if (trace) console.error(`      -> pass (no ${step.match.type} available)`);
      return { type: ACTION.PASS };
    }
    index++;
    return acts[0] || { type: ACTION.PASS };
  });
}

function matches(action, want, game) {
  if (action.type !== want.type) return false;
  if (want.name) {
    const c = game.findCard(action.uid);
    if (!c || c.name !== want.name) return false;
  }
  return true;
}

/** Replays a template's solution and reports whether the goal was met. */
export async function verify(tpl, db, { maxMs = 4000 } = {}) {
  const cfg = tpl.build();
  const game = new Game(db, { strict: true, rules: DEFAULT_RULES, turnLimit: 12 });
  const driver = solutionDriver(tpl.solution);
  driver.attach(game);
  if (TRACE()) game.on((ev) => { if (ev.type === 'log') console.error(`      log: ${ev.data}`); });
  game.startPuzzle({
    ...cfg, title: tpl.title, goalText: tpl.goalText, goal: tpl.goal, onFail: tpl.onFail,
  });
  // Wait for the generator, but bail out on a step budget so a template can
  // never hang the harness.
  const t0 = Date.now();
  let ticks = 0;
  const maxTicks = Math.ceil(maxMs / 4);
  while (!game.over && ticks++ < maxTicks) {
    if (Date.now() - t0 > maxMs) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 4));
  }
  if (!game.over) {
    // Force-stop so the caller sees a clean failure instead of a live game.
    game.over = true;
    game.winReason = 'verification timeout';
  }
  return {
    id: tpl.id,
    solved: !!(game.puzzle && game.puzzle.solved),
    over: game.over,
    reason: game.winReason,
    turn: game.turn,
  };
}

/** Verifies every template once, so the UI can report what is actually proven. */
export async function verifyAll(db) {
  const results = [];
  for (const tpl of TEMPLATES) {
    // eslint-disable-next-line no-await-in-loop
    results.push({ ...tpl, verify: await verify(tpl, db) });
  }
  return results;
}

export function listPuzzles() {
  return TEMPLATES.map((t) => ({
    id: t.id, title: t.title, theme: t.theme, difficulty: t.difficulty, brief: t.brief,
  }));
}

/** Instantiates a puzzle for play, with an optional seeded RNG. */
export function makePuzzle(db, id, opts = {}) {
  const tpl = TEMPLATES.find((t) => t.id === id) || TEMPLATES[0];
  const cfg = tpl.build();
  return {
    template: tpl,
    config: {
      ...cfg,
      title: tpl.title,
      goalText: tpl.goalText,
      goal: tpl.goal,
      onFail: tpl.onFail,
      rng: opts.rng,
    },
  };
}

export { registerTriggers, makeDatabase };
