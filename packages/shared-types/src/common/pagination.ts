import { z } from 'zod';

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  // Cap is 1000: the largest callers are the dashboard widgets that
  // aggregate over a workspace's task / lead set in one query
  // (completion-chart, lead-funnel, use-workspace-task-stats all request
  // exactly 1000). Real paginated UIs request 20–500 - this ceiling is a
  // safety rail against one request materialising a whole table, not a
  // typical page size. Raise it only together with a caller that needs it.
  pageSize: z.coerce.number().int().positive().max(1000).default(20),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const paginationMetaSchema = z.object({
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
});
export type PaginationMeta = z.infer<typeof paginationMetaSchema>;

export const listResponseSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    pagination: paginationMetaSchema,
  });

export type ListResponse<T> = {
  items: T[];
  pagination: PaginationMeta;
};

export const sortOrderSchema = z.enum(['asc', 'desc']).default('desc');
export type SortOrder = z.infer<typeof sortOrderSchema>;
