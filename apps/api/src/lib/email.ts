import type { Env } from '../env.js';

export type Email = { to: string; subject: string; text: string };

/** Resend when configured; otherwise the email is only logged (local development). */
export async function sendEmail(env: Pick<Env, 'RESEND_API_KEY' | 'EMAIL_FROM'>, m: Email) {
  if (!env.RESEND_API_KEY) {
    console.info(`email to ${m.to} not sent (RESEND_API_KEY unset): ${m.subject}`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [m.to], subject: m.subject, text: m.text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`email send failed: ${res.status}`);
}
