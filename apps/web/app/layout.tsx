import type { Metadata, Viewport } from 'next';
import { Instrument_Serif, Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';

// display 'optional': a font is used only if it's ready before first paint;
// otherwise the (size-matched) fallback stays for that visit. No late swap, so
// headings and the hero card never resize while someone is looking at them.
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'optional' });
const serif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: 'italic',
  variable: '--font-instrument-serif',
  display: 'optional',
});
const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  display: 'optional',
});

export const metadata: Metadata = {
  title: 'AutoDeploy — deploys that fix themselves',
  description:
    'Connect a repo. AutoDeploy detects, builds, diagnoses, repairs and validates — and shows you every decision.',
};

export const viewport: Viewport = {
  themeColor: '#0a0c0f',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${serif.variable} ${mono.variable}`}>
      <body className="min-h-dvh font-sans text-fg">{children}</body>
    </html>
  );
}
