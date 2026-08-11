import { Buffer } from 'node:buffer';
import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptAes192Cbc } from '../aes192cbc.js';

// The real SPA constants (FLEETEDGE_API_DISCOVERY.md). Using them here proves
// the key/IV shapes the extension actually passes are valid for this routine.
const DKEY = new TextEncoder().encode('cGx1dG9pc25vdGFjb21ldA==');
const DIV = new TextEncoder().encode('ttlshiwwuruawshl');

/** Encrypt with Node's own aes-192-cbc — the reference implementation. */
function nodeEncrypt(key, iv, plaintext) {
  const c = createCipheriv('aes-192-cbc', key, iv);
  return new Uint8Array(Buffer.concat([c.update(Buffer.from(plaintext, 'utf8')), c.final()]));
}

describe('decryptAes192Cbc', () => {
  it('round-trips against Node aes-192-cbc with the real SPA key and IV', () => {
    const plain = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEiLCJpYXQiOjE3NTQ5MTIwMDB9.sig';
    const out = decryptAes192Cbc(DKEY, DIV, nodeEncrypt(DKEY, DIV, plain));
    expect(new TextDecoder().decode(out)).toBe(plain);
  });

  it('handles every padding length, including a full padding block', () => {
    // 1..32 bytes exercises pad values 16 down to 1 and a whole extra block.
    for (let len = 1; len <= 32; len++) {
      const plain = 'x'.repeat(len);
      const out = decryptAes192Cbc(DKEY, DIV, nodeEncrypt(DKEY, DIV, plain));
      expect(new TextDecoder().decode(out)).toBe(plain);
    }
  });

  it('matches Node across random keys, IVs and multi-block payloads', () => {
    for (let i = 0; i < 25; i++) {
      const key = new Uint8Array(randomBytes(24));
      const iv = new Uint8Array(randomBytes(16));
      const plain = randomBytes(1 + Math.floor(Math.random() * 200)).toString('hex');
      const out = decryptAes192Cbc(key, iv, nodeEncrypt(key, iv, plain));
      expect(new TextDecoder().decode(out)).toBe(plain);
    }
  });

  it('rejects a wrong key rather than returning garbage', () => {
    const ct = nodeEncrypt(DKEY, DIV, 'sensitive-refresh-token');
    const wrong = new Uint8Array(24).fill(7);
    expect(() => decryptAes192Cbc(wrong, DIV, ct)).toThrow(/padding/);
  });

  it('rejects malformed inputs with a stated reason', () => {
    const ct = nodeEncrypt(DKEY, DIV, 'abc');
    expect(() => decryptAes192Cbc(new Uint8Array(16), DIV, ct)).toThrow(/24-byte key/);
    expect(() => decryptAes192Cbc(DKEY, new Uint8Array(8), ct)).toThrow(/16-byte IV/);
    expect(() => decryptAes192Cbc(DKEY, DIV, new Uint8Array(5))).toThrow(/multiple of 16/);
  });
});
