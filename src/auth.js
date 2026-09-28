// ============================================================================
// Client-side gate.
//
// SECURITY NOTE: everything here runs in the page. Anyone who can open the file
// can read the code, so this is a game-menu style lock, not authentication. It
// exists so the app is not usable by accident, and it is deliberately built on
// WebCrypto primitives (PBKDF2 + HMAC) rather than a hand-rolled comparison.
// The build script embeds only a salt and a PBKDF2 hash of the password, never
// the password itself.
// ============================================================================

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = {
  enc(bytes) {
    let s = '';
    const a = new Uint8Array(bytes);
    for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000));
    return btoa(s);
  },
  dec(str) {
    const s = atob(str);
    const a = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a;
  },
};

const DEFAULT_ITERATIONS = 210000;

async function pbkdf2(password, salt, iterations, usage) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, 256,
  );
  return bits;
}

/** Builds a storable credential: {salt, iterations, hash}, all base64. */
export async function makeCredential(password, iterations = DEFAULT_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, iterations, 'deriveBits');
  return {
    salt: b64.enc(salt),
    iterations,
    hash: b64.enc(hash),
  };
}

/** Constant-time comparison so a wrong guess does not leak a prefix match. */
function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Verifies a password against {salt, iterations, hash}. */
export async function verifyPassword(password, cred) {
  if (!cred || !cred.salt || !cred.hash) return false;
  try {
    const salt = b64.dec(cred.salt);
    const bits = await pbkdf2(password, salt, cred.iterations || DEFAULT_ITERATIONS);
    return equalBytes(new Uint8Array(bits), b64.dec(cred.hash));
  } catch {
    return false;
  }
}

// --- session token ---------------------------------------------------------
// A page-lifetime key mints an HMAC token so the app can tell "already
// unlocked" from "locked" after a reload without ever storing the password.

const SESSION_KEY = 'duel.session.v1';

let sessionSecret = null;

function randomSecret() {
  return crypto.getRandomValues(new Uint8Array(32));
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

export async function openSession(cred, password) {
  if (!await verifyPassword(password, cred)) return false;
  sessionSecret = randomSecret();
  const token = await mintToken();
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ secret: b64.enc(sessionSecret), token })); } catch { /* private mode */ }
  return true;
}

async function mintToken() {
  const payload = JSON.stringify({ exp: Date.now() + 8 * 3600 * 1000, nonce: b64.enc(crypto.getRandomValues(new Uint8Array(8))) });
  const sig = await hmac(sessionSecret, payload);
  return `${b64.enc(enc.encode(payload))}.${b64.enc(sig)}`;
}

/** True when a valid, unexpired token from this browser is present. */
export async function resumeSession() {
  let saved;
  try { saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { return false; }
  if (!saved || !saved.secret || !saved.token) return false;
  try {
    const secret = b64.dec(saved.secret);
    const [payloadB64, sigB64] = saved.token.split('.');
    if (!payloadB64 || !sigB64) return false;
    const expected = await hmac(secret, dec.decode(b64.dec(payloadB64)));
    if (!equalBytes(expected, b64.dec(sigB64))) return false;
    const { exp } = JSON.parse(dec.decode(b64.dec(payloadB64)));
    if (typeof exp !== 'number' || exp < Date.now()) return false;
    sessionSecret = secret;
    return true;
  } catch {
    return false;
  }
}

export function closeSession() {
  sessionSecret = null;
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}
