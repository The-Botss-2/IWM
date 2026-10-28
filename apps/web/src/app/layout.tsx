import type { Metadata, Viewport } from 'next';
import { Poppins } from 'next/font/google';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';

import { Providers } from '@/components/providers';
import { ThemeMount, ThemePreScript } from '@/components/shell/theme-mount';
import { env } from '@/lib/env';
import '@/styles/globals.css';

// Poppins drives all UI typography. Weights map to the design brief:
// 400 body, 500 nav + table headers + labels, 600 page headings, 700 KPI numbers.
const poppins = Poppins({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-poppins',
  display: 'swap',
});

/**
 * Mobile viewport. `width=device-width, initialScale=1` is the table-stakes
 * pair that stops Android Chrome / iOS Safari from rendering the page at
 * the desktop layout and forcing the user into landscape ("tilt mode") to
 * read it. `viewportFit: cover` lets pages use `safe-area-inset-*` to dodge
 * the iPhone notch / home indicator instead of letterboxing the chrome.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  minimumScale: 1,
  maximumScale: 5,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FDF0F5' },
    { media: '(prefers-color-scheme: dark)', color: '#0F1118' },
  ],
};

export const metadata: Metadata = {
  // Lets Next.js resolve OG / Twitter image paths to absolute URLs without
  // emitting the build-time warning. Pulled from NEXT_PUBLIC_WEB_URL with a
  // localhost fallback.
  metadataBase: new URL(env.webUrl),
  title: 'The Botss - Internal Platform',
  description: 'Internal workspace for The Botss team.',
  applicationName: 'The Botss',
  // icon.svg in this folder is auto-picked up by the App Router and used as
  // the favicon. Listing it here keeps the metadata explicit for browsers
  // that look for the link tag rather than discovering /icon.
  icons: {
    icon: [{ url: '/branding/logo-icon.svg', type: 'image/svg+xml', sizes: 'any' }],
  },
  openGraph: {
    title: 'The Botss - Internal Platform',
    description: 'Internal workspace for The Botss team.',
    siteName: 'The Botss',
    // og-image.png is a TODO - designer-ready 1200×630 asset hasn't been
    // produced yet. Until it lands, fall back to the SVG icon so social
    // unfurls at least render the brand mark instead of a broken image.
    images: [{ url: '/branding/logo-icon.svg', width: 512, height: 512, alt: 'The Botss' }],
  },
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The nonce minted in middleware - stamp it on the inline theme script so it
  // survives the strict CSP. Reading headers() opts the tree into dynamic
  // rendering (the accepted cost of the nonce CSP).
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    // `suppressHydrationWarning` on <html> + <body> silences mismatch warnings
    // caused by browser extensions (Grammarly, ColorZilla, dark-mode toggles)
    // that inject attributes onto these tags before React hydrates. It does NOT
    // suppress real hydration checks deeper in the tree.
    <html lang="en" className={poppins.variable} suppressHydrationWarning>
      <head>
        {/* Applies the saved theme + body-mode synchronously, before React
         * hydrates, so a user on the dark theme doesn't see a light flash
         * on every reload. Pairs with the `<ThemeMount />` client component
         * below which keeps the values in sync at runtime. */}
        <ThemePreScript nonce={nonce} />
      </head>
      <body suppressHydrationWarning>
        <Providers>
          {/* Mounted once at the root so theme + gradient bg apply on every
           * route - auth pages, app shell, public reader, dev tools. */}
          <ThemeMount />
          {children}
        </Providers>
      </body>
    </html>
  );
}
