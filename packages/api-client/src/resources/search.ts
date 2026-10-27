import {
  searchResponseSchema,
  type SearchResponse,
  type SearchResultKind,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

/** Query-string shape for `GET /search`. Dates travel as ISO strings. */
export interface SearchParams {
  /** Free text; may be empty when a filter (`fromUserId`, `roomId`, `has`, a date) is set. */
  q: string;
  kinds?: SearchResultKind[];
  limit?: number;
  /** Page mode: search one kind and page through it with `cursor`. */
  kind?: SearchResultKind;
  cursor?: string;
  fromUserId?: string;
  roomId?: string;
  after?: string;
  before?: string;
  /** `file`: messages / mail with an attachment. `link`: messages with a URL. */
  has?: 'file' | 'link';
  /** `relevance` (server default) or `recent`. */
  sort?: 'relevance' | 'recent';
  counts?: boolean;
}

export class SearchResource {
  constructor(private readonly http: HttpClient) {}

  query(input: SearchParams): Promise<SearchResponse> {
    return this.http.get('/search', searchResponseSchema, { ...input });
  }
}
