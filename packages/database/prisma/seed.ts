import { randomBytes, scryptSync } from 'node:crypto';

import { Prisma } from '@prisma/client';

import { prisma } from '../src/index.js';

/**
 * Demo seed for local development.
 *
 * Creates the root (platform) organization the API expects, one demo
 * organization, one demo admin, one workspace and one sample project with a
 * few tasks. Idempotent: every row is upserted on a stable id
 * or unique key, so running it twice changes nothing.
 *
 * Demo sign-in (development only, change or delete before any real use):
 *   email:    admin@example.com
 *   password: demo-admin-password
 *
 * Refuses to run against production: it needs NODE_ENV != production AND
 * ALLOW_SEED=true (`pnpm db:seed:dev` sets both).
 */
const DEMO_ADMIN_EMAIL = 'admin@example.com';
const DEMO_ADMIN_PASSWORD = 'demo-admin-password';
/** Must match ROOT_ORG_ID in apps/api/src/organizations/organizations.constants.ts. */
const ROOT_ORG_ID = 'org_root_thebotss';

function assertSafeEnvironment(): void {
  if (process.env.NODE_ENV === 'production' || process.env.ALLOW_SEED !== 'true') {
    console.error('[seed] Refusing to run. Set NODE_ENV=development and ALLOW_SEED=true to seed.');
    process.exit(1);
  }
}

/**
 * Same format as `hashPassword` in packages/auth (`scrypt$<saltHex>$<hashHex>`,
 * N=16384, r=8, p=1, keylen=64), so Better Auth's sign-in verifies it. Inlined
 * because packages/database must not depend on packages/auth.
 */
function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/** Build a minimal Tiptap doc with a heading + paragraph. */
function tiptapDoc(heading: string, paragraph: string): Prisma.InputJsonValue {
  return {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: heading }] },
      { type: 'paragraph', content: [{ type: 'text', text: paragraph }] },
    ],
  };
}

/**
 * Deterministic seed ids (`seed_<entity>_<slug>`) let us upsert without
 * depending on composite unique keys. Runtime rows use cuids.
 */
const ids = {
  organization: 'seed_org_demo',
  project: 'seed_project_demo',
  task: (position: number) => `seed_task_demo_${position}`,
  document: 'seed_document_welcome',
};

async function main(): Promise<void> {
  assertSafeEnvironment();

  console.log('Seeding demo data (idempotent - no deletes)...');

  // ── Root (platform) organization ──────────────────────────────────────────
  // The API refers to this row by id (ROOT_ORG_ID in
  // apps/api/src/organizations/organizations.constants.ts); platform admins
  // (SUPER_ADMIN) live here. It holds no tenant data.
  await prisma.organization.upsert({
    where: { id: ROOT_ORG_ID },
    update: {},
    create: {
      id: ROOT_ORG_ID,
      name: 'Platform',
      slug: 'platform',
      emailDomain: null,
      isRoot: true,
    },
  });

  // ── Demo organization ─────────────────────────────────────────────────────
  const organization = await prisma.organization.upsert({
    where: { id: ids.organization },
    update: { name: 'Demo Organization', isActive: true, deletedAt: null },
    create: {
      id: ids.organization,
      name: 'Demo Organization',
      slug: 'demo',
      emailDomain: null,
      baseCurrency: 'USD',
    },
  });

  // ── Demo admin (org ADMIN) + credential account ───────────────────────────
  const admin = await prisma.user.upsert({
    where: { email: DEMO_ADMIN_EMAIL },
    update: { name: 'Demo Admin', emailVerified: true, deletedAt: null },
    create: {
      email: DEMO_ADMIN_EMAIL,
      name: 'Demo Admin',
      emailVerified: true,
      timezone: 'UTC',
      systemRole: 'ADMIN',
      organizationId: organization.id,
    },
  });

  // Only set the password on first creation so a changed demo password survives re-seeding.
  await prisma.account.upsert({
    where: { providerId_accountId: { providerId: 'credential', accountId: admin.id } },
    update: {},
    create: {
      userId: admin.id,
      providerId: 'credential',
      accountId: admin.id,
      password: hashPassword(DEMO_ADMIN_PASSWORD),
    },
  });

  // ── Workspace + membership ────────────────────────────────────────────────
  const workspace = await prisma.workspace.upsert({
    where: { slug: 'demo' },
    update: { name: 'Demo Workspace', deletedAt: null },
    create: {
      name: 'Demo Workspace',
      slug: 'demo',
      ownerId: admin.id,
      organizationId: organization.id,
    },
  });

  await prisma.workspaceMembership.upsert({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: admin.id } },
    update: { role: 'OWNER' },
    create: { workspaceId: workspace.id, userId: admin.id, role: 'OWNER' },
  });

  // ── Sample project ────────────────────────────────────────────────────────
  const project = await prisma.project.upsert({
    where: { workspaceId_key: { workspaceId: workspace.id, key: 'DEMO' } },
    update: { name: 'Sample Project', status: 'ACTIVE' },
    create: {
      id: ids.project,
      workspaceId: workspace.id,
      createdById: admin.id,
      name: 'Sample Project',
      key: 'DEMO',
      status: 'ACTIVE',
      visibility: 'WORKSPACE',
      color: '#6366f1',
      description: 'A sample project created by the demo seed.',
    },
  });

  await prisma.projectMembership.upsert({
    where: { projectId_userId: { projectId: project.id, userId: admin.id } },
    update: { role: 'PROJECT_LEAD' },
    create: { projectId: project.id, userId: admin.id, role: 'PROJECT_LEAD' },
  });

  const tasks = [
    { position: 1, title: 'Invite your team', status: 'TODO' as const },
    { position: 2, title: 'Create your first client', status: 'BACKLOG' as const },
    { position: 3, title: 'Explore the project board', status: 'IN_PROGRESS' as const },
  ];
  for (const t of tasks) {
    await prisma.task.upsert({
      where: { id: ids.task(t.position) },
      update: { title: t.title },
      create: {
        id: ids.task(t.position),
        projectId: project.id,
        createdById: admin.id,
        assigneeId: admin.id,
        title: t.title,
        status: t.status,
        priority: 'MEDIUM',
        position: t.position,
      },
    });
  }

  // ── Welcome document ──────────────────────────────────────────────────────
  await prisma.document.upsert({
    where: { id: ids.document },
    update: {},
    create: {
      id: ids.document,
      workspaceId: workspace.id,
      createdById: admin.id,
      title: 'Welcome',
      visibility: 'WORKSPACE',
      content: tiptapDoc('Welcome', 'This document was created by the demo seed.'),
    },
  });

  console.log(`Seed complete. Sign in as ${DEMO_ADMIN_EMAIL} / ${DEMO_ADMIN_PASSWORD}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
