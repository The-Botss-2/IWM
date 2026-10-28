'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Comment,
  CommentListResponse,
  CreateCommentInput,
  UpdateCommentInput,
} from '@botss/shared-types';

import { getApi } from '@/lib/api';
import { toastError } from '@/lib/toast';

const commentsKey = (taskId: string) => ['comments', taskId] as const;

export function useTaskComments(taskId: string | null | undefined) {
  return useQuery({
    queryKey: commentsKey(taskId ?? '__none__'),
    queryFn: () => getApi().comments.list(taskId as string, { limit: 50 }),
    enabled: !!taskId,
    staleTime: 30_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

interface OptimisticAuthor {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

/** Build a transient comment row that looks like the server response so the UI
 *  can render the bubble before the network round-trip completes. */
function buildOptimisticComment(
  taskId: string,
  tempId: string,
  author: OptimisticAuthor,
  input: CreateCommentInput,
): Comment {
  const now = new Date();
  return {
    id: tempId,
    taskId,
    authorId: author.id,
    content: input.content,
    contentText: input.contentText,
    editedAt: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    author,
    // Attachments aren't optimistically displayed - the composer's inline
    // images already render via objectURL in the Tiptap node. Server returns
    // the canonical list on success.
    attachments: [],
  };
}

export function useCreateComment(taskId: string, author: OptimisticAuthor) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCommentInput) => getApi().comments.create(taskId, input),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: commentsKey(taskId) });
      const previous = qc.getQueryData<CommentListResponse>(commentsKey(taskId));
      const tempId = `tmp_${Date.now()}`;
      const optimistic = buildOptimisticComment(taskId, tempId, author, input);
      qc.setQueryData<CommentListResponse>(commentsKey(taskId), (curr) => ({
        items: [...(curr?.items ?? []), optimistic],
        nextCursor: curr?.nextCursor ?? null,
      }));
      return { previous, tempId };
    },
    onSuccess: (server, _input, ctx) => {
      qc.setQueryData<CommentListResponse>(commentsKey(taskId), (curr) => {
        if (!curr) return { items: [server], nextCursor: null };
        return {
          ...curr,
          items: curr.items.map((c) => (c.id === ctx?.tempId ? server : c)),
        };
      });
    },
    onError: (err, _input, ctx) => {
      if (ctx?.previous) qc.setQueryData(commentsKey(taskId), ctx.previous);
      toastError(err, "Couldn't post comment");
    },
  });
}

export function useUpdateComment(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateCommentInput }) =>
      getApi().comments.update(id, input),
    onMutate: async ({ id, input }) => {
      await qc.cancelQueries({ queryKey: commentsKey(taskId) });
      const previous = qc.getQueryData<CommentListResponse>(commentsKey(taskId));
      qc.setQueryData<CommentListResponse>(commentsKey(taskId), (curr) => {
        if (!curr) return curr;
        return {
          ...curr,
          items: curr.items.map((c) =>
            c.id === id
              ? {
                  ...c,
                  content: input.content,
                  contentText: input.contentText,
                  editedAt: new Date(),
                  updatedAt: new Date(),
                }
              : c,
          ),
        };
      });
      return { previous };
    },
    onSuccess: (server) => {
      qc.setQueryData<CommentListResponse>(commentsKey(taskId), (curr) => {
        if (!curr) return curr;
        return {
          ...curr,
          items: curr.items.map((c) => (c.id === server.id ? server : c)),
        };
      });
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(commentsKey(taskId), ctx.previous);
      toastError(err, "Couldn't update comment");
    },
  });
}

export function useDeleteComment(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApi().comments.remove(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: commentsKey(taskId) });
      const previous = qc.getQueryData<CommentListResponse>(commentsKey(taskId));
      qc.setQueryData<CommentListResponse>(commentsKey(taskId), (curr) => {
        if (!curr) return curr;
        return { ...curr, items: curr.items.filter((c) => c.id !== id) };
      });
      return { previous };
    },
    onError: (err, _id, ctx) => {
      if (ctx?.previous) qc.setQueryData(commentsKey(taskId), ctx.previous);
      toastError(err, "Couldn't delete comment");
    },
  });
}
