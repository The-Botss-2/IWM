import { SetMetadata } from '@nestjs/common';

export const SUPPORT_TOKEN_QUERY_KEY = 'supportTokenQuery';

/** Query parameter that carries the support token on a marked route. */
export const SUPPORT_TOKEN_QUERY_PARAM = 'st';

/**
 * Lets this route take the support token from `?st=` when the header is
 * absent. Only for routes a browser loads without script (an `<img>` or a
 * download link to `GET /files/:id/content`), which can't send headers. The
 * token is still bound to the operator and their sign-in cookie, and the
 * query string is never logged.
 */
export const SupportTokenInQuery = (): MethodDecorator =>
  SetMetadata(SUPPORT_TOKEN_QUERY_KEY, true);
