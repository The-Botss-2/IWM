'use client';

import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { type ReactNode, useState } from 'react';

import { AppToaster } from '@/components/shell/app-toaster';
import { GlobalProgress } from '@/components/shell/global-progress';
import { SidebarProvider } from '@/hooks/use-sidebar';
import { getQueryClient } from '@/lib/query-client';
import { PromptHost } from '@/lib/prompt';

export function Providers({ children }: { children: ReactNode }) {
  // useState ensures a single QueryClient instance per browser session.
  const [queryClient] = useState(() => getQueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <SidebarProvider>{children}</SidebarProvider>
      <GlobalProgress />
      <PromptHost />
      <AppToaster />
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  );
}
