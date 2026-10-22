import {
  base32Decode,
  base32Encode,
  newRecoveryCodes,
  normalizeRecoveryCode,
  otpauthUrl,
  totpAt,
  verifyTotp,
} from '@autodeploy/crypto';
import { describe, expect, it } from 'vitest';

// RFC 6238, appendix B: SHA-1, secret "12345678901234567890", 8 digits.
const SECRET = Buffer.from('12345678901234567890');
const VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('authenticator codes (TOTP)', () => {
  it('matches the RFC 6238 test vectors', () => {
    for (const [t, code] of VECTORS)
      expect(totpAt(SECRET, Math.floor(t / 30), 8), `t=${t}`).toBe(code);
  });

  it('round-trips base32 the way authenticator apps read it', () => {
    expect(base32Encode(SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('gezd gnbv-gy3t qojq gezdgnbvgy3tqojq')).toEqual(SECRET);
  });

  it('accepts the current code and one step of drift, never a used step again', () => {
    const b32 = base32Encode(SECRET);
    const now = 1111111111 * 1000;
    const step = Math.floor(now / 30_000);
    const code = totpAt(SECRET, step);
    expect(verifyTotp(b32, code, { now })).toBe(step);
    expect(verifyTotp(b32, totpAt(SECRET, step - 1), { now })).toBe(step - 1);
    expect(verifyTotp(b32, totpAt(SECRET, step - 2), { now })).toBeNull();
    // Replay: once a step was accepted, its code (and older ones) are refused.
    expect(verifyTotp(b32, code, { now, lastStep: step })).toBeNull();
    expect(verifyTotp(b32, 'abcdef', { now })).toBeNull();
    expect(verifyTotp(b32, `${code.slice(0, 3)} ${code.slice(3)}`, { now })).toBe(step);
  });

  it('builds the URL apps scan, and recovery codes without look-alike letters', () => {
    expect(otpauthUrl('ABC', 'me@x.test', 'AutoDeploy')).toBe(
      'otpauth://totp/AutoDeploy%3Ame%40x.test?secret=ABC&issuer=AutoDeploy&algorithm=SHA1&digits=6&period=30',
    );
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}$/);
    expect(normalizeRecoveryCode(' ABCD-efgh ')).toBe('abcdefgh');
  });
});
