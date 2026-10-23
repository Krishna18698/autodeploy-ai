import type { NextConfig } from 'next';

// The browser calls the API at its own address (api.<domain>), so the
// dashboard's pages, served by Vercel, keep loading when the VM is down and the
// API sees each visitor's real address from Cloudflare. Local development
// leaves it empty: same-origin paths, proxied by the rewrites below.
const API_ORIGIN =
  process.env.API_ORIGIN ?? (process.env.VERCEL ? 'https://api.autodeploy.fyi' : '');
const API_URL = process.env.API_URL ?? (API_ORIGIN || 'http://localhost:4000');

// People belong on the platform's app hostname (Vercel serves it directly):
// it is the only address the API takes the dashboard's calls from, so a visit
// to *.vercel.app is sent over (nothing there could ever sign in).
const APP_PUBLIC_URL =
  process.env.APP_PUBLIC_URL ?? (process.env.VERCEL ? 'https://app.autodeploy.fyi' : '');

// Everything is same-origin but the API (fonts are self-hosted by
// next/font). Inline scripts/styles are allowed because the App
// Router inlines its bootstrap; nonces would force every page to render
// dynamically. Dev mode also needs eval for fast refresh, so CSP is prod-only.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob:${API_ORIGIN ? ` ${API_ORIGIN}` : ''}`,
  "font-src 'self'",
  `connect-src 'self'${API_ORIGIN ? ` ${API_ORIGIN}` : ''}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@autodeploy/contracts', '@autodeploy/core'],
  env: { AUTODEPLOY_API_ORIGIN: API_ORIGIN },
  async redirects() {
    if (!APP_PUBLIC_URL) return [];
    return [
      {
        source: '/:path*',
        has: [{ type: 'host', value: '.*\\.vercel\\.app' }],
        destination: `${APP_PUBLIC_URL}/:path*`,
        permanent: false,
      },
    ];
  },
  async rewrites() {
    // With the API on its own address, the only call left on this host moves
    // sessions signed in through it over to the API's (routes/session-move.ts).
    // Nothing else is proxied: through here the API would see Vercel's address,
    // not the visitor's, and per-visitor limits would stop working.
    if (API_ORIGIN)
      return [{ source: '/auth/session/handoff', destination: `${API_URL}/auth/session/handoff` }];
    return [
      { source: '/api/:path*', destination: `${API_URL}/api/:path*` },
      { source: '/auth/:path*', destination: `${API_URL}/auth/:path*` },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
          },
          ...(process.env.NODE_ENV === 'production'
            ? [{ key: 'Content-Security-Policy', value: CSP }]
            : []),
        ],
      },
    ];
  },
};

export default config;
