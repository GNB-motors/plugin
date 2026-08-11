/**
 * AES-192-CBC decryption in pure JavaScript — a FALLBACK for crypto.subtle.
 *
 * The FleetEdge SPA encrypts its localStorage `token` / `refresh_token` with
 * AES-192-CBC (key = UTF8 bytes of environment.DKEY, 24 bytes; IV =
 * environment.DIV — see FLEETEDGE_API_DISCOVERY.md). Chromium's WebCrypto
 * implements AES-128 and AES-256 but not AES-192, so a 24-byte key makes
 * crypto.subtle.importKey throw NotSupportedError. The original port was
 * verified under Playwright/Node, where aes-192-cbc exists natively, so the
 * gap only ever appeared in the browser — silently, as "no refresh token".
 *
 * This module is never the first choice: callers try WebCrypto first and only
 * fall back here when it refuses. That way we stay correct on any engine that
 * does support AES-192, without depending on which one the operator uses.
 *
 * Tables are computed at load rather than hard-coded, so there are no 256-entry
 * magic arrays to mistype.
 */

/** Multiply two bytes in GF(2^8) with the AES reduction polynomial 0x11b. */
function gmul(a, b) {
  let p = 0;
  let x = a;
  let y = b;
  for (let i = 0; i < 8; i++) {
    if (y & 1) p ^= x;
    const hi = x & 0x80;
    x = (x << 1) & 0xff;
    if (hi) x ^= 0x1b;
    y >>= 1;
  }
  return p & 0xff;
}

const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);

(function buildTables() {
  // Multiplicative inverses in GF(2^8); 0 maps to 0 by definition.
  const inv = new Uint8Array(256);
  for (let a = 1; a < 256; a++) {
    for (let b = 1; b < 256; b++) {
      if (gmul(a, b) === 1) {
        inv[a] = b;
        break;
      }
    }
  }
  const rotl8 = (v, n) => ((v << n) | (v >>> (8 - n))) & 0xff;
  for (let a = 0; a < 256; a++) {
    const b = inv[a];
    SBOX[a] = (b ^ rotl8(b, 1) ^ rotl8(b, 2) ^ rotl8(b, 3) ^ rotl8(b, 4) ^ 0x63) & 0xff;
  }
  for (let a = 0; a < 256; a++) INV_SBOX[SBOX[a]] = a;
})();

/** AES key expansion. Nk=6 (192-bit), Nb=4, Nr=12 → 52 words. */
function expandKey192(key) {
  const Nk = 6;
  const Nr = 12;
  const total = 4 * (Nr + 1);
  const w = [];
  for (let i = 0; i < Nk; i++) {
    w.push([key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]]);
  }
  let rcon = 1;
  for (let i = Nk; i < total; i++) {
    let temp = w[i - 1].slice();
    if (i % Nk === 0) {
      temp = [temp[1], temp[2], temp[3], temp[0]].map((b) => SBOX[b]);
      temp[0] ^= rcon;
      rcon = gmul(rcon, 2);
    }
    w.push(w[i - Nk].map((b, j) => b ^ temp[j]));
  }
  return w;
}

function addRoundKey(state, w, round) {
  for (let c = 0; c < 4; c++) {
    const word = w[round * 4 + c];
    for (let r = 0; r < 4; r++) state[r + 4 * c] ^= word[r];
  }
}

function invShiftRows(state) {
  for (let r = 1; r < 4; r++) {
    const row = [state[r], state[r + 4], state[r + 8], state[r + 12]];
    for (let c = 0; c < 4; c++) state[r + 4 * c] = row[(c - r + 4) % 4];
  }
}

function invSubBytes(state) {
  for (let i = 0; i < 16; i++) state[i] = INV_SBOX[state[i]];
}

function invMixColumns(state) {
  for (let c = 0; c < 4; c++) {
    const a0 = state[4 * c];
    const a1 = state[4 * c + 1];
    const a2 = state[4 * c + 2];
    const a3 = state[4 * c + 3];
    state[4 * c] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
    state[4 * c + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
    state[4 * c + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
    state[4 * c + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
  }
}

/** Decrypt one 16-byte block. */
function decryptBlock(block, w) {
  const Nr = 12;
  const state = new Uint8Array(block);
  addRoundKey(state, w, Nr);
  for (let round = Nr - 1; round >= 1; round--) {
    invShiftRows(state);
    invSubBytes(state);
    addRoundKey(state, w, round);
    invMixColumns(state);
  }
  invShiftRows(state);
  invSubBytes(state);
  addRoundKey(state, w, 0);
  return state;
}

/**
 * @param {Uint8Array} key 24 bytes
 * @param {Uint8Array} iv 16 bytes
 * @param {Uint8Array} data ciphertext, a non-zero multiple of 16 bytes
 * @returns {Uint8Array} plaintext, PKCS#7 padding removed
 */
export function decryptAes192Cbc(key, iv, data) {
  if (key.length !== 24) throw new Error(`AES-192 needs a 24-byte key, got ${key.length}`);
  if (iv.length !== 16) throw new Error(`CBC needs a 16-byte IV, got ${iv.length}`);
  if (data.length === 0 || data.length % 16 !== 0) {
    throw new Error(`ciphertext must be a non-zero multiple of 16 bytes, got ${data.length}`);
  }

  const w = expandKey192(key);
  const out = new Uint8Array(data.length);
  let prev = iv;
  for (let off = 0; off < data.length; off += 16) {
    const block = data.subarray(off, off + 16);
    const plain = decryptBlock(block, w);
    for (let i = 0; i < 16; i++) out[off + i] = plain[i] ^ prev[i];
    prev = block;
  }

  // PKCS#7 unpad. A bad pad means the wrong key or corrupt input — say so,
  // rather than returning garbage that fails later as a confusing JWT error.
  const pad = out[out.length - 1];
  if (pad < 1 || pad > 16 || pad > out.length) {
    throw new Error(`bad PKCS#7 padding (0x${pad.toString(16)}) — wrong key or corrupt data`);
  }
  for (let i = out.length - pad; i < out.length; i++) {
    if (out[i] !== pad) throw new Error('bad PKCS#7 padding — wrong key or corrupt data');
  }
  return out.subarray(0, out.length - pad);
}
