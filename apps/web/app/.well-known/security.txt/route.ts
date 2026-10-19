import { LEGAL } from '@/lib/legal';

// RFC 9116: where to report vulnerabilities. Served only once a contact address is set.
export function GET() {
  if (!LEGAL.email) return new Response('Not found', { status: 404 });
  const body = [
    `Contact: mailto:${LEGAL.email}`,
    'Expires: 2027-10-19T00:00:00.000Z',
    'Preferred-Languages: en',
    `Canonical: ${LEGAL.appUrl}/.well-known/security.txt`,
    `Policy: ${LEGAL.appUrl}/security`,
    '',
  ].join('\n');
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
