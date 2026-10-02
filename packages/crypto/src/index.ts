import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

// Envelope encryption: each secret gets its own random data key (DEK); the
// DEK is wrapped by a versioned master key. Rotating the master key only
// re-wraps DEKs (rewrap) — the encrypted values themselves never change.

const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

export type Keyring = { current: number; keys: Map<number, Buffer> };

/** Parses "1:<base64-32-bytes>,2:<base64-32-bytes>"; the highest version encrypts. */
export function parseKeyring(spec: string): Keyring {
  const keys = new Map<number, Buffer>();
  for (const part of spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [v, b64] = part.split(':');
    const version = Number(v);
    const key = Buffer.from(b64 ?? '', 'base64');
    if (!Number.isInteger(version) || version < 1) throw new Error(`bad key version "${v}"`);
    if (key.length !== 32) throw new Error(`key v${version} must be 32 bytes (got ${key.length})`);
    keys.set(version, key);
  }
  if (keys.size === 0) throw new Error('keyring is empty');
  return { current: Math.max(...keys.keys()), keys };
}

function seal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv(ALG, key, iv);
  c.setAAD(Buffer.from(aad));
  const data = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]);
}

function open(key: Buffer, sealed: Buffer, aad: string): Buffer {
  const iv = sealed.subarray(0, IV_LEN);
  const tag = sealed.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = sealed.subarray(IV_LEN + TAG_LEN);
  const d = createDecipheriv(ALG, key, iv);
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]);
}

export type Envelope = { ciphertext: Buffer; dekCiphertext: Buffer; keyVersion: number };

/**
 * `context` is bound as additional authenticated data (e.g. "env:<projectId>:<KEY>"),
 * so a ciphertext copied onto another row fails to decrypt.
 */
export function encrypt(ring: Keyring, plaintext: string, context: string): Envelope {
  const master = ring.keys.get(ring.current);
  if (!master) throw new Error('current master key missing');
  const dek = randomBytes(32);
  return {
    ciphertext: seal(dek, Buffer.from(plaintext, 'utf8'), context),
    dekCiphertext: seal(master, dek, `dek:${context}`),
    keyVersion: ring.current,
  };
}

export function decrypt(ring: Keyring, env: Envelope, context: string): string {
  const master = ring.keys.get(env.keyVersion);
  if (!master) throw new Error(`master key v${env.keyVersion} not in keyring`);
  const dek = open(master, env.dekCiphertext, `dek:${context}`);
  return open(dek, env.ciphertext, context).toString('utf8');
}

/** Re-wrap a DEK under the current master key (key rotation). */
export function rewrap(ring: Keyring, env: Envelope, context: string): Envelope {
  if (env.keyVersion === ring.current) return env;
  const old = ring.keys.get(env.keyVersion);
  const master = ring.keys.get(ring.current);
  if (!old || !master) throw new Error('keyring missing a version needed for rewrap');
  const dek = open(old, env.dekCiphertext, `dek:${context}`);
  return {
    ciphertext: env.ciphertext,
    dekCiphertext: seal(master, dek, `dek:${context}`),
    keyVersion: ring.current,
  };
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hmacSha256Hex(secret: string | Buffer, payload: string | Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/** Constant-time comparison of two strings (false on length mismatch). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** "sk-…a1b2" — enough to recognise a value without revealing it. */
export function previewSecret(value: string): string {
  if (value.length <= 8) return '•'.repeat(Math.max(4, value.length));
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}
