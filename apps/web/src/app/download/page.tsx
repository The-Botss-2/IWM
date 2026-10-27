import type { Metadata } from 'next';

import { DownloadClient } from './download-client';

export const metadata: Metadata = {
  title: 'Download - The Botss',
  description: 'Download the Botss desktop app for Windows, macOS, and Linux.',
};

// Restricted to signed-in CRM users: DownloadClient queries the session and
// redirects anonymous visitors to /sign-in (the desktop app is internal, so
// only existing users should be able to grab the installer).
export default function DownloadPage() {
  return <DownloadClient />;
}
