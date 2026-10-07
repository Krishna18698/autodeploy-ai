// Fixed targets only (never a caller-supplied URL): the runtime may reach the
// public internet, and must not reach the cloud metadata service.
const TARGETS = {
  public: 'https://example.com/',
  metadata: 'http://169.254.169.254/latest/meta-data/',
};

export const dynamic = 'force-dynamic';

export async function GET(req) {
  const which = new URL(req.url).searchParams.get('to');
  const url = TARGETS[which];
  if (!url) return Response.json({ error: 'unknown target' }, { status: 400 });
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), cache: 'no-store' });
    return Response.json({ reached: true, status: res.status });
  } catch (err) {
    return Response.json({
      reached: false,
      error: String(err?.cause?.code ?? err?.message ?? err),
    });
  }
}
