import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

// display 'swap': Geist always shows once loaded; next/font sizes the
// fallback to match, so the swap barely moves anything.
// Geist everywhere; Geist Mono for logs, IDs and code, where columns must line up.
const sans = Geist({ subsets: ['latin'], variable: '--font-geist', display: 'swap' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono', display: 'swap' });

export const metadata: Metadata = {
  title: 'AutoDeploy — deploys that fix themselves',
  description:
    'Connect a repo. AutoDeploy detects, builds, diagnoses, repairs and validates — and shows you every decision.',
};

export const viewport: Viewport = {
  themeColor: '#08090a',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="min-h-dvh font-sans text-fg">{children}</body>
    </html>
  );
}
