import { createClient, type BotssApiClient } from '@botss/api-client';
import { SUPPORT_TOKEN_HEADER } from '@botss/shared-types';

import { env } from './env';
import { readSupportWorkspace, supportTokenHeader } from './support-session';
import { CURRENT_WORKSPACE_COOKIE, readWorkspaceCookie } from './workspace-cookie';

let cached: BotssApiClient | null = null;

export function getApi(): BotssApiClient {
  if (!cached) {
    cached = createClient({
      baseUrl: env.apiUrl,
      basePath: env.apiBasePath,
      credentials: 'include',
      // Every request includes the user's selected workspace id (if any) so the
      // API's AuthGuard resolves session context against that workspace rather
      // than picking the first membership in the list. The header lives on each
      // request - no global state - so a stale cached client never serves a
      // request scoped to an old workspace.
      getDefaultHeaders: () => {
        const headers: Record<string, string> = {};
        // A platform operator's read only support session in this tab: its
        // workspace comes from this tab's storage, never the shared cookie.
        const support = supportTokenHeader();
        const ws = support ? readSupportWorkspace() : readWorkspaceCookie();
        if (ws) headers['x-workspace-id'] = ws;
        if (support) headers[SUPPORT_TOKEN_HEADER] = support;
        return headers;
      },
    });
  }
  return cached;
}

export { CURRENT_WORKSPACE_COOKIE };
