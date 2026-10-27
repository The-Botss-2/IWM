import {
  type LivekitTokenRequest,
  type LivekitTokenResponse,
  livekitTokenResponseSchema,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

/**
 * LiveKit access-token retrieval. The frontend uses this once per call /
 * channel join - the returned `token` is fed straight to
 * `livekit-client.Room.connect(url, token)`.
 */
export class LivekitResource {
  constructor(private readonly http: HttpClient) {}

  token(input: LivekitTokenRequest): Promise<LivekitTokenResponse> {
    return this.http.post('/livekit/token', livekitTokenResponseSchema, input);
  }
}
