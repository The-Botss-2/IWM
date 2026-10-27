'use client';

import { createContextualCan } from '@casl/react';
import { createContext, useContext } from 'react';
import {
  defineAbilityFor,
  defineSupportAbility,
  type AppAbility,
  type AppSubject,
  type AbilityContext as Ctx,
} from '@botss/auth/ability';

/**
 * Default ability denies everything (no memberships → empty rules). Real abilities
 * are pushed from <SessionGate /> once we resolve the session.
 */
const emptyAbility: AppAbility = defineAbilityFor({
  userId: '',
  workspaceMemberships: [],
  projectMemberships: [],
});

const AbilityContext = createContext<AppAbility>(emptyAbility);

/**
 * The UX-hint ability. A read only support session gets the same read only
 * ability the API enforces, so write controls gated by `<Can>` disappear.
 */
export function buildAbility(ctx: Ctx, opts: { support?: boolean } = {}): AppAbility {
  return opts.support ? defineSupportAbility() : defineAbilityFor(ctx);
}

export const AbilityProvider = AbilityContext.Provider;

export function useAbility(): AppAbility {
  return useContext(AbilityContext);
}

export const Can = createContextualCan(AbilityContext.Consumer);

/**
 * A loaded row tagged for CASL, so conditional rules (`update Task
 * { projectId }`, `delete Task { createdById }`) are checked against it, the
 * same way the API's services re-check a row. Still a UX hint only.
 *
 *   ability.can('update', abilityRow('Task', task))
 */
export function abilityRow<T extends object>(type: AppSubject, row: T): AppSubject {
  // The factory's detectSubjectType reads `__type`; CASL's typed can() only
  // names subjects, hence the cast.
  return { ...row, __type: type } as unknown as AppSubject;
}
