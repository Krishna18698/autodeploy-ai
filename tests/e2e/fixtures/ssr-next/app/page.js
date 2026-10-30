// Rendered per request: proves a server answered, not a prebuilt file.
export const dynamic = 'force-dynamic';

export default function Page() {
  const now = new Date().toISOString();
  return (
    <main data-check={`e2e ssr ok at ${now}`}>
      <span className="badge">Live · server-rendered</span>
      <h1>A Next.js app with a server</h1>
      <p>
        This page was rendered for you just now. Its server runs in a gVisor sandbox that wakes on
        the first visit and sleeps after 15 quiet minutes, so one free VM can host many of them.
      </p>
      <dl>
        <dt>Rendered at</dt>
        <dd>{now.replace('T', ' ').slice(0, 19)} UTC</dd>
        <dt>Framework</dt>
        <dd>Next.js, App Router</dd>
        <dt>Also here</dt>
        <dd>a POST API route at /api/echo</dd>
      </dl>
      <footer>
        Refresh and the time changes. Part of the{' '}
        <a href="https://app.autodeploy.fyi">AutoDeploy</a> demo.
      </footer>
    </main>
  );
}
