import type { z } from 'zod';
import { problemDetailsSchema } from '@botss/shared-types';

import { ApiError, fromProblem } from './errors.js';

export interface ClientOptions {
  /** API base URL (e.g. http://localhost:4000). */
  baseUrl: string;
  /** Path prefix that the API mounts non-auth routes under. */
  basePath?: string;
  /** Optional fetch implementation (defaults to global fetch). Useful for Node tests. */
  fetch?: typeof fetch;
  /** Hook for the consumer to attach auth headers (e.g. workspace id). */
  getDefaultHeaders?: () => Record<string, string>;
  /** Whether to send credentials (cookies). Defaults to 'include'. */
  credentials?: RequestCredentials;
}

/**
 * Best-effort filename from a `Content-Disposition` response header.
 *
 * Returns null when the header is absent - which is the common case in the
 * browser, since `Content-Disposition` isn't CORS-safelisted and is only
 * readable if the API lists it in `Access-Control-Expose-Headers`. Callers
 * should always have a local fallback name.
 */
function filenameFromDisposition(res: Response): string | null {
  const header = res.headers.get('content-disposition');
  if (!header) return null;
  // RFC 5987 `filename*=UTF-8''...` wins over the plain `filename="..."` form.
  const extended = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header);
  const plain = /filename="?([^";]+)"?/i.exec(header);
  const raw = (extended?.[1] ?? plain?.[1])?.trim();
  if (!raw) return null;
  try {
    // The mail attachment endpoint percent-encodes the name inside the quoted
    // form, so decode; a name with a literal `%` that isn't valid escaping
    // would throw, in which case the raw value is the better answer.
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export class HttpClient {
  private readonly baseUrl: string;
  private readonly basePath: string;
  private readonly fetchFn: typeof fetch;
  private readonly getDefaultHeaders: () => Record<string, string>;
  private readonly credentials: RequestCredentials;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.basePath = (opts.basePath ?? '/api/v1').replace(/\/?$/, '');
    this.fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.getDefaultHeaders = opts.getDefaultHeaders ?? (() => ({}));
    this.credentials = opts.credentials ?? 'include';
  }

  /**
   * Absolute URL for an API path (base URL + base path + query). For
   * transports `fetch` can't model, e.g. `EventSource` streams.
   */
  absoluteUrl(path: string, query?: Record<string, unknown>): string {
    return this.url(path, query);
  }

  private url(path: string, query?: Record<string, unknown>): string {
    const cleaned = path.startsWith('/') ? path : `/${path}`;
    const usp = new URLSearchParams();
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) v.forEach((item) => usp.append(k, queryValue(item)));
        else usp.append(k, queryValue(v));
      }
    }
    const qs = usp.toString();
    return `${this.baseUrl}${this.basePath}${cleaned}${qs ? `?${qs}` : ''}`;
  }

  private async request<T>(
    method: string,
    path: string,
    schema: z.ZodSchema<T>,
    init: { body?: unknown; query?: Record<string, unknown>; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...this.getDefaultHeaders(),
      ...(init.headers ?? {}),
    };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';

    let res: Response;
    try {
      res = await this.fetchFn(this.url(path, init.query), {
        method,
        headers,
        credentials: this.credentials,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch {
      // Transport-level failure: fetch rejects when the server is unreachable
      // (offline, DNS failure, connection refused, CORS, request aborted).
      // Normalize to an ApiError with a clear, user-facing message so the UI
      // never shows a raw "Failed to fetch" / "command failed" string.
      throw new ApiError(0, {
        type: 'about:blank',
        title: 'Network error',
        status: 0,
        detail:
          "Couldn't reach the server. Check your internet connection and try again.",
      });
    }

    const contentType = res.headers.get('content-type') ?? '';
    const isJson = contentType.includes('json');
    // Guard against a malformed body that claims to be JSON - never let a
    // JSON.parse blow up replace the real HTTP status with a cryptic error.
    let raw: unknown = null;
    if (isJson) {
      try {
        raw = await res.json();
      } catch {
        raw = null;
      }
    }

    if (!res.ok) {
      const problem = problemDetailsSchema.safeParse(raw);
      throw fromProblem(
        res.status,
        problem.success
          ? problem.data
          : {
              type: 'about:blank',
              title: res.statusText || 'Request failed',
              status: res.status,
            },
      );
    }

    return schema.parse(raw);
  }

  get<T>(
    path: string,
    schema: z.ZodSchema<T>,
    query?: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<T> {
    return this.request<T>('GET', path, schema, { query, headers });
  }
  /**
   * GET an endpoint that returns raw bytes rather than JSON.
   *
   * Binary endpoints can't go through `request()` (it assumes a JSON body and
   * a Zod schema), but they still need the same credentialed-fetch treatment:
   * cookies, workspace header, and RFC 7807 error normalization.
   *
   * Callers must NOT reach these endpoints by pointing an `<a href>` or
   * `<img src>` at them. A plain navigation to the API origin is cross-origin
   * from the web app, which means the browser drops the `download` attribute,
   * and inside the Electron shell `will-navigate` hands the URL to the OS
   * browser - a different cookie jar, so the request arrives unauthenticated
   * and 401s. Fetching here keeps the request on the app's own credentialed
   * transport in every client (web, desktop, mobile webview).
   */
  async getBlob(
    path: string,
    query?: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<{ blob: Blob; filename: string | null }> {
    let res: Response;
    try {
      res = await this.fetchFn(this.url(path, query), {
        method: 'GET',
        headers: { ...this.getDefaultHeaders(), ...(headers ?? {}) },
        credentials: this.credentials,
      });
    } catch {
      throw new ApiError(0, {
        type: 'about:blank',
        title: 'Network error',
        status: 0,
        detail:
          "Couldn't reach the server. Check your internet connection and try again.",
      });
    }

    if (!res.ok) {
      // Errors still come back as JSON problem details even though the happy
      // path is binary, so parse the body the same way `request()` does.
      let raw: unknown = null;
      try {
        raw = await res.json();
      } catch {
        raw = null;
      }
      const problem = problemDetailsSchema.safeParse(raw);
      throw fromProblem(
        res.status,
        problem.success
          ? problem.data
          : {
              type: 'about:blank',
              title: res.statusText || 'Request failed',
              status: res.status,
            },
      );
    }

    return { blob: await res.blob(), filename: filenameFromDisposition(res) };
  }
  /**
   * POST JSON and read a text response (the invoice preview returns an HTML
   * document). Same credentials, workspace header and error normalization as
   * every other call.
   */
  async postText(path: string, body: unknown): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchFn(this.url(path), {
        method: 'POST',
        headers: {
          Accept: 'text/html, application/json',
          'Content-Type': 'application/json',
          ...this.getDefaultHeaders(),
        },
        credentials: this.credentials,
        body: JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, {
        type: 'about:blank',
        title: 'Network error',
        status: 0,
        detail:
          "Couldn't reach the server. Check your internet connection and try again.",
      });
    }
    if (!res.ok) {
      let raw: unknown = null;
      try {
        raw = await res.json();
      } catch {
        raw = null;
      }
      const problem = problemDetailsSchema.safeParse(raw);
      throw fromProblem(
        res.status,
        problem.success
          ? problem.data
          : { type: 'about:blank', title: res.statusText || 'Request failed', status: res.status },
      );
    }
    return res.text();
  }
  /**
   * PUT raw bytes to a presigned object-storage URL (S3 / MinIO / R2).
   *
   * This is not an API call: the URL is absolute, and neither the API base
   * path nor the default (workspace) headers apply - only the headers the
   * presign response said to echo. Transport rejections, including an
   * `AbortSignal` abort, propagate unchanged so callers can tell a user
   * cancel (`AbortError`) apart from a real failure.
   */
  async putPresigned(
    url: string,
    body: Blob,
    opts: { headers?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<void> {
    const res = await this.fetchFn(url, {
      method: 'PUT',
      headers: opts.headers,
      body,
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(`Upload failed (${res.status}).`);
  }
  /**
   * GET an absolute URL (a public object-storage link) as a Blob. Like
   * `putPresigned`, not an API call: no base path, no default headers.
   * Non-2xx responses throw.
   */
  async getAbsoluteBlob(url: string): Promise<Blob> {
    const res = await this.fetchFn(url);
    if (!res.ok) throw new Error(`Download failed (${res.status}).`);
    return res.blob();
  }
  post<T>(
    path: string,
    schema: z.ZodSchema<T>,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    return this.request<T>('POST', path, schema, { body, headers });
  }
  patch<T>(path: string, schema: z.ZodSchema<T>, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, schema, { body });
  }
  put<T>(path: string, schema: z.ZodSchema<T>, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, schema, { body });
  }
  delete<T>(path: string, schema: z.ZodSchema<T>, body?: unknown): Promise<T> {
    return this.request<T>('DELETE', path, schema, { body });
  }
}

/**
 * One query-string value. Dates go out as ISO-8601 UTC: `String(date)` would
 * send a locale string that drops milliseconds, so an end-of-day bound
 * (23:59:59.999) would silently lose its last second.
 */
function queryValue(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}
