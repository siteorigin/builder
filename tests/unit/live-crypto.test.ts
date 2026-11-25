import { describe, expect, it, vi } from 'vitest';
import { createPrivateKey, sign as nodeSign } from 'node:crypto';
import {
  fromBase64Url,
  generateHostKeyPair,
  hostChallengeBytes,
  importHostPublicKey,
  isHostPublicKey,
  newNonce,
  newRoomId,
  signHostChallenge,
  toBase64Url,
  verifyHostChallenge,
  PUBLIC_KEY_RE,
  SIGNATURE_RE,
  NONCE_RE
} from '@shared/live/crypto';
import { ROOM_ID_RE } from '@shared/live/limits';

const challenge = () => ({ roomId: newRoomId(), nonce: newNonce() });

/** The signature with one bit of one byte flipped, still well-formed base64url of 64 bytes. */
function flipBit(signature: string, byte = 10): string {
  const bytes = fromBase64Url(signature)!;
  bytes[byte] ^= 1;
  return toBase64Url(bytes);
}

describe('base64url', () => {
  it('round-trips every length and byte value', () => {
    for (let n = 0; n < 70; n++) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37 + n * 11) & 0xff);
      const text = toBase64Url(bytes);
      expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(Array.from(fromBase64Url(text)!)).toEqual(Array.from(bytes));
    }
  });

  it('matches the standard encoding', () => {
    expect(toBase64Url(new TextEncoder().encode('any carnal pleas'))).toBe('YW55IGNhcm5hbCBwbGVhcw');
    expect(toBase64Url(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe('-_-_');
  });

  it('refuses padding, other alphabets, impossible lengths and stray trailing bits', () => {
    expect(fromBase64Url('YQ==')).toBeNull();
    expect(fromBase64Url('a+b/')).toBeNull();
    expect(fromBase64Url('abcdA')).toBeNull(); // a length no byte string has, whatever its last bits
    expect(fromBase64Url('YR')).toBeNull(); // "YQ" is the one spelling of "a"
    expect(fromBase64Url('YQ')).toEqual(new Uint8Array([0x61]));
    expect(fromBase64Url(' YQ')).toBeNull();
  });
});

describe('room IDs and nonces', () => {
  it('draw room IDs from the whole alphabet, a random byte at a time', () => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
      const bytes = array as unknown as Uint8Array;
      // 0..23 for the first ID; the high bits are ignored.
      bytes.forEach((_, i) => (bytes[i] = i + 32 * (i % 3)));
      return array;
    });
    try {
      expect(newRoomId()).toBe('23456789abcdefghijkmnpqr');
      spy.mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
        const bytes = array as unknown as Uint8Array;
        bytes.forEach((_, i) => (bytes[i] = 8 + i));
        return array;
      });
      // 8..31: the rest of the alphabet.
      expect(newRoomId()).toBe('abcdefghijkmnpqrstuvwxyz');
    } finally {
      spy.mockRestore();
    }
  });

  it('are fresh, well-formed and unguessable', () => {
    const rooms = new Set(Array.from({ length: 200 }, newRoomId));
    expect(rooms.size).toBe(200);
    for (const id of rooms) expect(id).toMatch(ROOM_ID_RE);
    const nonce = newNonce();
    expect(nonce).toMatch(NONCE_RE);
    expect(fromBase64Url(nonce)!.length).toBe(32);
  });
});

describe('host challenge-response', () => {
  it('verifies a challenge signed by the matching key', async () => {
    const keys = await generateHostKeyPair();
    expect(keys.publicKey).toMatch(PUBLIC_KEY_RE);
    const c = challenge();
    const signature = await signHostChallenge(keys.privateKey, c);
    expect(signature).toMatch(SIGNATURE_RE);
    expect(await verifyHostChallenge(keys.publicKey, c, signature)).toBe(true);
  });

  it('keeps the private key in the process that made it', async () => {
    const keys = await generateHostKeyPair();
    expect(keys.privateKey.extractable).toBe(false);
    await expect(globalThis.crypto.subtle.exportKey('pkcs8', keys.privateKey)).rejects.toThrow();
  });

  it('fails for a tampered challenge', async () => {
    const keys = await generateHostKeyPair();
    const c = challenge();
    const signature = await signHostChallenge(keys.privateKey, c);
    expect(await verifyHostChallenge(keys.publicKey, { ...c, nonce: newNonce() }, signature)).toBe(false);
    expect(await verifyHostChallenge(keys.publicKey, { ...c, roomId: newRoomId() }, signature)).toBe(false);
  });

  it('fails for a signature from another key', async () => {
    const [host, other] = await Promise.all([generateHostKeyPair(), generateHostKeyPair()]);
    const c = challenge();
    expect(await verifyHostChallenge(host.publicKey, c, await signHostChallenge(other.privateKey, c))).toBe(false);
  });

  it('fails, without throwing, for a malformed or altered signature', async () => {
    const keys = await generateHostKeyPair();
    const c = challenge();
    const signature = await signHostChallenge(keys.privateKey, c);
    for (const bad of [flipBit(signature), signature.slice(1), `${signature}A`, '', 'not a signature', signature.replace(/.$/, '+'), toBase64Url(new Uint8Array(64))])
      expect(await verifyHostChallenge(keys.publicKey, c, bad)).toBe(false);
    expect(await verifyHostChallenge(keys.publicKey, c, 42 as unknown as string)).toBe(false);
  });

  it('fails, without throwing, for a malformed public key or challenge', async () => {
    const keys = await generateHostKeyPair();
    const c = challenge();
    const signature = await signHostChallenge(keys.privateKey, c);
    for (const key of ['', keys.publicKey.slice(1), `${keys.publicKey}A`, keys.publicKey.replace(/^./, '+')]) expect(await verifyHostChallenge(key, c, signature)).toBe(false);
    expect(await verifyHostChallenge(keys.publicKey, { roomId: 'NOT-A-ROOM', nonce: c.nonce }, signature)).toBe(false);
    expect(await verifyHostChallenge(keys.publicKey, { roomId: c.roomId, nonce: 'short' }, signature)).toBe(false);
    expect(await verifyHostChallenge(keys.publicKey, null as unknown as typeof c, signature)).toBe(false);
  });

  it('refuses to sign a malformed challenge', async () => {
    const keys = await generateHostKeyPair();
    await expect(signHostChallenge(keys.privateKey, { roomId: 'x', nonce: newNonce() })).rejects.toThrow();
  });

  it('signs one canonical payload, bound to its context, room and nonce', () => {
    const c = { roomId: 'abcdefghijkmnpqrstuvwxyz', nonce: 'A'.repeat(43) };
    expect(new TextDecoder().decode(hostChallengeBytes(c)!)).toBe(`siteorigin-live/host-challenge/v1\nabcdefghijkmnpqrstuvwxyz\n${'A'.repeat(43)}`);
  });

  it('refuses small-order public keys, in every spelling', async () => {
    const hex = (h: string) => toBase64Url(new Uint8Array(h.match(/../g)!.map((b) => parseInt(b, 16))));
    const identity = hex('01' + '00'.repeat(31));
    const orderEight = hex('26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05');
    const orderEightNegated = hex('26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85');
    const pPlusOne = hex('ee' + 'ff'.repeat(30) + '7f');
    const listed = [
      '0000000000000000000000000000000000000000000000000000000000000000',
      '0100000000000000000000000000000000000000000000000000000000000000',
      '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
      'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
      'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'
    ].map(hex);
    for (const key of [identity, orderEight, orderEightNegated, pPlusOne, ...listed]) {
      expect(isHostPublicKey(key)).toBe(false);
      expect(await importHostPublicKey(key)).toBeNull();
    }
    expect(isHostPublicKey((await generateHostKeyPair()).publicKey)).toBe(true);
  });

  it('imports only a 32-byte public key', async () => {
    const keys = await generateHostKeyPair();
    expect(await importHostPublicKey(keys.publicKey)).not.toBeNull();
    expect(await importHostPublicKey(toBase64Url(new Uint8Array(31)))).toBeNull();
    expect(await importHostPublicKey(toBase64Url(new Uint8Array(33)))).toBeNull();
  });

  it('signs and verifies the payload as an independent Ed25519 implementation does', async () => {
    // RFC 8032 test 1's key, and the challenge bytes written out by hand: Node's own Ed25519 signs them.
    const jwk = { kty: 'OKP', crv: 'Ed25519', d: 'nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' };
    const c = { roomId: 'abcdefghijkmnpqrstuvwxyz', nonce: toBase64Url(new Uint8Array(32).map((_, i) => i)) };
    const payload = Buffer.from(`siteorigin-live/host-challenge/v1\n${c.roomId}\n${c.nonce}`, 'utf8');
    const expected = toBase64Url(nodeSign(null, payload, createPrivateKey({ key: jwk, format: 'jwk' })));
    expect(await verifyHostChallenge(jwk.x, c, expected)).toBe(true);
    // Ed25519 is deterministic: the helper's signature with the same key is the same signature.
    const privateKey = await globalThis.crypto.subtle.importKey('jwk', jwk, 'Ed25519', false, ['sign']);
    expect(await signHostChallenge(privateKey, c)).toBe(expected);
  });

  it('still verifies a replayed proof: only the relay’s single-use nonce stops a replay', async () => {
    const keys = await generateHostKeyPair();
    const c = challenge();
    const signature = await signHostChallenge(keys.privateKey, c);
    expect(await verifyHostChallenge(keys.publicKey, c, signature)).toBe(true);
    expect(await verifyHostChallenge(keys.publicKey, c, signature)).toBe(true);
  });
});
