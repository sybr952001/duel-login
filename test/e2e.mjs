// End-to-end check of the built single file.
//
// Launches headless Chromium against dist/duel-login.html over the DevTools
// protocol and drives it like a user: the locked gate, clearing a puzzle to
// reveal the password field, wrong password, right password, then clicking
// through more puzzles. Fails on any uncaught page error.
//
//   node test/e2e.mjs [path-to-html]

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HTML = resolve(process.argv[2] || 'dist/duel-login.html');
const PORT = 9333 + (process.pid % 200);
const PASSWORD = process.env.DUEL_PASSWORD || 'duelist';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChromium() {
  for (const c of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
    const r = spawn(c, ['--version'], { stdio: 'ignore' });
    r.on('error', () => {});
    return c;
  }
  return 'chromium';
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.waiting = new Map();
    this.errors = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.waiting.has(msg.id)) {
        const { resolve: res, reject } = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.errors.push(d.exception?.description || d.text);
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.waiting.set(id, { resolve: res, reject: rej }));
  }

  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  }
}

async function waitForTarget() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('chromium devtools never came up');
}

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}

/**
 * Drives the prompt like a player until the duel ends: take a real action when
 * one is offered (which also covers choosing a target), otherwise pass priority.
 * Returns the labels it clicked.
 */
async function playUntilEnd(cdp, maxClicks) {
  const clicks = [];
  for (let i = 0; i < maxClicks; i++) {
    // eslint-disable-next-line no-await-in-loop
    const acted = await cdp.eval(`
      if (!document.querySelector('#overlay').hidden) return 'END';
      const bs = [...document.querySelectorAll('#prompt .acts button')]
        .filter(x => !/^(Cancel|Back)$/.test(x.textContent.trim()));
      const b = bs.find(x => /^(Activate|Attack|Summon|Flip)/.test(x.textContent.trim()))
        || bs.find(x => !x.classList.contains('ghost'))
        || bs[0];
      if (!b) return '';
      b.click();
      await new Promise(r => setTimeout(r, 250));
      return b.textContent.trim();
    `);
    if (!acted || acted === 'END') break;
    clicks.push(acted);
  }
  return clicks;
}

async function main() {
  if (!existsSync(HTML)) throw new Error(`${HTML} not found; run python3 build.py first`);
  const profile = mkdtempSync(join(tmpdir(), 'duel-e2e-'));
  const bin = findChromium();
  const child = spawn(bin, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-dev-shm-usage', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });

  try {
    const wsUrl = await waitForTarget();
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    const cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    const url = `file://${HTML}`;
    await cdp.send('Page.navigate', { url });

    // 1. the card database inflates from the embedded payload
    let loaded = '';
    for (let i = 0; i < 100; i++) {
      loaded = await cdp.eval('return document.querySelector("#load-state")?.textContent || ""');
      if (/cards loaded/.test(loaded)) break;
      await sleep(200);
    }
    check('database inflates', /(\d+) cards loaded/.test(loaded), loaded.trim());

    // 2. crypto.subtle must exist for the password gate
    const secure = await cdp.eval('return !!(window.crypto && window.crypto.subtle)');
    check('WebCrypto available on this origin', secure === true);

    // 3. the gate starts locked: the board is playable, the password field is not
    const locked = await cdp.eval(`
      return {
        gameVisible: !document.querySelector('#game').hidden,
        loginVisible: !document.querySelector('#login').hidden,
        pwHidden: document.querySelector('#gate-open').hidden,
        pwDisabled: document.querySelector('#pw').disabled,
        goDisabled: document.querySelector('#login-go').disabled,
        lockedNote: !document.querySelector('#gate-locked').hidden,
        gateNote: !document.querySelector('#gate-note').hidden,
        lockHidden: document.querySelector('#btn-lock').hidden,
        puzzles: document.querySelectorAll('#puzzle-pick option').length,
      };
    `);
    check('password field is hidden before a puzzle is cleared',
      locked.gameVisible === true && locked.loginVisible === false
      && locked.pwHidden === true && locked.pwDisabled === true && locked.goDisabled === true,
      JSON.stringify(locked));
    check('locked gate explains what to do',
      locked.lockedNote === true && locked.gateNote === true && locked.lockHidden === true);
    check('puzzle list populated', locked.puzzles >= 10, `${locked.puzzles} puzzles`);

    // 4. clearing a puzzle reveals the password field
    const solveClicks = await playUntilEnd(cdp, 40);
    const gate = await cdp.eval(`
      return {
        gameVisible: !document.querySelector('#game').hidden,
        loginVisible: !document.querySelector('#login').hidden,
        pwHidden: document.querySelector('#gate-open').hidden,
        pwDisabled: document.querySelector('#pw').disabled,
        done: document.querySelector('#gate-done').hidden
          ? '' : document.querySelector('#gate-done').textContent,
        logLines: document.querySelectorAll('#log div').length,
        title: document.querySelector('#p-title').textContent,
      };
    `);
    check('clearing a puzzle reveals the password field',
      gate.loginVisible === true && gate.pwHidden === false && gate.pwDisabled === false
      && gate.gameVisible === false,
      JSON.stringify(gate));
    check('the reveal names the puzzle that was cleared',
      /cleared/i.test(gate.done) && gate.done.includes(gate.title), gate.done);
    check('the duel was actually played to clear it', gate.logLines > 0,
      `${gate.logLines} log lines after ${solveClicks.length} clicks: ${solveClicks.slice(0, 5).join(', ')}`);

    // 5. a wrong password is refused and the app stays locked
    await cdp.eval(`
      document.querySelector('#pw').value = 'definitely-wrong';
      document.querySelector('#login-form').requestSubmit();
      await new Promise(r => setTimeout(r, 1500));
    `);
    const errText = await cdp.eval('return document.querySelector("#login-err").hidden ? "" : document.querySelector("#login-err").textContent');
    check('wrong password rejected', /wrong/i.test(errText), errText);
    const stillLocked = await cdp.eval(`
      return !document.querySelector('#game').hidden
        || !sessionStorage.getItem('duel.session.v1');
    `);
    check('app stays locked after a bad password', stillLocked === true);

    // 6. the right password unlocks and a puzzle board renders
    await cdp.eval(`
      document.querySelector('#pw').value = ${JSON.stringify(PASSWORD)};
      document.querySelector('#login-form').requestSubmit();
      await new Promise(r => setTimeout(r, 3000));
    `);
    const view = await cdp.eval(`
      return {
        gameVisible: !document.querySelector('#game').hidden,
        loginVisible: !document.querySelector('#login').hidden,
        title: document.querySelector('#p-title').textContent,
        goal: document.querySelector('#p-goal').textContent,
        promptButtons: document.querySelectorAll('#prompt .acts button').length,
        handCards: document.querySelectorAll('.hand.me .card').length,
        logLines: document.querySelectorAll('#log div').length,
        hasToken: !!sessionStorage.getItem('duel.session.v1'),
      };
    `);
    check('login unlocks the app', view.gameVisible === true && view.loginVisible === false);
    check('unlocking mints a session token', view.hasToken === true);
    check('puzzle title and goal shown', !!view.title && /Goal:/.test(view.goal), `${view.title} / ${view.goal}`);
    check('board renders a hand', view.handCards > 0, `${view.handCards} cards in hand`);
    check('prompt offers actions', view.promptButtons > 0, `${view.promptButtons} buttons`);
    check('log records the opening', view.logLines > 0, `${view.logLines} lines`);

    // 7. clicking a legal action keeps the game healthy
    const clicks = await playUntilEnd(cdp, 25);
    const after = await cdp.eval(`
      return {
        logLines: document.querySelectorAll('#log div').length,
        buttons: document.querySelectorAll('#prompt .acts button').length,
        over: !document.querySelector('#overlay').hidden,
      };
    `);
    check('game advances through player input', after.logLines > view.logLines,
      `${view.logLines} -> ${after.logLines} log lines after ${clicks.length} clicks: ${clicks.slice(0, 5).join(', ')}`);
    check('a puzzle is still winnable once unlocked',
      /failed|solved/i.test(await cdp.eval('return document.querySelector("#ov-title").textContent')),
      await cdp.eval('return document.querySelector("#ov-text").textContent'));

    // 8. a live session survives a reload, so the password is asked once
    await cdp.send('Page.navigate', { url });
    let resumed = { gameVisible: false, loginVisible: true };
    for (let i = 0; i < 100; i++) {
      const t = await cdp.eval('return document.querySelector("#load-state")?.textContent || ""');
      if (/cards loaded/.test(t)) break;
      await sleep(200);
    }
    await sleep(500);
    resumed = await cdp.eval(`
      return { gameVisible: !document.querySelector('#game').hidden,
               loginVisible: !document.querySelector('#login').hidden };
    `);
    check('reload resumes the session without a password',
      resumed.gameVisible === true && resumed.loginVisible === false,
      `login screen ${resumed.loginVisible ? 'shown' : 'skipped'}`);

    // 9. locking re-hides the password field and starts a fresh challenge
    await cdp.eval(`
      document.querySelector('#btn-lock').click();
      await new Promise(r => setTimeout(r, 300));
    `);
    const relocked = await cdp.eval(`
      return { gameVisible: !document.querySelector('#game').hidden,
               pwHidden: document.querySelector('#gate-open').hidden,
               pwDisabled: document.querySelector('#pw').disabled,
               hasToken: !!sessionStorage.getItem('duel.session.v1') };
    `);
    check('lock button re-locks the gate',
      relocked.gameVisible === true && relocked.pwHidden === true
      && relocked.pwDisabled === true && relocked.hasToken === false,
      JSON.stringify(relocked));

    check('no page errors during play', cdp.errors.length === 0, cdp.errors.slice(0, 3).join(' | '));

    ws.close();
  } finally {
    child.kill('SIGKILL');
    rmSync(profile, { recursive: true, force: true });
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`e2e failed: ${err.message}`);
  process.exitCode = 1;
});
