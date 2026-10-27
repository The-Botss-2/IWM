import type { Response } from 'express';

/** Write PDF bytes with a safe Content-Disposition and no caching. */
export function sendPdf(
  res: Response,
  file: { body: Buffer; filename: string },
  disposition: 'inline' | 'attachment',
): void {
  const ascii = file.filename.replace(/[^ -~]/g, '_').replace(/"/g, '_');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Length', String(file.body.byteLength));
  res.setHeader(
    'Content-Disposition',
    `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
  );
  // A signing link grants access to the file; nothing downstream should keep a copy.
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(file.body);
}
