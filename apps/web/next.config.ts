import type { NextConfig } from 'next';

// Static security headers applied to every response. The Content-Security-Policy
// is NOT set here - it's minted per-request with a fresh nonce in
// `src/middleware.ts` (strict nonce-based script-src). These are the headers
// that don't need a per-request value.
const SECURITY_HEADERS = [
  // Clickjacking: legacy header alongside the CSP `frame-ancestors 'none'`
  // that middleware sets, for older browsers.
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
];

const config: NextConfig = {
  reactStrictMode: true,
  // Don't advertise the framework/version in an X-Powered-By header.
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
  // Workspace packages publish dual-resolution: `main` → dist/index.js (CJS, used
  // by NestJS), `module` / `import` condition → src/index.ts (TS source, used by
  // bundlers). `transpilePackages` tells Next's SWC pipeline to compile that TS
  // source so React Refresh works correctly in dev.
  transpilePackages: ['@botss/api-client', '@botss/auth', '@botss/shared-types'],
  // The TS source uses NodeNext-style `import { x } from './foo.js'` paths.
  // Webpack needs to know that `.js` import specifiers should resolve to `.ts`
  // files when running through Next's transpilation pipeline.
  webpack(config) {
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.js', '.ts', '.tsx'],
      '.mjs': ['.mjs', '.mts'],
    };
    return config;
  },
};

export default config;
