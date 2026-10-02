import type { Deps } from './deps.js';

/** Resend when configured; otherwise log the email (local development). */
export async function sendEmail(deps: Deps, m: { to: string; subject: string; text: string }) {
  if (!deps.env.RESEND_API_KEY) {
    deps.log.info({ to: m.to, subject: m.subject }, 'email (not sent: RESEND_API_KEY unset)');
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${deps.env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: deps.env.EMAIL_FROM,
      to: [m.to],
      subject: m.subject,
      text: m.text,
    }),
  });
  if (!res.ok) throw new Error(`email send failed: ${res.status}`);
}
