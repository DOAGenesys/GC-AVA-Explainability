import type { Metadata } from 'next';
import { Roboto } from 'next/font/google';
import './globals.css';

/**
 * Roboto is the Genesys brand typeface. Loaded through next/font so it is self-hosted at build
 * time: no third-party request on first paint, and the CSP does not need to allow an external
 * style or font origin.
 */
const roboto = Roboto({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-roboto',
});

export const metadata: Metadata = {
  title: 'AVA Observability | Genesys Cloud',
  description:
    'Explainability and observability for Genesys Cloud Agentic Virtual Agents: session outcomes, turn transcripts, and full execution traces with tool-level detail.',
  robots: { index: false, follow: false },
  // Served from /images/ so the middleware session gate does not intercept it.
  icons: { icon: [{ url: '/images/brand/genesys-logomark.svg', type: 'image/svg+xml' }] },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={roboto.variable}>
      <body>{children}</body>
    </html>
  );
}
