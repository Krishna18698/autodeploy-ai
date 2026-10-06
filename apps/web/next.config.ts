import type { NextConfig } from 'next';

// The dashboard talks to the API through same-origin rewrites, so session
// cookies stay first-party and no CORS preflights are needed.
const API_URL = process.env.API_URL ?? 'http://localhost:4000';

// Everything is same-origin (the API is behind the rewrites below, fonts are
// self-hosted by next/font). Inline scripts/styles are allowed because the App
// Router inlines its bootstrap; nonces would force every page to render
// dynamically. Dev mode also needs eval for fast refresh, so CSP is prod-only.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@autodeploy/contracts', '@autodeploy/core'],
  async rewrites() {
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
