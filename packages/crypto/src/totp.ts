import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

// One-time codes from authenticator apps (TOTP, RFC 6238 over HOTP, RFC
// 4226): HMAC-SHA1 of the 30-second time step, cut down to 6 digits. Every
// authenticator app speaks this; no outside service is involved.

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('not base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new secret for an authenticator app (160 bits, as RFC 4226 recommends), base32. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The code for one time step. */
export function totpAt(secret: Buffer, step: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', secret).update(msg).digest();
  const off = (h[h.length - 1] as number) & 0xf;
  const bin =
    (((h[off] as number) & 0x7f) << 24) |
    ((h[off + 1] as number) << 16) |
    ((h[off + 2] as number) << 8) |
    (h[off + 3] as number);
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const totpStep = (ms = Date.now()) => Math.floor(ms / 1000 / TOTP_STEP_SECONDS);

/**
 * The time step a code belongs to, or null. One step either side is allowed
 * for clock drift; a step at or before `lastStep` is refused, so a code that
 * was already used (or seen) can't be used again.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  opts: { now?: number; lastStep?: number } = {},
): number | null {
  const digits = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) return null;
  const secret = base32Decode(secretBase32);
  const step = totpStep(opts.now);
  for (const s of [step, step - 1, step + 1]) {
    if (s <= (opts.lastStep ?? -1)) continue;
    // Constant-time, so how long a wrong guess takes says nothing about the code.
    if (timingSafeEqual(Buffer.from(totpAt(secret, s)), Buffer.from(digits))) return s;
  }
  return null;
}

/** What authenticator apps scan: issuer and account name shown in the app. */
export function otpauthUrl(secretBase32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${q}`;
}

/** One-time recovery codes, "xxxx-xxxx" from an alphabet without look-alikes. */
export function newRecoveryCodes(n = 10): string[] {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const part = () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join('');
  return Array.from({ length: n }, () => `${part()}-${part()}`);
}

/** The form recovery codes are compared in (case, spaces and dashes ignored). */
export const normalizeRecoveryCode = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, '');
