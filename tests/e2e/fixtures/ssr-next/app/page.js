// Rendered per request: proves a server answered, not a prebuilt file.
export const dynamic = 'force-dynamic';

export default function Page() {
  return <h1>e2e ssr ok at {new Date().toISOString()}</h1>;
}
