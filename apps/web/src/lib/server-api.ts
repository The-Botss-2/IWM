import { createClient, type BotssApiClient } from '@botss/api-client';

import { env } from './env';

/**
 * API client for React Server Components / route handlers hitting the
 * API's anonymous (public) endpoints - the shared-document reader, public
 * forms, etc.
 *
 * Unlike `getApi()` it carries no browser cookies or workspace header, and
 * every request opts out of Next's fetch cache: public links must always
 * reflect the latest saved content (or an already-revoked link).
 */
export function createPublicServerApi(): BotssApiClient {
  return createClient({
    baseUrl: env.apiUrl,
    basePath: env.apiBasePath,
    credentials: 'omit',
    fetch: (input, init) => fetch(input, { ...init, cache: 'no-store' }),
  });
}
