import { AsyncLocalStorage } from 'node:async_hooks';

import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { EffectivePermissions } from '@botss/auth';
import type { SystemRole } from '@botss/shared-types';
import type { NextFunction, Request, Response } from 'express';

/**
 * What AuthGuard already resolved for the signed-in STAFF user of this
 * request. Services that only receive a user id (permission helpers, scope
 * resolvers) read it instead of re-querying the same rows - but ONLY when the
 * id they were handed is this request's user. Anything else (another user,
 * a socket handler, a queue job, a client-portal account) falls back to the
 * database exactly as before.
 */
export interface RequestAuthSnapshot {
  userId: string;
  systemRole: SystemRole;
  organizationId: string | null;
  permissions: EffectivePermissions;
}

/**
 * Set only while the request runs in a read only support session (AuthGuard's
 * support branch, right after the access row is written). `userId` is the
 * platform operator, `workspaceIds` the granted organization's workspaces.
 */
export interface RequestSupportScope {
  userId: string;
  workspaceIds: readonly string[];
}

interface RequestStore {
  auth?: RequestAuthSnapshot;
  support?: RequestSupportScope;
}

const storage = new AsyncLocalStorage<RequestStore>();

/** Opens a per-request store; AuthGuard fills it. */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(_req: Request, _res: Response, next: NextFunction): void {
    storage.run({}, next);
  }
}

/**
 * Called by AuthGuard once the staff user's context is resolved. The support
 * branch passes `support`, which marks the whole request as a read only
 * support session (see `isSupportRequest`).
 */
export function setRequestAuth(
  snapshot: RequestAuthSnapshot,
  opts: { support?: RequestSupportScope } = {},
): void {
  const store = storage.getStore();
  if (!store) return;
  store.auth = snapshot;
  if (opts.support) store.support = opts.support;
}

/**
 * Mark this request as a read only support session. Called by AuthGuard as
 * soon as the support access row is written, so the write backstop (see
 * `support-write-backstop.ts`) refuses every later database write of the
 * request, refused requests included.
 */
export function markSupportRequest(scope: RequestSupportScope): void {
  const store = storage.getStore();
  if (store) store.support = scope;
}

/** True while the current request runs in a read only support session. */
export function isSupportRequest(): boolean {
  return storage.getStore()?.support !== undefined;
}

/** The support session scope of this request, if `userId` is its operator. */
export function supportScopeFor(userId: string): RequestSupportScope | null {
  const support = storage.getStore()?.support;
  return support && support.userId === userId ? support : null;
}

/**
 * Run `fn` outside any request store, so it is not treated as part of the
 * request (no snapshot, no support flag). Only the support access log uses
 * this, to mark its own row refused after the response; never use it to get
 * around the support write backstop.
 */
export function outsideRequestContext<T>(fn: () => T): T {
  return storage.exit(fn);
}

/**
 * Drop the snapshot. Called when this request writes something the snapshot
 * was derived from (a role, membership, override...), so a later check in the
 * same request reads the database again instead of the pre-write state.
 */
export function clearRequestAuth(): void {
  const store = storage.getStore();
  // A support session's snapshot is synthetic (the granted org, read only
  // permissions) and can't go stale from a write: every write is refused.
  // Dropping it would send id-only helpers back to the database, which
  // describes the operator's own root organization.
  if (store && !store.support) delete store.auth;
}

/** This request's resolved auth, if it belongs to `userId`. */
export function requestAuthFor(userId: string): RequestAuthSnapshot | null {
  const auth = storage.getStore()?.auth;
  return auth && auth.userId === userId ? auth : null;
}

/** The signed-in staff user's resolved auth for this request, if any. */
export function currentRequestAuth(): RequestAuthSnapshot | null {
  return storage.getStore()?.auth ?? null;
}
