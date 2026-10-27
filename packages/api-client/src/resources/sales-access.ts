import { type SalesAccess, salesAccessSchema } from '@botss/shared-types';

import type { HttpClient } from '../client.js';

/**
 * Whether the Leads / Clients surfaces apply to the signed-in user in their
 * active workspace. Answered server-side because it depends on record
 * assignments the client can't see.
 */
export class SalesAccessResource {
  constructor(private readonly http: HttpClient) {}

  get(): Promise<SalesAccess> {
    return this.http.get('/sales-access', salesAccessSchema);
  }
}
