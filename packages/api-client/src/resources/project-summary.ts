import { projectSummarySchema } from '@botss/shared-types';

import type { HttpClient } from '../client.js';

export class ProjectSummaryResource {
  constructor(private readonly http: HttpClient) {}

  get(projectId: string) {
    return this.http.get(`/projects/${projectId}/summary`, projectSummarySchema);
  }
}
