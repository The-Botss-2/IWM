'use client';

import { useEffect } from 'react';

import { reportClientError } from '@/lib/report-client-error';

/**
 * Ultimate fallback: catches errors thrown in the root layout itself (where a
 * normal `error.tsx` can't reach). Because the failure may be in the layout,
 * providers, fonts, or globals.css, this file must render its own <html>/<body>
 * and use only inline styles - it cannot assume the design system loaded.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportClientError(error, { boundary: 'global', digest: error.digest });
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
          background: '#FDF0F5',
          color: '#1a1a2e',
        }}
      >
        <div style={{ textAlign: 'center', padding: '24px', maxWidth: 440 }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Something went wrong</h1>
          <p style={{ marginTop: 8, fontSize: 14, opacity: 0.7 }}>
            The application hit an unexpected error. Please try reloading.
          </p>
          {error.digest ? (
            <p style={{ marginTop: 8, fontSize: 12, opacity: 0.5 }}>Reference: {error.digest}</p>
          ) : null}
          <button
            type="button"
            onClick={() => reset()}
            style={{
              marginTop: 24,
              padding: '10px 20px',
              borderRadius: 9999,
              border: 'none',
              cursor: 'pointer',
              fontSize: 14,
              fontWeight: 500,
              color: '#fff',
              background: 'linear-gradient(135deg, #7C3AED, #DB2777)',
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
