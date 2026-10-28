import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  SEARCH_COUNT_CAP,
  type SearchQuery,
  type SearchResponse,
  type SearchResult,
  type SearchResultKind,
} from '@botss/shared-types';
import { Prisma } from '@botss/database';

import type { SalesActor } from '../common/decorators/sales-actor.decorator';
import type { UserScope } from '../common/decorators/user-scope.decorator';
import { isSupportRequest } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { SUPPORT_EXCLUDED_SEARCH_KINDS } from '../support/support-rules';
import {
  FTS,
  matchSql,
  prefixPattern,
  scoreInJs,
  scoreSql,
  snippetAround,
  textMatch,
  type TextMatch,
} from './search-sql';

/** What the Ctrl+K palette searches when the caller does not pick kinds. */
const PALETTE_KINDS: SearchResultKind[] = [
  'task',
  'project',
  'lead',
  'client',
  'document',
  'chat_message',
  'chat_room',
  'file',
];

/** Every kind, in the order the search page shows its tabs. */
const ALL_KINDS: SearchResultKind[] = [
  'chat_message',
  'file',
  'workspace_file',
  'chat_room',
  'person',
  'mail',
  'task',
  'document',
  'project',
  'lead',
  'client',
];

/** Deepest page reachable with offset paging. Search is for finding, not browsing. */
const MAX_OFFSET = 1_000;

/** Synthetic chat rows (call logs, share cards, membership notices) never surface as hits. */
const MARKER_PREFIXES = ['__call__', '__share__', '__system__'];

/**
 * Which filters each kind understands. `in:` and `has:` are hard filters: a
 * kind that cannot honor them returns nothing rather than ignoring them, so
 * `has:file` never lists tasks. `from:` and dates stay soft (ignored where
 * they don't apply), as before. A filter-only search (no text) only runs on
 * kinds that understand at least one of the active filters; otherwise it
 * would list every task in the workspace.
 */
const FILTERS: Record<
  SearchResultKind,
  { from: boolean; date: boolean; in: boolean; has: ('file' | 'link')[] }
> = {
  chat_message: { from: true, date: true, in: true, has: ['file', 'link'] },
  file: { from: true, date: true, in: true, has: ['file'] },
  workspace_file: { from: true, date: true, in: false, has: ['file'] },
  mail: { from: false, date: true, in: false, has: ['file', 'link'] },
  task: { from: false, date: true, in: false, has: [] },
  document: { from: false, date: true, in: false, has: [] },
  project: { from: false, date: false, in: false, has: [] },
  lead: { from: false, date: false, in: false, has: [] },
  client: { from: false, date: false, in: false, has: [] },
  chat_room: { from: false, date: false, in: false, has: [] },
  person: { from: false, date: false, in: false, has: [] },
};

interface Ctx {
  /** Always the active workspace from the request scope, never from the query. */
  workspaceId: string;
  userId: string;
  /** The caller's organization (session), for the org-wide chat scope. */
  organizationId: string | null;
  /**
   * The box text for the Prisma kinds' `contains`: quotes and `-excluded`
   * words removed. '' for a filter-only search.
   */
  term: string;
  match: TextMatch | null;
  /** `-excluded` words and phrases, for the Prisma kinds (see TextMatch.negWords). */
  negWords: string[];
  sort: 'relevance' | 'recent';
  /** Project visibility: true when PRIVATE projects are visible too. */
  seesEveryProject: boolean;
  projectIds: string[];
  /** Leads: `sales.leads.all`; otherwise only assigned ones. */
  fullLeads: boolean;
  /** Clients: `sales.clients.all` or finance; otherwise only assigned ones. */
  allClients: boolean;
  /** Workspace OWNER / ADMIN read every document. */
  isWorkspaceAdmin: boolean;
  /** Chat rooms the caller may read, resolved once per request, on demand. */
  roomIds: () => Promise<string[]>;
  fromUserId?: string;
  roomId?: string;
  has?: 'file' | 'link';
  createdAt?: { gte?: Date; lte?: Date };
}

interface Page {
  skip: number;
  take: number;
}

/** A full-text kind's query (no ORDER BY / LIMIT) and how to read its rows. */
interface BuiltKind {
  base: Prisma.Sql;
  /** The indexed row's id column (`t.id`), for the candidate filter. */
  id: Prisma.Sql;
  /** The title column the score boosts, or null when the kind has none. */
  title: Prisma.Sql | null;
  /** The same column's name in `base`'s output (`title`, `name`, ...). */
  titleOut: string | null;
  map: (r: Record<string, unknown>) => Scored;
}

/**
 * Relevance ranking scores at most this many of the newest matches (plus the
 * newest title-prefix matches), so a common word costs a top-N date sort, not
 * a ts_rank_cd over every matching row. Covers the deepest reachable page, so
 * offset paging stays stable.
 */
const RANK_POOL = MAX_OFFSET + 51;
/** Newest title-prefix matches added to the pool, so an old "Acme" still surfaces. */
const TITLE_POOL = 50;

/** A hit plus its relevance score, before the score is dropped from the response. */
type Scored = SearchResult & { score: number };

const insensitive = (term: string) => ({ contains: term, mode: 'insensitive' as const });

const strip = ({ score: _score, ...rest }: Scored): SearchResult => rest;

const byScore = (a: Scored, b: Scored): number =>
  b.score - a.score || (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0);

@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(
    scope: UserScope,
    salesActor: SalesActor,
    organizationId: string | null,
    query: SearchQuery,
  ): Promise<SearchResponse> {
    if (!scope.currentWorkspaceId || scope.workspaceIds.length === 0) {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'Active workspace required.',
      });
    }
    const ctx = this.buildContext(scope, salesActor, organizationId, query);

    if (query.kind) {
      const skip = Math.min(query.cursor ? Number.parseInt(query.cursor, 10) : 0, MAX_OFFSET);
      const rows = await this.searchKind(query.kind, ctx, { skip, take: query.limit + 1 });
      const hasMore = rows.length > query.limit && skip + query.limit < MAX_OFFSET;
      return {
        results: rows.slice(0, query.limit).map(strip),
        nextCursor: hasMore ? String(skip + query.limit) : null,
        ...(query.counts ? { counts: await this.countKinds(ctx) } : {}),
      };
    }

    // Palette / "All" mode: the best `limit` hits of each kind, merged by
    // score (or date), so a strong project match outranks a weak message one.
    const kinds = query.kinds ?? PALETTE_KINDS;
    const lists = await Promise.all(
      kinds.map((k) => this.searchKind(k, ctx, { skip: 0, take: query.limit })),
    );
    const merged = lists.flat();
    merged.sort(
      ctx.sort === 'recent'
        ? (a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0) || b.score - a.score
        : byScore,
    );
    return {
      results: merged.slice(0, query.limit).map(strip),
      ...(query.counts ? { counts: await this.countKinds(ctx) } : {}),
    };
  }

  private buildContext(
    scope: UserScope,
    salesActor: SalesActor,
    organizationId: string | null,
    query: SearchQuery,
  ): Ctx {
    const userId = scope.userId;
    let roomIdsPromise: Promise<string[]> | null = null;
    const createdAt =
      query.after || query.before
        ? {
            ...(query.after ? { gte: query.after } : {}),
            ...(query.before ? { lte: query.before } : {}),
          }
        : undefined;
    return {
      // Every workspace-scoped query pins this server-side; nothing from the
      // request shapes it, so cross-tenant leaks aren't reachable.
      workspaceId: scope.currentWorkspaceId!,
      userId,
      organizationId,
      term: textMatch(query.q)?.like ?? '',
      match: textMatch(query.q),
      negWords: textMatch(query.q)?.negWords ?? [],
      sort: query.sort,
      // Search pins the workspace itself rather than going through
      // `projectAccessWhere`, so the PRIVATE-project gate
      // (`projectVisibilityWhere`) is composed into each query below.
      seesEveryProject: scope.seesEveryProject,
      projectIds: scope.projectIds,
      // Leads and clients are assignee-scoped per kind, exactly as in
      // LeadsService (`fullLeads`) and ClientsService (`clientVisibleWhere`:
      // `fullClients` or finance).
      fullLeads: salesActor.fullLeads,
      allClients: salesActor.fullClients || salesActor.financeAccess,
      // Documents are private by default: same rule as DocumentsService.list.
      isWorkspaceAdmin: scope.workspaceRole === 'OWNER' || scope.workspaceRole === 'ADMIN',
      roomIds: () => {
        roomIdsPromise ??= this.allowedRoomIds(userId, organizationId);
        return roomIdsPromise;
      },
      ...(query.fromUserId ? { fromUserId: query.fromUserId } : {}),
      ...(query.roomId ? { roomId: query.roomId } : {}),
      ...(query.has ? { has: query.has } : {}),
      ...(createdAt ? { createdAt } : {}),
    };
  }

  /**
   * Chat search is organization-wide, not pinned to the active workspace: a
   * room is readable when the caller is a participant, the room is not
   * deleted, and it either has no workspace (DMs, ad-hoc groups) or its
   * workspace belongs to the caller's organization and is not deleted. A room
   * the caller is still a participant of in another organization stays out.
   */
  private async allowedRoomIds(userId: string, organizationId: string | null): Promise<string[]> {
    const rows = await this.prisma.client.chatRoomParticipant.findMany({
      where: {
        userId,
        room: {
          deletedAt: null,
          OR: [
            { workspaceId: null },
            ...(organizationId ? [{ workspace: { organizationId, deletedAt: null } }] : []),
          ],
        },
      },
      select: { roomId: true },
    });
    return rows.map((r) => r.roomId);
  }

  /** Room ids a chat query may read: the allowed set, narrowed by an `in:` filter. */
  private async chatRooms(ctx: Ctx): Promise<string[]> {
    const rooms = await ctx.roomIds();
    if (!ctx.roomId) return rooms;
    return rooms.includes(ctx.roomId) ? [ctx.roomId] : [];
  }

  /** Capped hit count per kind for the search page tabs. */
  private async countKinds(ctx: Ctx): Promise<Partial<Record<SearchResultKind, number>>> {
    const counts = await Promise.all(
      ALL_KINDS.map(async (k) => [k, await this.countKind(k, ctx)] as const),
    );
    return Object.fromEntries(counts);
  }

  private async countKind(kind: SearchResultKind, ctx: Ctx): Promise<number> {
    if (!this.applies(kind, ctx)) return 0;
    const built = await this.buildSql(kind, ctx, true);
    if (built === undefined) {
      // A Prisma-backed kind: count a capped lean page.
      const rows = await this.searchKind(kind, ctx, { skip: 0, take: SEARCH_COUNT_CAP + 1 }, true);
      return rows.length;
    }
    if (built === null) return 0;
    const rows = await this.prisma.client.$queryRaw<Array<{ n: number }>>(
      Prisma.sql`SELECT count(*)::int AS n FROM (${built.base} LIMIT ${SEARCH_COUNT_CAP + 1}) s`,
    );
    return rows[0]?.n ?? 0;
  }

  /** Whether `kind` should run at all for the active filters (see FILTERS). */
  private applies(kind: SearchResultKind, ctx: Ctx): boolean {
    // A read only support session never searches chat or mail: both are
    // private to each person (the HTTP routes are refused too).
    if (SUPPORT_EXCLUDED_SEARCH_KINDS.has(kind) && isSupportRequest()) return false;
    const f = FILTERS[kind];
    if (ctx.roomId && !f.in) return false;
    if (ctx.has && !f.has.includes(ctx.has)) return false;
    if (!ctx.match) {
      const narrowed =
        (ctx.fromUserId && f.from) ||
        (ctx.roomId && f.in) ||
        (ctx.has && f.has.includes(ctx.has)) ||
        (ctx.createdAt && f.date);
      if (!narrowed) return false;
    }
    return true;
  }

  /** One kind, one page. `lean` skips the text needed only for snippets. */
  private async searchKind(
    kind: SearchResultKind,
    ctx: Ctx,
    page: Page,
    lean = false,
  ): Promise<Scored[]> {
    if (!this.applies(kind, ctx)) return [];
    switch (kind) {
      case 'chat_room':
        return this.searchRooms(ctx, page);
      case 'person':
        return this.searchPeople(ctx, page);
      case 'mail':
        return this.searchMail(ctx, page, lean);
      default:
        return this.searchSql(kind, ctx, page, lean);
    }
  }

  // ---------------------------------------------------------------------------
  // Full-text kinds (raw SQL)
  // ---------------------------------------------------------------------------

  private async searchSql(
    kind: SearchResultKind,
    ctx: Ctx,
    page: Page,
    lean: boolean,
  ): Promise<Scored[]> {
    const built = await this.buildSql(kind, ctx, lean);
    if (!built) return [];
    const limit = Prisma.sql`LIMIT ${page.take} OFFSET ${page.skip}`;

    // Newest first, or a filter-only search (no text to rank by).
    if (ctx.sort === 'recent' || !ctx.match) {
      const rows = await this.prisma.client.$queryRaw<Array<Record<string, unknown>>>(
        Prisma.sql`${built.base} ORDER BY at DESC, id DESC ${limit}`,
      );
      return rows.map((r) => built.map(r));
    }

    // Relevance: pick a bounded candidate pool cheaply (no scoring), then
    // score only those rows.
    const leanKind = await this.buildSql(kind, ctx, true);
    if (!leanKind) return [];
    // The text match runs once (MATERIALIZED); both pools read from it. Both
    // pools break date ties by id so every page of a query sees the same pool.
    const titleOut =
      leanKind.titleOut && ctx.match.like ? Prisma.raw(`b."${leanKind.titleOut}"`) : null;
    const titlePrefix = titleOut
      ? Prisma.sql`${titleOut} ILIKE ${prefixPattern(ctx.match.like)}`
      : Prisma.sql`FALSE`;
    const titlePool = titleOut
      ? Prisma.sql`
            UNION
            (SELECT id FROM matched WHERE title_prefix ORDER BY at DESC, id DESC LIMIT ${TITLE_POOL})`
      : Prisma.empty;
    const rows = await this.prisma.client.$queryRaw<Array<Record<string, unknown>>>(
      Prisma.sql`
        WITH matched AS MATERIALIZED (
          SELECT b.id, b.at, ${titlePrefix} AS title_prefix FROM (${leanKind.base}) b
        ),
        cand AS (
          (SELECT id FROM matched ORDER BY at DESC, id DESC LIMIT ${RANK_POOL})${titlePool}
        )
        ${built.base} AND ${built.id} IN (SELECT id FROM cand)
        ORDER BY score DESC, at DESC, id DESC ${limit}`,
    );
    return rows.map((r) => built.map(r));
  }

  /** Visibility gate for a project row aliased `p` (mirrors projectVisibilityWhere). */
  private projectVisible(ctx: Ctx, alias: string): Prisma.Sql {
    if (ctx.seesEveryProject) return Prisma.sql`TRUE`;
    const p = Prisma.raw(alias);
    const member =
      ctx.projectIds.length > 0 ? Prisma.sql` OR ${p}.id = ANY(${ctx.projectIds})` : Prisma.empty;
    return Prisma.sql`(${p}.visibility <> 'PRIVATE'${member} OR ${p}."createdById" = ${ctx.userId})`;
  }

  /** Live, visible projects of the active workspace (aliased `p`). */
  private visibleProjectIds(ctx: Ctx): Prisma.Sql {
    return Prisma.sql`SELECT p.id FROM "Project" p WHERE p."workspaceId" = ${ctx.workspaceId} AND p."deletedAt" IS NULL AND ${this.projectVisible(ctx, 'p')}`;
  }

  private dateSql(ctx: Ctx, column: Prisma.Sql): Prisma.Sql {
    const parts: Prisma.Sql[] = [];
    if (ctx.createdAt?.gte) parts.push(Prisma.sql` AND ${column} >= ${ctx.createdAt.gte}`);
    if (ctx.createdAt?.lte) parts.push(Prisma.sql` AND ${column} <= ${ctx.createdAt.lte}`);
    return parts.length > 0 ? Prisma.join(parts, '') : Prisma.empty;
  }

  private score(
    ctx: Ctx,
    fts: Prisma.Sql,
    title: Prisma.Sql | null,
    at: Prisma.Sql,
    lean: boolean,
  ) {
    return lean ? Prisma.sql`0::float8` : scoreSql({ fts, title, at, match: ctx.match });
  }

  /**
   * The SELECT (without ORDER BY / LIMIT) for a full-text kind plus its row
   * mapper. `undefined` for kinds still served by Prisma; `null` when the
   * caller can't see anything of this kind (no rooms), so no query runs.
   *
   * Every query lists the indexed table as its only FROM relation (joins go
   * through subqueries), so the unqualified columns in `FTS.*` resolve to it.
   */
  private async buildSql(
    kind: SearchResultKind,
    ctx: Ctx,
    lean: boolean,
  ): Promise<BuiltKind | null | undefined> {
    const { workspaceId, userId, match } = ctx;
    const tokens = match?.tokens ?? [];

    switch (kind) {
      case 'task': {
        const fts = FTS.task;
        // The project label needs no gate of its own: the WHERE only admits
        // tasks of live, visible projects.
        return {
          base: Prisma.sql`
            SELECT t.id, t.title, t."projectId", t."updatedAt" AS at,
              (SELECT pn.name FROM "Project" pn WHERE pn.id = t."projectId") AS "projectName",
              ${this.score(ctx, fts, Prisma.sql`t.title`, Prisma.sql`t."updatedAt"`, lean)} AS score
            FROM "Task" t
            WHERE t."deletedAt" IS NULL
              AND t."projectId" IN (${this.visibleProjectIds(ctx)})
              AND ${matchSql(fts, [Prisma.sql`t.title`, Prisma.sql`t.description`], match)}
              ${this.dateSql(ctx, Prisma.sql`t."updatedAt"`)}`,
          id: Prisma.sql`t.id`,
          title: Prisma.sql`t.title`,
          titleOut: 'title',
          map: (r) => ({
            kind: 'task',
            id: r['id'] as string,
            title: r['title'] as string,
            context: (r['projectName'] as string | null) ?? null,
            href: `/projects/${r['projectId'] as string}?task=${r['id'] as string}`,
            at: r['at'] as Date,
            score: Number(r['score']),
          }),
        };
      }

      case 'project': {
        const fts = FTS.project;
        return {
          base: Prisma.sql`
            SELECT p.id, p.name, p."updatedAt" AS at,
              ${this.score(ctx, fts, Prisma.sql`p.name`, Prisma.sql`p."updatedAt"`, lean)} AS score
            FROM "Project" p
            WHERE p."workspaceId" = ${workspaceId} AND p."deletedAt" IS NULL
              AND ${this.projectVisible(ctx, 'p')}
              AND ${matchSql(fts, [Prisma.sql`p.name`, Prisma.sql`p.description`], match)}`,
          id: Prisma.sql`p.id`,
          title: Prisma.sql`p.name`,
          titleOut: 'name',
          map: (r) => ({
            kind: 'project',
            id: r['id'] as string,
            title: r['name'] as string,
            context: null,
            href: `/projects/${r['id'] as string}`,
            at: r['at'] as Date,
            score: Number(r['score']),
          }),
        };
      }

      case 'lead': {
        const fts = FTS.lead;
        const assignee = ctx.fullLeads ? Prisma.empty : Prisma.sql` AND l."assigneeId" = ${userId}`;
        return {
          base: Prisma.sql`
            SELECT l.id, l.name, l.company, l."updatedAt" AS at,
              ${this.score(ctx, fts, Prisma.sql`l.name`, Prisma.sql`l."updatedAt"`, lean)} AS score
            FROM "Lead" l
            WHERE l."workspaceId" = ${workspaceId} AND l."deletedAt" IS NULL${assignee}
              AND ${matchSql(fts, [Prisma.sql`l.name`, Prisma.sql`l.company`, Prisma.sql`l.email`], match)}`,
          id: Prisma.sql`l.id`,
          title: Prisma.sql`l.name`,
          titleOut: 'name',
          map: (r) => ({
            kind: 'lead',
            id: r['id'] as string,
            title: r['name'] as string,
            context: (r['company'] as string | null) ?? null,
            href: `/leads?lead=${r['id'] as string}`,
            at: r['at'] as Date,
            score: Number(r['score']),
          }),
        };
      }

      case 'client': {
        const fts = FTS.client;
        // clientVisibleWhere: full sales or finance sees every client.
        const assignee = ctx.allClients
          ? Prisma.empty
          : Prisma.sql` AND c."assigneeId" = ${userId}`;
        return {
          base: Prisma.sql`
            SELECT c.id, c.name, c."updatedAt" AS at,
              ${this.score(ctx, fts, Prisma.sql`c.name`, Prisma.sql`c."updatedAt"`, lean)} AS score
            FROM "Client" c
            WHERE c."workspaceId" = ${workspaceId} AND c."deletedAt" IS NULL${assignee}
              AND ${matchSql(fts, [Prisma.sql`c.name`, Prisma.sql`c.email`], match)}`,
          id: Prisma.sql`c.id`,
          title: Prisma.sql`c.name`,
          titleOut: 'name',
          map: (r) => ({
            kind: 'client',
            id: r['id'] as string,
            title: r['name'] as string,
            context: null,
            href: `/clients/${r['id'] as string}`,
            at: r['at'] as Date,
            score: Number(r['score']),
          }),
        };
      }

      case 'document': {
        const fts = FTS.document;
        // DocumentsService.list: admins see all; others their own or shared.
        // A document shared with someone can sit under a PRIVATE project they
        // can't see, so its project label is visibility-gated too (as
        // client-documents.service does with canSeeProject).
        const access = ctx.isWorkspaceAdmin
          ? Prisma.empty
          : Prisma.sql` AND (d."createdById" = ${userId} OR EXISTS (SELECT 1 FROM "DocumentAccess" da WHERE da."documentId" = d.id AND da."userId" = ${userId}))`;
        return {
          base: Prisma.sql`
            SELECT d.id, d.title, d."updatedAt" AS at,
              ${lean ? Prisma.sql`NULL` : Prisma.sql`d."contentText"`} AS "contentText",
              (SELECT pn.name FROM "Project" pn WHERE pn.id = d."projectId" AND pn."deletedAt" IS NULL AND ${this.projectVisible(ctx, 'pn')}) AS "projectName",
              ${this.score(ctx, fts, Prisma.sql`d.title`, Prisma.sql`d."updatedAt"`, lean)} AS score
            FROM "Document" d
            WHERE d."workspaceId" = ${workspaceId} AND d."deletedAt" IS NULL${access}
              AND ${matchSql(fts, [Prisma.sql`d.title`, Prisma.sql`d."contentText"`], match)}
              ${this.dateSql(ctx, Prisma.sql`d."updatedAt"`)}`,
          id: Prisma.sql`d.id`,
          title: Prisma.sql`d.title`,
          titleOut: 'title',
          map: (r) => ({
            kind: 'document',
            id: r['id'] as string,
            title: r['title'] as string,
            context: (r['projectName'] as string | null) ?? null,
            href: `/documents?doc=${r['id'] as string}`,
            snippet: lean ? null : snippetAround(r['contentText'] as string | null, tokens),
            at: r['at'] as Date,
            score: Number(r['score']),
          }),
        };
      }

      case 'chat_message': {
        const rooms = await this.chatRooms(ctx);
        if (rooms.length === 0) return null;
        const fts = FTS.message;
        const markers = Prisma.join(
          MARKER_PREFIXES.map((p) => Prisma.sql`starts_with(coalesce(m.content, ''), ${p})`),
          ' OR ',
        );
        const from = ctx.fromUserId
          ? Prisma.sql` AND m."senderId" = ${ctx.fromUserId}`
          : Prisma.empty;
        const has =
          ctx.has === 'file'
            ? Prisma.sql` AND EXISTS (SELECT 1 FROM "ChatRoomAttachment" a WHERE a."messageId" = m.id)`
            : ctx.has === 'link'
              ? Prisma.sql` AND m.content ~* 'https?://'`
              : Prisma.empty;
        return {
          base: Prisma.sql`
            SELECT m.id, ${lean ? Prisma.sql`NULL` : Prisma.sql`m.content`} AS content, m."roomId", m."createdAt" AS at,
              (SELECT r.name FROM "ChatRoom" r WHERE r.id = m."roomId") AS "roomName",
              (SELECT r.type::text FROM "ChatRoom" r WHERE r.id = m."roomId") AS "roomType",
              (SELECT u.name FROM "User" u WHERE u.id = m."senderId") AS "senderName",
              (SELECT u.email FROM "User" u WHERE u.id = m."senderId") AS "senderEmail",
              ${this.score(ctx, fts, null, Prisma.sql`m."createdAt"`, lean)} AS score
            FROM "ChatRoomMessage" m
            WHERE m."roomId" = ANY(${rooms}) AND m."deletedAt" IS NULL
              AND NOT (${markers})
              AND ${matchSql(fts, [Prisma.sql`m.content`], match)}${from}${has}
              ${this.dateSql(ctx, Prisma.sql`m."createdAt"`)}`,
          id: Prisma.sql`m.id`,
          title: null,
          titleOut: null,
          map: (r) => {
            const content = (r['content'] as string | null) ?? '';
            const flat = content.replace(/\s+/g, ' ').trim();
            return {
              kind: 'chat_message',
              id: r['id'] as string,
              title: flat.length > 80 ? `${flat.slice(0, 80)}...` : flat || '(message)',
              context: roomLabel(r['roomName'] as string | null, r['roomType'] as string | null),
              href: `/chat/${r['roomId'] as string}?msg=${r['id'] as string}`,
              snippet: lean ? null : snippetAround(content, tokens, 90),
              actorName: actorName(r),
              at: r['at'] as Date,
              score: Number(r['score']),
            };
          },
        };
      }

      case 'file': {
        const rooms = await this.chatRooms(ctx);
        if (rooms.length === 0) return null;
        const fts = FTS.chatFile;
        const from = ctx.fromUserId
          ? Prisma.sql` AND m."senderId" = ${ctx.fromUserId}`
          : Prisma.empty;
        // The message join only contributes columns ChatRoomAttachment does not
        // have, so the unqualified "fileName" in FTS.chatFile stays unambiguous.
        return {
          base: Prisma.sql`
            SELECT a.id, a."fileName", m.id AS "messageId", m."roomId", m."createdAt" AS at,
              (SELECT r.name FROM "ChatRoom" r WHERE r.id = m."roomId") AS "roomName",
              (SELECT u.name FROM "User" u WHERE u.id = m."senderId") AS "senderName",
              (SELECT u.email FROM "User" u WHERE u.id = m."senderId") AS "senderEmail",
              ${this.score(ctx, fts, Prisma.sql`a."fileName"`, Prisma.sql`m."createdAt"`, lean)} AS score
            FROM "ChatRoomAttachment" a
            JOIN "ChatRoomMessage" m ON m.id = a."messageId"
            WHERE m."roomId" = ANY(${rooms}) AND m."deletedAt" IS NULL
              AND ${matchSql(fts, [Prisma.sql`a."fileName"`], match)}${from}
              ${this.dateSql(ctx, Prisma.sql`m."createdAt"`)}`,
          id: Prisma.sql`a.id`,
          title: Prisma.sql`a."fileName"`,
          titleOut: 'fileName',
          map: (r) => ({
            kind: 'file',
            id: r['id'] as string,
            title: r['fileName'] as string,
            context: roomLabel(r['roomName'] as string | null, null),
            href: `/chat/${r['roomId'] as string}?msg=${r['messageId'] as string}`,
            actorName: actorName(r),
            at: r['at'] as Date,
            score: Number(r['score']),
          }),
        };
      }

      case 'workspace_file': {
        // Files the caller uploaded, or files attached to live comments on live
        // tasks in live projects they can see. Receipts and other private
        // uploads stay out. Signature artifacts (a signer's image, the frozen
        // and sealed PDFs) are served through their signature request, which
        // checks document access; they are not loose files to find.
        const fts = FTS.file;
        const viaTask = Prisma.sql`
          FROM "CommentAttachment" ca
          JOIN "Comment" cm ON cm.id = ca."commentId"
          JOIN "Task" tk ON tk.id = cm."taskId"
          JOIN "Project" p ON p.id = tk."projectId"
          WHERE ca."fileObjectId" = f.id
            AND cm."deletedAt" IS NULL AND tk."deletedAt" IS NULL AND p."deletedAt" IS NULL
            AND p."workspaceId" = ${workspaceId} AND ${this.projectVisible(ctx, 'p')}`;
        const from = ctx.fromUserId
          ? Prisma.sql` AND f."uploadedById" = ${ctx.fromUserId}`
          : Prisma.empty;
        return {
          base: Prisma.sql`
            SELECT f.id, f.filename, f.url, f."createdAt" AS at,
              (SELECT u.name FROM "User" u WHERE u.id = f."uploadedById") AS "senderName",
              (SELECT u.email FROM "User" u WHERE u.id = f."uploadedById") AS "senderEmail",
              (SELECT json_build_object('id', tk.id, 'projectId', tk."projectId", 'title', tk.title) ${viaTask} LIMIT 1) AS task,
              ${this.score(ctx, fts, Prisma.sql`f.filename`, Prisma.sql`f."createdAt"`, lean)} AS score
            FROM "FileObject" f
            WHERE f."workspaceId" = ${workspaceId} AND f."deletedAt" IS NULL
              AND NOT EXISTS (SELECT 1 FROM "SignatureSigner" ss WHERE ss."signatureFileId" = f.id)
              AND NOT EXISTS (SELECT 1 FROM "SignatureRequest" sr WHERE sr."sourceFileId" = f.id)
              AND NOT EXISTS (SELECT 1 FROM "SignatureRequest" sr WHERE sr."signedFileId" = f.id)
              AND (f."uploadedById" = ${userId} OR EXISTS (SELECT 1 ${viaTask}))
              AND ${matchSql(fts, [Prisma.sql`f.filename`], match)}${from}
              ${this.dateSql(ctx, Prisma.sql`f."createdAt"`)}`,
          id: Prisma.sql`f.id`,
          title: Prisma.sql`f.filename`,
          titleOut: 'filename',
          map: (r) => {
            const task = r['task'] as { id: string; projectId: string; title: string } | null;
            return {
              kind: 'workspace_file',
              id: r['id'] as string,
              title: r['filename'] as string,
              context: task ? task.title : null,
              href: task
                ? `/projects/${task.projectId}?task=${task.id}`
                : ((r['url'] as string | null) ?? '#'),
              actorName: actorName(r),
              at: r['at'] as Date,
              score: Number(r['score']),
            };
          },
        };
      }

      default:
        return undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Prisma kinds (small tables or per-user data; trigram ILIKE is enough)
  // ---------------------------------------------------------------------------

  private async searchRooms(ctx: Ctx, page: Page): Promise<Scored[]> {
    const { userId, term } = ctx;
    if (!term) return [];
    const t = insensitive(term);
    const rows = await this.prisma.client.chatRoom.findMany({
      where: {
        deletedAt: null,
        participants: { some: { userId } },
        // Same organization pin as chat messages.
        OR: [
          { workspaceId: null },
          ...(ctx.organizationId
            ? [{ workspace: { organizationId: ctx.organizationId, deletedAt: null } }]
            : []),
        ],
        AND: [
          {
            OR: [
              { name: t },
              {
                participants: {
                  some: {
                    userId: { not: userId },
                    user: { OR: [{ name: t }, { email: t }] },
                  },
                },
              },
            ],
          },
          // `-word`: drop rooms whose name, or another participant's name or
          // email, contains it (the same fields the text matches on). The name
          // check is NULL-safe so unnamed rooms (DMs) aren't dropped by it.
          ...ctx.negWords.flatMap((w) => [
            { OR: [{ name: null }, { NOT: { name: insensitive(w) } }] },
            {
              NOT: {
                participants: {
                  some: {
                    userId: { not: userId },
                    user: { OR: [{ name: insensitive(w) }, { email: insensitive(w) }] },
                  },
                },
              },
            },
          ]),
        ],
      },
      select: {
        id: true,
        name: true,
        type: true,
        updatedAt: true,
        participants: {
          where: { userId: { not: userId } },
          select: { user: { select: { name: true, email: true } } },
          take: 3,
        },
      },
      orderBy: { updatedAt: 'desc' },
      skip: page.skip,
      take: page.take,
    });
    return rows.map((r) => {
      const others = r.participants
        .map((p) => p.user.name?.trim() || p.user.email)
        .filter((n): n is string => Boolean(n));
      const title = r.name?.trim() || (others.length > 0 ? others.join(', ') : 'Direct message');
      return {
        kind: 'chat_room' as const,
        id: r.id,
        title,
        context: roomTypeLabel(r.type),
        href: `/chat/${r.id}`,
        at: r.updatedAt,
        score: scoreInJs(title, r.updatedAt, ctx.match),
      };
    });
  }

  private async searchPeople(ctx: Ctx, page: Page): Promise<Scored[]> {
    if (!ctx.term) return [];
    const t = insensitive(ctx.term);
    const rows = await this.prisma.client.user.findMany({
      where: {
        workspaceMemberships: { some: { workspaceId: ctx.workspaceId } },
        OR: [{ name: t }, { email: t }],
        // `-word`: drop people whose name or email contains it.
        ...(ctx.negWords.length > 0
          ? {
              NOT: ctx.negWords.flatMap((w) => [
                { name: insensitive(w) },
                { email: insensitive(w) },
              ]),
            }
          : {}),
      },
      select: { id: true, name: true, email: true },
      orderBy: { name: 'asc' },
      skip: page.skip,
      take: page.take,
    });
    return rows.map((u) => {
      const title = u.name?.trim() || u.email;
      return {
        kind: 'person' as const,
        id: u.id,
        title,
        context: u.email,
        href: `/chat?dm=${u.id}`,
        // People have no date; rank them as if fresh so an exact name match leads.
        score: scoreInJs(title, new Date(), ctx.match),
      };
    });
  }

  private async searchMail(ctx: Ctx, page: Page, lean: boolean): Promise<Scored[]> {
    // Only `-excluded` words typed: nothing positive to look for.
    if (ctx.match && !ctx.term) return [];
    const t = insensitive(ctx.term);
    const rows = await this.prisma.client.mailMessage.findMany({
      where: {
        // The caller's own mailboxes only. Mail is personal even from admins.
        account: { userId: ctx.userId, deletedAt: null },
        isDeleted: false,
        // A filter-only search (has:file, a date) has no text to match.
        ...(ctx.term
          ? { OR: [{ subject: t }, { fromAddress: t }, { fromName: t }, { bodyTextPreview: t }] }
          : {}),
        ...(ctx.has === 'file' ? { hasAttachments: true } : {}),
        AND: [
          ...(ctx.has === 'link'
            ? [
                {
                  OR: [
                    { bodyTextPreview: { contains: 'http://' } },
                    { bodyTextPreview: { contains: 'https://' } },
                  ],
                },
              ]
            : []),
          // `-word`: drop mail containing it in any field the text matches on.
          // fromName is nullable, and NOT over a NULL would drop the row too.
          ...ctx.negWords.map((w) => ({
            NOT: [
              { subject: insensitive(w) },
              { fromAddress: insensitive(w) },
              { bodyTextPreview: insensitive(w) },
            ],
            OR: [{ fromName: null }, { NOT: { fromName: insensitive(w) } }],
          })),
        ],
        ...(ctx.createdAt ? { receivedAt: ctx.createdAt } : {}),
      },
      select: {
        id: true,
        subject: true,
        fromName: true,
        fromAddress: true,
        receivedAt: true,
        bodyTextPreview: true,
        folder: { select: { name: true } },
      },
      orderBy: { receivedAt: 'desc' },
      skip: page.skip,
      take: page.take,
    });
    const tokens = ctx.match?.tokens ?? [];
    return rows.map((m) => {
      const title = m.subject?.trim() || '(no subject)';
      return {
        kind: 'mail' as const,
        id: m.id,
        title,
        context: m.folder.name,
        href: `/mail?msg=${m.id}`,
        snippet: lean ? null : snippetAround(m.bodyTextPreview, tokens, 90),
        actorName: m.fromName?.trim() || m.fromAddress,
        at: m.receivedAt,
        score: scoreInJs(title, m.receivedAt, ctx.match),
      };
    });
  }
}

/** Sender / uploader display name from a raw row's `senderName` / `senderEmail`. */
function actorName(r: Record<string, unknown>): string | null {
  const name = (r['senderName'] as string | null)?.trim();
  return name || ((r['senderEmail'] as string | null) ?? null);
}

/** Human label for a room's type, shown as the result's context line. */
function roomTypeLabel(type: string): string {
  switch (type) {
    case 'DM':
      return 'Direct message';
    case 'GROUP':
      return 'Group';
    case 'TEXT_CHANNEL':
      return 'Channel';
    case 'VOICE_CHANNEL':
      return 'Voice channel';
    default:
      return 'Chat';
  }
}

/** Context label for a message/file: the room name, or a type fallback. */
function roomLabel(name: string | null, type: string | null): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;
  return type ? roomTypeLabel(type) : 'Direct message';
}
