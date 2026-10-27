import { isSupportRequest } from '../common/request-context';
import { isSupportBlockedAction, supportReadOnly } from './support-rules';

/**
 * Backstop for read only support sessions, run by the Prisma middleware on
 * the base client before every operation (see `AuthContextCache`). The base
 * client's middleware also runs for the soft-delete extended client, for
 * interactive transactions and for raw statements, so no service can write
 * while the request is a support session, even a GET handler with a side
 * effect. The support access row is written before the request is marked,
 * so it is the one write a support request makes.
 */
export function assertSupportWriteAllowed(action: string | undefined): void {
  if (isSupportRequest() && isSupportBlockedAction(action)) throw supportReadOnly();
}
