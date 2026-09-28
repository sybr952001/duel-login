// ============================================================================
// Headless driver - answers engine requests with a simple policy so the engine
// can be exercised in Node without a browser. Used by the test suite and by
// the puzzle validator (which replays known solutions through this driver).
// ============================================================================

import { ACTION, PHASE, ZONE, POS } from './engine.js';

/**
 * policy(decision) -> answer
 *   decision = {kind, game, player, mode, actions, spec, ...}
 */
export class Driver {
  constructor(policy) {
    this.policy = policy || defaultPolicy;
    this.script = null;   // optional list of answers, consumed in order
    this.answered = 0;
  }

  attach(game) {
    this.game = game;
    game.on((ev) => {
      if (ev.type === 'request') this.handle(ev.data);
    });
    return this;
  }

  handle(req) {
    let answer;
    if (this.script && this.script.length) {
      answer = this.script.shift();
    } else {
      answer = this.policy(req, this);
    }
    this.answered++;
    // Answer asynchronously would break the generator stack, so resolve now.
    queueMicrotask(() => this.game.resume(answer));
  }
}

export function defaultPolicy(req) {
  if (req.kind === 'priority') {
    // Always pass: exercises the phase structure and lets effects run.
    return { type: ACTION.PASS };
  }
  if (req.spec && req.spec.kind === 'yesno') {
    return false;
  }
  if (req.spec && req.spec.kind === 'target') {
    const c = req.spec.candidates;
    if (!c || !c.length) return [];
    return [c[0]];
  }
  if (req.spec && req.spec.kind === 'card') {
    return req.spec.cards.slice(0, req.spec.max || 1);
  }
  return null;
}

/**
 * A greedy attacking policy: normal summons, then attacks when possible.
 * Good enough to force the engine through real duels in tests.
 */
export function greedyPolicy(req) {
  if (req.kind === 'priority') {
    const acts = req.actions || [];
    const order = [ACTION.ATTACK, ACTION.NORMAL_SUMMON, ACTION.ACTIVATE, ACTION.SET_MONSTER, ACTION.FLIP_SUMMON];
    for (const t of order) {
      const a = acts.find((x) => x.type === t);
      if (a) return a;
    }
    return { type: ACTION.PASS };
  }
  return defaultPolicy(req);
}

/** Replays a fixed list of actions/answers. */
export function scriptedDriver(answers) {
  const d = new Driver(defaultPolicy);
  d.script = answers.slice();
  return d;
}
