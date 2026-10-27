import {
  mySessionsResponseSchema,
  sessionContextSchema,
  sessionsRevokedResponseSchema,
  type UserPreferences,
  userPreferencesResponseSchema,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

export class UsersResource {
  constructor(private readonly http: HttpClient) {}

  /** The caller's own appearance + navigation preferences (synced across devices). */
  preferences() {
    return this.http.get('/users/me/preferences', userPreferencesResponseSchema);
  }
  /** Partial update: sections merge key-by-key on the server, arrays replace. */
  updatePreferences(input: UserPreferences) {
    return this.http.patch('/users/me/preferences', userPreferencesResponseSchema, input);
  }
  /** The caller's own signed-in devices (sessions). */
  mySessions() {
    return this.http.get('/users/me/sessions', mySessionsResponseSchema);
  }
  /** Sign one of the caller's own devices out. 404 when it is not theirs. */
  revokeMySession(id: string) {
    return this.http.delete(`/users/me/sessions/${id}`, sessionsRevokedResponseSchema);
  }
  /** Sign out every device except the one making this request. */
  revokeOtherSessions() {
    return this.http.post('/users/me/sessions/revoke-others', sessionsRevokedResponseSchema, {});
  }
  /** Returns the full session context (user + memberships) used to build the CASL ability. */
  session() {
    return this.http.get('/auth/me', sessionContextSchema);
  }
}
