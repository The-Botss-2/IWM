'use client';

import { getApi } from './api';
import { FileTooLargeForNativeError, saveFile } from './save-file';
import { toastError, toastErrorMessage } from './toast';

export interface DownloadUrlOptions {
  /** Re-type the saved blob (e.g. force `application/pdf`). */
  mimeType?: string;
  /**
   * What to do when the bytes can't be fetched or saved:
   *  - `open-tab` (default): open the URL in a new tab instead. Useful when
   *    a CORS-restricted storage origin blocks the fetch.
   *  - `{ toast }`: show an error toast with this fallback message.
   */
  onError?: 'open-tab' | { toast: string };
}

/**
 * Save the file behind a stored-object URL to the device.
 *
 * Fetching the bytes and handing them to `saveFile` (rather than navigating
 * to the URL) is what makes downloads work inside the mobile WebView and the
 * desktop shell, where a plain link would be swallowed or opened in the wrong
 * cookie jar.
 */
export async function downloadUrl(
  url: string,
  filename: string,
  { mimeType, onError = 'open-tab' }: DownloadUrlOptions = {},
): Promise<void> {
  try {
    const blob = await getApi().files.fetchBytes(url);
    await saveFile(mimeType ? new Blob([blob], { type: mimeType }) : blob, filename || 'download');
  } catch (err) {
    if (onError !== 'open-tab') {
      toastError(err, onError.toast);
      return;
    }
    if (err instanceof FileTooLargeForNativeError) {
      toastErrorMessage('That file is too large to save on this device');
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

/** Save a rendered invoice PDF (stored in object storage) to the device. */
export function downloadInvoicePdf(url: string, filename: string): Promise<void> {
  return downloadUrl(url, filename, {
    mimeType: 'application/pdf',
    onError: { toast: "Couldn't download the PDF" },
  });
}
