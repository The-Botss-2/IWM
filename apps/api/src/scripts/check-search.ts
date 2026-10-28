/**
 * Global search self-checks (no database). SearchService runs against a fake
 * Prisma that records every raw SQL statement and Prisma `where`, so the
 * tenant pins, soft-delete filters and visibility gates of each kind can be
 * read straight off the generated SQL. Covered:
 *   (a) every FTS expression appears verbatim in its migration (index use);
 *   (b) toPrefixTsQuery strips tsquery syntax, builds phrases and negations;
 *   (c) every workspace-pinned kind binds the scope's workspace, never another,
 *       and filters `"deletedAt" IS NULL` (parents included);
 *   (d) documents and leads keep their per-user access rules;
 *   (e) an `in:` room outside the allowed set returns [] without a message
 *       query, and the allowed set carries the organization pin;
 *   (f) PRIVATE projects are gated unless member / creator / seesEveryProject;
 *   plus the query schema's filter-only rule and hard `has:` filtering.
 *
 * Run: pnpm --filter @botss/api test
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Prisma } from '@botss/database';
import { searchQuerySchema, type SearchQuery, type SearchResultKind } from '@botss/shared-types';

import type { SalesActor } from '../common/decorators/sales-actor.decorator';
import type { UserScope } from '../common/decorators/user-scope.decorator';
import type { PrismaService } from '../prisma/prisma.service';
import {
  FTS_EXPRESSIONS,
  likePattern,
  lowerSameLength,
  negatedTsQuery,
  negatedWords,
  searchTokens,
  snippetAround,
  textMatch,
  toPrefixTsQuery,
} from '../search/search-sql';
import { SearchService } from '../search/search.service';

const ORG_A = 'cmorga000000000000000000a';
const WS_A = 'cmwsa0000000000000000000a';
const WS_B = 'cmwsb0000000000000000000b';
const USER = 'cmusera00000000000000000a';
const PROJECT_MEMBER = 'cmprojm0000000000000000a';
const ROOM_A1 = 'cmrooma1000000000000000a';
const ROOM_A2 = 'cmrooma2000000000000000a';
const ROOM_B = 'cmroomb0000000000000000b';

type Where = Record<string, unknown>;

function fakePrisma() {
  const sql: Prisma.Sql[] = [];
  const seen: Record<string, Where[]> = {};
  const record = (model: string) => async (args: { where?: Where }) => {
    (seen[model] ??= []).push(args.where ?? {});
    return [];
  };
  const client = {
    // The allowed rooms. ROOM_B (another org) is never returned by the real
    // query; the check below asserts the where-clause that excludes it.
    chatRoomParticipant: {
      findMany: async (args: { where?: Where }) => {
        (seen['chatRoomParticipant'] ??= []).push(args.where ?? {});
        return [{ roomId: ROOM_A1 }, { roomId: ROOM_A2 }];
      },
    },
    chatRoom: { findMany: record('chatRoom') },
    user: { findMany: record('user') },
    mailMessage: { findMany: record('mailMessage') },
    $queryRaw: async (query: Prisma.Sql) => {
      sql.push(query);
      return query.text.trimStart().startsWith('SELECT count(*)') ? [{ n: 0 }] : [];
    },
  };
  return { prisma: { client, raw: client } as unknown as PrismaService, sql, seen };
}

function scope(over: Partial<UserScope> = {}): UserScope {
  return {
    userId: USER,
    workspaceIds: [WS_A],
    projectIds: [PROJECT_MEMBER],
    currentWorkspaceId: WS_A,
    workspaceRole: 'MEMBER',
    seesEveryProject: false,
    ...over,
  };
}

function actor(over: Partial<SalesActor> = {}): SalesActor {
  return {
    userId: USER,
    workspaceId: WS_A,
    fullAccess: false,
    fullLeads: false,
    fullClients: false,
    financeAccess: false,
    ...over,
  };
}

function query(input: Record<string, unknown>): SearchQuery {
  return searchQuerySchema.parse(input);
}

const flat = (s: Prisma.Sql) => s.text.replace(/\s+/g, ' ');

async function run(
  kind: SearchResultKind,
  q: Record<string, unknown>,
  opts: { scope?: Partial<UserScope>; actor?: Partial<SalesActor> } = {},
) {
  const fake = fakePrisma();
  const service = new SearchService(fake.prisma);
  const res = await service.search(
    scope(opts.scope),
    actor(opts.actor),
    ORG_A,
    query({ ...q, kind }),
  );
  return { ...fake, res };
}

async function main(): Promise<void> {
  // --- (a) index expressions match the migration -----------------------------
  // Skipped when the repository ships no migration history (the public
  // release generates its schema from schema.prisma).
  const migrationPath = join(
    __dirname,
    '../../../../packages/database/prisma/migrations/20261026130000_search_fulltext_indexes/migration.sql',
  );
  if (!existsSync(migrationPath)) {
    console.log('  skip  fts index migration not present');
  } else {
    const migration = readFileSync(migrationPath, 'utf8');
    for (const [kind, expr] of Object.entries(FTS_EXPRESSIONS)) {
      assert.ok(
        migration.includes(`USING GIN ((${expr}))`),
        `FTS.${kind} must match its index expression verbatim`,
      );
    }
    assert.equal(
      (migration.match(/CREATE INDEX IF NOT EXISTS "\w+_fts_idx"/g) ?? []).length,
      Object.keys(FTS_EXPRESSIONS).length,
      'one fts index per FTS expression',
    );
    assert.ok(
      !/DROP|ALTER TABLE/i.test(migration.replace(/^--.*$/gm, '')),
      'migration is index-only',
    );
  }

  // --- (b) tsquery building ---------------------------------------------------
  {
    assert.equal(toPrefixTsQuery('design rev'), 'design:* & rev:*');
    assert.equal(toPrefixTsQuery('"design review" q3'), 'design <-> review:* & q3:*');
    // Exclusions never enter the positive query (matchSql applies them with
    // AND NOT): `² -draft` must not collapse to `!draft` = "everything else".
    assert.equal(toPrefixTsQuery('invoice -draft'), 'invoice:*');
    assert.equal(toPrefixTsQuery('"design review" -"old plan"'), 'design <-> review:*');
    assert.equal(negatedTsQuery('invoice -draft -"old plan"'), 'draft | (old <-> plan)');
    assert.ok(!toPrefixTsQuery('² -draft')!.includes('!'), 'no negation in the positive query');
    // Excluded words still spend the 8-word budget.
    assert.equal(
      toPrefixTsQuery('-aa -bb -cc -dd -ee -ff -gg -hh zz'),
      null,
      'budget spent on exclusions',
    );
    // Case is left to to_tsquery, which lower-cases with the database's rules
    // (the same ones to_tsvector used); JS lower-casing breaks Turkish İ.
    assert.equal(toPrefixTsQuery('Invoice'), 'Invoice:*', 'case left to Postgres');
    assert.equal(
      toPrefixTsQuery('İş İstanbul'),
      'İş:* & İstanbul:*',
      'Turkish dotted İ kept as typed',
    );
    assert.ok(!toPrefixTsQuery('İş İstanbul')!.includes('\u0307'), 'no JS-lowered i + U+0307');
    // Combining marks stay inside their word (decomposed é, i + U+0307).
    assert.equal(
      toPrefixTsQuery('cafe\u0301 menu'),
      'cafe\u0301:* & menu:*',
      'decomposed accent: one word',
    );
    assert.equal(toPrefixTsQuery('i\u0307stanbul'), 'i\u0307stanbul:*', 'i + U+0307: one word');
    assert.equal(toPrefixTsQuery('\u0301'), null, 'a lone mark is not a word');
    assert.equal(toPrefixTsQuery('\u0301ab'), 'ab:*', 'a leading mark is dropped');
    // Snippet / highlight lower-casing keeps string length, so a match index
    // found after a Turkish 'İ' still points at the right place.
    assert.equal(lowerSameLength('İstanbul ABC'), 'İstanbul abc');
    assert.equal(lowerSameLength('İstanbul').length, 'İstanbul'.length);
    assert.deepEqual(
      searchTokens('Invoice İş'),
      ['invoice', 'İş'],
      'snippet tokens: length-preserving lower case',
    );
    assert.equal(
      snippetAround('İİİİ İstanbul ofisi raporu', ['ofisi'], 3),
      '...ul ofisi ra...',
      'snippet window stays aligned after İ',
    );
    assert.equal(
      snippetAround('Ofisi İstanbul', ['istanbul'], 50),
      'Ofisi İstanbul',
      'no false match on JS-lowered İ',
    );
    // tsquery syntax typed by the user never survives.
    const hostile = toPrefixTsQuery(`ab&cd | ef!gh:(ij)' kl:*`);
    assert.equal(hostile, 'ab:* & cd:* & ef:* & gh:* & ij:* & kl:*');
    for (const ch of ['|', '(', ')', "'"]) {
      assert.ok(!hostile!.includes(ch), `stripped ${ch}`);
    }
    assert.equal(toPrefixTsQuery(`&|!:()'`), null, 'nothing positive left');
    assert.equal(toPrefixTsQuery('-draft'), null, 'only a negation');
    assert.equal(toPrefixTsQuery('صارف report'), 'صارف:* & report:*', 'any script');
    assert.equal(
      toPrefixTsQuery('aa bb cc dd ee ff gg hh ii jj'),
      'aa:* & bb:* & cc:* & dd:* & ee:* & ff:* & gg:* & hh:*',
      'max 8 tokens',
    );
    // One-character words match whole: `q:*` would hit half the table.
    assert.equal(toPrefixTsQuery('q 3 report'), 'q & 3 & report:*');
    assert.equal(toPrefixTsQuery('"plan b"'), 'plan <-> b', 'single-char phrase tail');
    assert.deepEqual(searchTokens('"design review" -draft q3'), ['design', 'review', 'q3']);
    assert.equal(likePattern('50%_off\\'), '%50\\%\\_off\\\\%');
  }

  // --- (c) workspace pin + soft delete on every workspace-pinned kind ---------
  for (const kind of ['task', 'project', 'lead', 'client', 'document', 'workspace_file'] as const) {
    // A stray workspaceId in the request is stripped by the schema.
    const { sql } = await run(kind, { q: 'zqxleak', workspaceId: WS_B });
    assert.equal(sql.length, 1, `${kind}: one query`);
    const s = sql[0]!;
    assert.ok(s.values.includes(WS_A), `${kind}: binds the scope workspace`);
    assert.ok(!s.values.includes(WS_B), `${kind}: never another workspace`);
    assert.ok(flat(s).includes('"deletedAt" IS NULL'), `${kind}: soft-delete filter`);
    assert.ok(
      flat(s).includes("to_tsquery('simple'::regconfig, $"),
      `${kind}: tsquery is a bound param`,
    );
    assert.ok(s.values.includes('zqxleak:*'), `${kind}: prefix tsquery bound`);
    assert.ok(s.values.includes('%zqxleak%'), `${kind}: ILIKE pattern bound`);
  }
  {
    // Tasks of a soft-deleted project never match: both rows are filtered.
    const { sql } = await run('task', { q: 'zqxleak' });
    const text = flat(sql[0]!);
    assert.ok(text.includes('t."deletedAt" IS NULL'), 'task deletedAt');
    assert.ok(text.includes('p."deletedAt" IS NULL'), 'task parent project deletedAt');
    assert.ok(text.includes('p."workspaceId" = $'), 'task pinned through its project');
  }
  {
    // Workspace files reached through a task comment: every hop is live.
    const { sql } = await run('workspace_file', { q: 'zqxleak' });
    const text = flat(sql[0]!);
    for (const hop of [
      'cm."deletedAt" IS NULL',
      'tk."deletedAt" IS NULL',
      'p."deletedAt" IS NULL',
    ]) {
      assert.ok(text.includes(hop), `workspace_file: ${hop}`);
    }
    assert.ok(
      text.includes('"SignatureRequest"') && text.includes('"SignatureSigner"'),
      'signature files excluded',
    );
  }

  {
    // Document labels: a shared document filed under a PRIVATE project must
    // not reveal that project's name.
    const { sql } = await run('document', { q: 'zqxleak' });
    const text = flat(sql[0]!);
    assert.ok(
      text.includes(`pn."deletedAt" IS NULL AND (pn.visibility <> 'PRIVATE'`),
      'document project label: visibility-gated on pn',
    );
    const admin = await run('document', { q: 'zqxleak' }, { scope: { seesEveryProject: true } });
    assert.ok(
      flat(admin.sql[0]!).includes('pn."deletedAt" IS NULL AND TRUE'),
      'seesEveryProject: label ungated',
    );
  }

  // --- (d) per-user access rules ----------------------------------------------
  {
    const member = await run('document', { q: 'zqxleak' });
    assert.ok(
      flat(member.sql[0]!).includes('EXISTS (SELECT 1 FROM "DocumentAccess"'),
      'non-admin: DocumentAccess gate',
    );
    assert.ok(member.sql[0]!.values.includes(USER), 'non-admin: binds the caller');
    const admin = await run('document', { q: 'zqxleak' }, { scope: { workspaceRole: 'ADMIN' } });
    assert.ok(!flat(admin.sql[0]!).includes('"DocumentAccess"'), 'admin: no access gate');

    const lead = await run('lead', { q: 'zqxleak' });
    assert.ok(flat(lead.sql[0]!).includes('l."assigneeId" = $'), 'lead: assignee gate');
    assert.ok(lead.sql[0]!.values.includes(USER), 'lead: binds the caller');
    const fullLead = await run('lead', { q: 'zqxleak' }, { actor: { fullLeads: true } });
    assert.ok(!flat(fullLead.sql[0]!).includes('"assigneeId"'), 'lead: full access sees all');

    const client = await run('client', { q: 'zqxleak' });
    assert.ok(flat(client.sql[0]!).includes('c."assigneeId" = $'), 'client: assignee gate');
    const finance = await run('client', { q: 'zqxleak' }, { actor: { financeAccess: true } });
    assert.ok(!flat(finance.sql[0]!).includes('"assigneeId"'), 'client: finance sees all');
    // Holding only the clients grant must not widen leads.
    const clientsOnly = await run('lead', { q: 'zqxleak' }, { actor: { fullClients: true } });
    assert.ok(
      flat(clientsOnly.sql[0]!).includes('l."assigneeId" = $'),
      'lead: clients grant is not leads',
    );
  }

  // --- (e) chat scope ---------------------------------------------------------
  {
    const { sql, seen, res } = await run('chat_message', { q: 'zqxleak', roomId: ROOM_B });
    assert.deepEqual(res.results, [], 'room outside the allowed set: no hits');
    assert.equal(sql.length, 0, 'room outside the allowed set: no message query');
    const where = seen['chatRoomParticipant']![0]!;
    assert.equal(where['userId'], USER, 'participant of the room');
    const room = where['room'] as { deletedAt: unknown; OR: Where[] };
    assert.equal(room.deletedAt, null, 'deleted rooms excluded');
    assert.deepEqual(
      room.OR,
      [{ workspaceId: null }, { workspace: { organizationId: ORG_A, deletedAt: null } }],
      'org-wide: own-org workspaces (live) or no workspace',
    );

    const inRoom = await run('chat_message', { q: 'zqxleak', roomId: ROOM_A2 });
    assert.equal(inRoom.sql.length, 1);
    const rooms = inRoom.sql[0]!.values.find(Array.isArray) as string[];
    assert.deepEqual(rooms, [ROOM_A2], 'in: narrows to the one room');
    const text = flat(inRoom.sql[0]!);
    assert.ok(text.includes('m."deletedAt" IS NULL'), 'deleted messages excluded');
    for (const marker of ['__call__', '__share__', '__system__']) {
      assert.ok(inRoom.sql[0]!.values.includes(marker), `${marker} rows excluded`);
    }

    const all = await run('chat_message', { q: 'zqxleak' });
    assert.deepEqual(
      all.sql[0]!.values.find(Array.isArray),
      [ROOM_A1, ROOM_A2],
      'every allowed room',
    );

    const files = await run('file', { q: 'zqxleak', roomId: ROOM_B });
    assert.equal(files.sql.length, 0, 'chat files: same room rule');

    const hasFile = await run('chat_message', { q: '', has: 'file' });
    assert.ok(
      flat(hasFile.sql[0]!).includes('EXISTS (SELECT 1 FROM "ChatRoomAttachment"'),
      'has:file',
    );
    assert.ok(!flat(hasFile.sql[0]!).includes('to_tsquery'), 'filter-only: no text predicate');
    const hasLink = await run('chat_message', { q: 'zqx', has: 'link' });
    assert.ok(flat(hasLink.sql[0]!).includes("m.content ~* 'https?://'"), 'has:link');

    const nullOrg = fakePrisma();
    await new SearchService(nullOrg.prisma).search(
      scope(),
      actor(),
      null,
      query({ q: 'zqx', kind: 'chat_message' }),
    );
    const nullRoom = nullOrg.seen['chatRoomParticipant']![0]!['room'] as { OR: Where[] };
    assert.deepEqual(
      nullRoom.OR,
      [{ workspaceId: null }],
      'no organization: workspace rooms excluded',
    );
  }

  // --- (f) PRIVATE project gate -----------------------------------------------
  {
    const member = await run('task', { q: 'zqxleak' });
    const text = flat(member.sql[0]!);
    assert.ok(text.includes("p.visibility <> 'PRIVATE'"), 'private gate present');
    assert.ok(text.includes('p.id = ANY($'), 'member path');
    assert.ok(text.includes('p."createdById" = $'), 'creator path');
    assert.ok(
      member.sql[0]!.values.some((v) => Array.isArray(v) && v.includes(PROJECT_MEMBER)),
      'binds the caller project memberships',
    );
    const noMemberships = await run('project', { q: 'zqxleak' }, { scope: { projectIds: [] } });
    assert.ok(!flat(noMemberships.sql[0]!).includes('ANY('), 'no memberships: no member path');
    assert.ok(flat(noMemberships.sql[0]!).includes("p.visibility <> 'PRIVATE'"), 'still gated');
    const admin = await run('task', { q: 'zqxleak' }, { scope: { seesEveryProject: true } });
    assert.ok(!flat(admin.sql[0]!).includes('PRIVATE'), 'seesEveryProject: no gate');
  }

  // --- query schema + hard filters --------------------------------------------
  {
    assert.ok(
      !searchQuerySchema.safeParse({ q: 'a' }).success,
      'one character, no filter: rejected',
    );
    assert.ok(!searchQuerySchema.safeParse({}).success, 'empty: rejected');
    assert.ok(searchQuerySchema.safeParse({ has: 'file' }).success, 'filter-only: accepted');
    assert.equal(query({ q: 'ab' }).sort, 'relevance', 'relevance by default');

    // has:file never lists tasks, and a filter-only search skips kinds the
    // filter does not apply to (no unfiltered table dumps).
    // Only an excluded word: nothing positive, so nothing matches.
    const negOnly = await run('task', { q: '-draft' });
    assert.ok(flat(negOnly.sql[0]!).includes('AND FALSE'), 'negation-only: no hits');
    const negMail = await run('mail', { q: '-draft' });
    assert.equal(negMail.seen['mailMessage'], undefined, 'negation-only: no mail query');

    const hasTask = await run('task', { q: 'zqx', has: 'file' });
    assert.equal(hasTask.sql.length, 0, 'has:file: no task query');
    const fromOnly = await run('task', { q: '', fromUserId: USER });
    assert.equal(fromOnly.sql.length, 0, 'filter-only from: no task query');
    const inProject = await run('project', { q: 'zqx', roomId: ROOM_A1 });
    assert.equal(inProject.sql.length, 0, 'in: is chat-only');

    // recent sort orders by date, relevance by score.
    const recent = await run('task', { q: 'zqx', sort: 'recent' });
    assert.ok(flat(recent.sql[0]!).includes('ORDER BY at DESC, id DESC'), 'recent order');
    const relevance = await run('task', { q: 'zqx' });
    const rel = flat(relevance.sql[0]!).trim();
    assert.ok(rel.includes('ORDER BY score DESC, at DESC, id DESC'), 'relevance order');
    // Relevance scores a bounded pool: the newest RANK_POOL matches plus the
    // newest title-prefix matches, never every matching row.
    assert.ok(rel.startsWith('WITH matched AS MATERIALIZED ('), 'text match evaluated once');
    // Ties on `at` break by id, so page 2 sees the same pool as page 1.
    assert.ok(
      rel.includes('cand AS ( (SELECT id FROM matched ORDER BY at DESC, id DESC LIMIT $'),
      'candidate pool',
    );
    assert.ok(
      relevance.sql[0]!.values.includes(1051),
      'pool covers the deepest page (MAX_OFFSET + 51)',
    );
    assert.ok(
      rel.includes('b."title" ILIKE $') &&
        rel.includes(
          'UNION (SELECT id FROM matched WHERE title_prefix ORDER BY at DESC, id DESC LIMIT $',
        ) &&
        relevance.sql[0]!.values.includes('zqx%'),
      'title-prefix pool',
    );
    assert.ok(rel.includes('AND t.id IN (SELECT id FROM cand)'), 'scored rows limited to the pool');
    assert.ok(rel.includes('greatest(ts_rank_cd('), 'one tsvector per scored row');
    assert.ok(!/CASE WHEN \(setweight/.test(rel), 'no CASE re-evaluating the tsquery');
    assert.ok(!flat(recent.sql[0]!).includes('WITH matched'), 'recent: no ranking pool');

    // No text: newest first, no ranking.
    const filterOnly = await run('chat_message', { q: '', has: 'file' });
    assert.ok(
      flat(filterOnly.sql[0]!).includes('ORDER BY at DESC, id DESC'),
      'filter-only: by date',
    );
    assert.ok(!flat(filterOnly.sql[0]!).includes('WITH matched'), 'filter-only: no ranking pool');
    // Messages have no title: no title pool.
    const msg = await run('chat_message', { q: 'zqx' });
    assert.ok(!flat(msg.sql[0]!).includes('UNION'), 'messages: newest pool only');

    // Under three characters the trigram ILIKE can't use an index: tsquery only.
    const short = await run('task', { q: 'ab' });
    assert.ok(short.sql[0]!.values.includes('ab:*'), 'short text: tsquery');
    assert.ok(!short.sql[0]!.values.includes('%ab%'), 'short text: no ILIKE scan');

    // `-word` reaches the Prisma kinds too.
    assert.deepEqual(
      textMatch('invoice -draft -"old copy"')!.negWords,
      ['draft', 'old copy'],
      'negWords',
    );
    // One entry per excluded chunk: an address is not split into "com".
    assert.deepEqual(negatedWords('x -a@b.com'), ['a@b.com'], 'excluded address kept whole');
    assert.deepEqual(negatedWords('x -noreply@acme.com'), ['noreply@acme.com']);
    // Under three characters a substring exclusion would drop nearly everything.
    assert.deepEqual(negatedWords('x -a -to -"ab" -fee'), ['fee'], 'short exclusions skipped');
    // Edge punctuation from a pasted header is trimmed; punctuation-only phrases exclude nothing.
    assert.deepEqual(negatedWords('x -<a@b.com>'), ['a@b.com'], 'excluded address trimmed');
    assert.deepEqual(negatedWords('x -noreply@acme.com,'), ['noreply@acme.com']);
    assert.deepEqual(negatedWords('x -"..." -"!!!"'), [], 'punctuation-only phrase skipped');
    const negMailQ = await run('mail', { q: 'invoice -draft -"old copy"' });
    const negMailWhere = JSON.stringify(negMailQ.seen['mailMessage']![0]);
    for (const w of ['draft', 'old copy']) {
      for (const field of ['subject', 'fromAddress', 'bodyTextPreview']) {
        assert.ok(
          negMailWhere.includes(`{"${field}":{"contains":"${w}","mode":"insensitive"}}`),
          `mail NOT ${field} contains ${w}`,
        );
      }
      // fromName is nullable: a NULL name must not drop the mail.
      assert.ok(
        negMailWhere.includes(
          `"OR":[{"fromName":null},{"NOT":{"fromName":{"contains":"${w}","mode":"insensitive"}}}]`,
        ),
        `mail fromName exclusion is null-safe (${w})`,
      );
    }
    assert.ok(negMailWhere.includes('"NOT":[{"subject"'), 'mail where has the NOT clause');
    const negRooms = await run('chat_room', { q: 'design -draft' });
    assert.ok(
      JSON.stringify(negRooms.seen['chatRoom']![0]).includes(
        '{"OR":[{"name":null},{"NOT":{"name":{"contains":"draft","mode":"insensitive"}}}]}',
      ),
      'rooms: name exclusion, DMs kept',
    );
    // A DM matched through the other person's name is excluded by the same rule.
    const negDm = await run('chat_room', { q: 'sara -khan' });
    assert.ok(
      JSON.stringify(negDm.seen['chatRoom']![0]).includes(
        `{"NOT":{"participants":{"some":{"userId":{"not":"${USER}"},"user":{"OR":[{"name":{"contains":"khan","mode":"insensitive"}},{"email":{"contains":"khan","mode":"insensitive"}}]}}}}}`,
      ),
      'rooms: other participants name / email exclusion',
    );
    const negPeople = await run('person', { q: 'sara -khan' });
    assert.deepEqual(
      negPeople.seen['user']![0]!['NOT'],
      [
        { name: { contains: 'khan', mode: 'insensitive' } },
        { email: { contains: 'khan', mode: 'insensitive' } },
      ],
      'people: name / email exclusion',
    );
    const plainMail = await run('mail', { q: 'invoice' });
    assert.deepEqual(
      plainMail.seen['mailMessage']![0]!['AND'],
      [],
      'no exclusions: no extra mail clauses',
    );

    // Mail has:file maps to hasAttachments.
    const mail = await run('mail', { q: 'zqx', has: 'file' });
    assert.equal(mail.seen['mailMessage']![0]!['hasAttachments'], true, 'mail has:file');

    // Counts wrap each query in a capped count.
    const counts = await run('task', { q: 'zqx', counts: 'true' });
    assert.ok(
      counts.sql.some(
        (s) =>
          flat(s).startsWith('SELECT count(*)::int AS n FROM (') && flat(s).includes('LIMIT $'),
      ),
      'capped count',
    );
  }

  process.stdout.write('check-search: all checks passed\n');
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
