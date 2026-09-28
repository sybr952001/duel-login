// Every shipped puzzle must be provably solvable: the solution is replayed
// through the engine and the goal has to be observed, not assumed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { makeDatabase } from '../src/engine.js';
import { registerTriggers } from '../src/effects.js';
import { Game, DEFAULT_RULES, ZONE, POS } from '../src/engine.js';
import { Driver } from '../src/driver.js';
import { TEMPLATES, verify, listPuzzles } from '../src/puzzle.js';

registerTriggers();
const db = makeDatabase(JSON.parse(
  gunzipSync(Buffer.from(readFileSync(new URL('../src/carddb.b64', import.meta.url), 'utf8').trim(), 'base64')).toString(),
));

test('puzzle list is well formed', () => {
  const list = listPuzzles();
  assert.equal(list.length, TEMPLATES.length);
  for (const p of list) {
    assert.ok(p.id && p.title && p.brief, `incomplete puzzle: ${JSON.stringify(p)}`);
    assert.ok(p.difficulty >= 1 && p.difficulty <= 3);
  }
});

test('every template builds a legal board', () => {
  for (const tpl of TEMPLATES) {
    const cfg = tpl.build();
    assert.equal(cfg.monsters.length, 2, `${tpl.id}: needs a row per player`);
    for (const row of cfg.monsters) assert.equal(row.length, 5, `${tpl.id}: monster zones need 5 slots`);
    assert.equal(typeof tpl.goal, 'function', `${tpl.id}: needs a goal`);
    assert.ok(Array.isArray(tpl.solution) && tpl.solution.length, `${tpl.id}: needs a solution`);
    assert.ok(tpl.hints.length, `${tpl.id}: needs hints`);
  }
});

for (const tpl of TEMPLATES) {
  test(`puzzle is solvable: ${tpl.id}`, async () => {
    const r = await verify(tpl, db, { maxMs: 3000 });
    assert.ok(r.over, `${tpl.id}: game never finished (${r.reason})`);
    assert.ok(r.solved, `${tpl.id}: solution did not reach the goal (${r.reason})`);
  });
}

// A goal that already holds in the starting position would hand the player a
// free win the moment the puzzle loads.
test('no puzzle goal is satisfied by the starting board', () => {
  for (const tpl of TEMPLATES) {
    const g = new Game(db, { strict: true, rules: DEFAULT_RULES, turnLimit: 5 });
    g.puzzle = { title: tpl.title, solved: false, failed: false, moves: 0, hints: [] };
    const gen = g.setupPuzzle(tpl.build());
    let r = gen.next();
    while (!r.done) r = gen.next();
    assert.ok(!tpl.goal(g), `${tpl.id}: goal is already true before the player acts`);
    assert.ok(!g.puzzleSolved(), `${tpl.id}: engine reports a solve before any move`);
  }
});

// --- the password gate depends entirely on `puzzle.solved` ------------------
// The gate reveals the password field when (and only when) a cleared puzzle
// sets puzzle.solved, so that flag has to mean "the goal was met" and nothing
// else. Two ways it used to drift:
//   * a duel that ended the instant the goal became true, on the opponent's
//     turn, was recorded as a loss, so clearing the puzzle revealed nothing;
//   * a duel that ended without the goal - lost, or out of turns - on the
//     opponent's turn was recorded as a solve, revealing the password anyway.

const row = (...cards) => {
  const z = new Array(5).fill(null);
  cards.forEach((c, i) => { z[i] = c; });
  return z;
};
const blank = () => new Array(5).fill(null);

/** Runs a puzzle to its end with a policy that answers trigger prompts. */
async function playOut(cfg, { turnLimit = 8, policy } = {}) {
  const game = new Game(db, { strict: true, rules: DEFAULT_RULES, turnLimit });
  const drive = (req) => {
    if (req.spec && req.spec.kind === 'yesno') return true;
    if (req.spec && req.spec.kind === 'target') {
      const cands = req.spec.candidates || [];
      return cands.length ? [cands[0]] : [];
    }
    if (req.spec && req.spec.kind === 'card') return (req.spec.cards || []).slice(0, req.spec.max || 1);
    if (req.kind !== 'priority') return null;
    return (policy && policy(req)) || { type: 'pass' };
  };
  new Driver(drive).attach(game);
  game.startPuzzle(cfg);
  const t0 = Date.now();
  while (!game.over && Date.now() - t0 < 4000) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 4));
  }
  assert.ok(game.over, 'puzzle never finished');
  return game;
}

const attackIfOffered = (req) => ((req.actions || []).find((a) => a.type === 'attack') || { type: 'pass' });

test('a goal met as the duel ends on the opponent\'s turn still counts as solved', async () => {
  // A set Magic Cylinder burns the attacker for 3000 on the opponent's turn,
  // which is the same instant the opponent hits 0 LP and the duel ends.
  const game = await playOut({
    lp: [8000, 3000],
    turn: 2, current: 1,
    hands: [[], []],
    monsters: [blank(), row({ name: 'Blue-Eyes White Dragon', faceup: true, pos: POS.FACEUP_ATTACK })],
    spells: [[{ name: 'Magic Cylinder', faceup: false }], []],
    decks: [[], []],
    goal: (g) => g.players[1].lp <= 0,
  }, { policy: (req) => (req.game.current === 1 ? attackIfOffered(req) : { type: 'pass' }) });

  assert.equal(game.players[1].lp, 0, 'the counter trap did not burn the attacker');
  assert.equal(game.winner, 0, 'the player should have won the duel');
  assert.equal(game.current, 1, 'the duel should have ended on the opponent\'s turn');
  assert.ok(game.puzzle.solved, 'goal met on the opponent\'s turn was recorded as a loss');
  assert.ok(!game.puzzle.failed);
});

test('a duel lost on the opponent\'s turn does not count as solving the puzzle', async () => {
  const game = await playOut({
    lp: [3000, 3000],
    turn: 2, current: 1,
    hands: [[], []],
    monsters: [blank(), row({ name: 'Blue-Eyes White Dragon', faceup: true, pos: POS.FACEUP_ATTACK })],
    spells: [[], []],
    decks: [[], []],
    goal: (g) => g.players[1].lp <= 0,
  }, { policy: (req) => (req.game.current === 1 ? attackIfOffered(req) : { type: 'pass' }) });

  assert.equal(game.players[0].lp, 0, 'the player should have lost the duel');
  assert.equal(game.winner, 1);
  assert.equal(game.current, 1, 'the duel should have ended on the opponent\'s turn');
  assert.ok(!game.puzzle.solved, 'losing the duel revealed the password field');
});

test('running out of turns without meeting the goal does not count as solving', async () => {
  const game = await playOut({
    lp: [1000, 8000],
    turn: 2, current: 0,
    hands: [[], []], monsters: [blank(), blank()], spells: [[], []], decks: [[], []],
    goal: (g) => g.players[1].lp <= 0,
  }, { turnLimit: 4 });

  assert.equal(game.winReason, 'turn limit');
  assert.ok(!game.puzzle.solved, 'the turn limit revealed the password field');
});

// The invariant itself, across every shipped puzzle: however the duel ended,
// the flag the gate reads agrees with the goal.
test('puzzle.solved agrees with the goal however the duel ended', async () => {
  for (const tpl of TEMPLATES) {
    // eslint-disable-next-line no-await-in-loop
    const game = await playOut({
      ...tpl.build(), turnLimit: 3, goal: tpl.goal,
    }, { turnLimit: 3 });
    assert.equal(
      game.puzzle.solved, tpl.goal(game),
      `${tpl.id}: solved=${game.puzzle.solved} but goal=${tpl.goal(game)} (${game.winReason})`,
    );
  }
});

