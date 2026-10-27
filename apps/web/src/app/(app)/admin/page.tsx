'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Admin tools were merged into the unified Settings shell, so there's no longer
 * a separate overview. Land on the first admin section (Users). Only privileged
 * users reach this - the admin layout bounces everyone else before this mounts,
 * so the redirect can't expose an admin page to a non-admin.
 */
export default function AdminIndexPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/settings/users');
  }, [router]);
  return (
    <div className="text-sm text-ink-muted">Opening admin tools…</div>
  );
}
