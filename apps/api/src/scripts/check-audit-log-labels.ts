/**
 * Audit-log label self-checks (no database): targets and metadata ids resolve
 * to names, names from another organization never resolve, and strings that
 * merely look like words (roles, emails, slugs) are not treated as ids.
 *
 * Run: pnpm --filter @botss/api test
 */
import assert from 'node:assert/strict';

import { looksLikeAuditId } from '@botss/shared-types';

import {
  collectLookupIds,
  collectMetadataIds,
  labelRow,
  parseTarget,
  type AuditLabelKind,
  type LabelLookups,
  type LabelRecord,
} from '../audit-log/audit-log-labels';
import { ROOT_ORG_ID } from '../organizations/organizations.constants';

const ORG_A = 'cmorga000000000000000000a';
const ORG_B = 'cmorgb000000000000000000b';
const SARA = 'cmuser00000000000000sara1';
const OUTSIDER = 'cmuser0000000000outsider1';
const CLIENT = 'cmclient0000000000000acme';
const CONTACT = 'cmcontact00000000000000c1';
const WORKSPACE = 'cmws0000000000000000000w1';
const ROLE_FROM = 'cmrole000000000000000from';
const ROLE_TO = 'cmrole00000000000000000to';
const GONE = 'cmgone0000000000000000000';

function lookups(entries: Partial<Record<AuditLabelKind, Record<string, LabelRecord>>>): LabelLookups {
  const map = (kind: AuditLabelKind) => new Map(Object.entries(entries[kind] ?? {}));
  return {
    user: map('user'),
    contact: map('contact'),
    client: map('client'),
    project: map('project'),
    document: map('document'),
    workspace: map('workspace'),
    role: map('role'),
    organization: map('organization'),
  };
}

const L = lookups({
  user: {
    [SARA]: { name: 'Sara Khan', orgIds: [ORG_A] },
    [OUTSIDER]: { name: 'Other Tenant Person', orgIds: [ORG_B] },
  },
  client: { [CLIENT]: { name: 'Acme Ltd', orgIds: [ORG_A] } },
  contact: { [CONTACT]: { name: 'Ali (Acme)', orgIds: [ORG_A] } },
  workspace: { [WORKSPACE]: { name: 'Delivery', orgIds: [ORG_A] } },
  role: {
    [ROLE_FROM]: { name: 'Sales', orgIds: [ORG_A] },
    [ROLE_TO]: { name: 'Finance', orgIds: [ORG_A] },
  },
  organization: {
    [ORG_A]: { name: 'Org A', orgIds: [ORG_A] },
    [ROOT_ORG_ID]: { name: 'The Botss', orgIds: [ROOT_ORG_ID] },
  },
});

function main(): void {
  // --- id detection ---------------------------------------------------------
  assert.ok(looksLikeAuditId(SARA));
  // The shared helper hard-codes the root id; keep it in step with the API.
  assert.ok(looksLikeAuditId(ROOT_ORG_ID));
  for (const word of ['ADMIN', 'MEMBER', 'sara@acme.com', 'acme', 'users.manage', 'Sales team', '']) {
    assert.equal(looksLikeAuditId(word), false, `"${word}" is not an id`);
  }

  // --- target parsing -------------------------------------------------------
  assert.deepEqual(parseTarget(`client:${CLIENT}`), { type: 'client', id: CLIENT });
  assert.equal(parseTarget(null), null);
  assert.equal(parseTarget('no-separator'), null);
  assert.equal(parseTarget(':x'), null);
  assert.equal(parseTarget('user:'), null);

  // --- metadata walk: nested objects and arrays, non-ids skipped ------------
  assert.deepEqual(
    [...collectMetadataIds({
      workspaceId: WORKSPACE,
      from: { role: 'MEMBER', customRoleId: ROLE_FROM },
      to: { role: 'ADMIN', customRoleId: null },
      list: [CONTACT, 'ADMIN'],
      email: 'sara@acme.com',
    })].sort(),
    [CONTACT, ROLE_FROM, WORKSPACE].sort(),
  );

  const collected = collectLookupIds([
    { target: `client:${CLIENT}`, metadata: { contactId: CONTACT } },
    { target: 'unknownkind:abc', metadata: {} },
  ]);
  assert.deepEqual([...collected.byKind.client], [CLIENT]);
  assert.deepEqual([...collected.untyped], [CONTACT]);
  assert.equal(collected.byKind.user.size, 0);

  // --- client portal invite: target + contact resolve -----------------------
  const invite = labelRow(
    { organizationId: ORG_A, target: `client:${CLIENT}`, metadata: { contactId: CONTACT, email: 'ali@acme.com' } },
    L,
  );
  assert.deepEqual(invite.targetLabel, { type: 'client', name: 'Acme Ltd' });
  assert.deepEqual(invite.labels, { [CLIENT]: 'Acme Ltd', [CONTACT]: 'Ali (Acme)' });

  // --- company role change: bare from/to role ids resolve -------------------
  const roleChange = labelRow(
    { organizationId: ORG_A, target: `user:${SARA}`, metadata: { from: ROLE_FROM, to: ROLE_TO } },
    L,
  );
  assert.deepEqual(roleChange.targetLabel, { type: 'user', name: 'Sara Khan' });
  assert.equal(roleChange.labels[ROLE_FROM], 'Sales');
  assert.equal(roleChange.labels[ROLE_TO], 'Finance');

  // --- tenant wall: another org's records never resolve ---------------------
  const foreign = labelRow(
    { organizationId: ORG_A, target: `user:${OUTSIDER}`, metadata: { userId: OUTSIDER } },
    L,
  );
  assert.deepEqual(foreign.targetLabel, { type: 'user', name: null });
  assert.deepEqual(foreign.labels, {});
  const fromOtherOrg = labelRow({ organizationId: ORG_B, target: `client:${CLIENT}`, metadata: {} }, L);
  assert.deepEqual(fromOtherOrg.targetLabel, { type: 'client', name: null });

  // --- deleted / unknown records and kinds ----------------------------------
  const purged = labelRow(
    { organizationId: ROOT_ORG_ID, target: `organization:${GONE}`, metadata: { purgedOrgId: GONE } },
    L,
  );
  assert.deepEqual(purged.targetLabel, { type: 'organization', name: null });
  assert.deepEqual(purged.labels, {});
  assert.deepEqual(labelRow({ organizationId: ORG_A, target: 'invoice:x1', metadata: {} }, L).targetLabel, {
    type: 'invoice',
    name: null,
  });
  assert.deepEqual(labelRow({ organizationId: ORG_A, target: null, metadata: {} }, L), {
    targetLabel: null,
    labels: {},
  });

  console.log('check-audit-log-labels: OK');
}

main();
