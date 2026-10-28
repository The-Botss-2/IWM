import { z } from 'zod';

import { cuid } from './common/id.js';
import { paginationQuerySchema, sortOrderSchema } from './common/pagination.js';
import { FileKind } from './enums.js';

export const fileObjectSchema = z.object({
  id: cuid,
  workspaceId: cuid,
  uploadedById: cuid,
  bucket: z.string(),
  objectKey: z.string(),
  url: z.string().url().nullable(),
  filename: z.string(),
  mimeType: z.string(),
  /** BigInt comes back as string from JSON to preserve precision. */
  sizeBytes: z.string(),
  kind: FileKind,
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  checksum: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  deletedAt: z.coerce.date().nullable(),
});
export type FileObject = z.infer<typeof fileObjectSchema>;

/**
 * Files are served back from S3/MinIO with their declared Content-Type, so a
 * file that renders as an active document (HTML, SVG, JS) would run in the
 * bucket-host origin if served inline - stored XSS. We no longer BLOCK
 * uploads (chat allows any file type, WhatsApp-style). Instead we contain the
 * risk in two layers, both keyed off the classifiers below so the API and the
 * web client agree on what "risky" means:
 *   1. The API serves only SAFE raster images inline; everything else
 *      (incl. svg/html/exe) is forced to download via
 *      `Content-Disposition: attachment` - see `isSafeInlineImage`. A
 *      downloaded HTML/SVG cannot execute in our origin.
 *   2. The web client warns the user before opening a risky type - see
 *      `isRiskyFile`.
 */
const RISKY_FILE_EXTENSIONS = new Set([
  'html',
  'htm',
  'xhtml',
  'xml',
  'xsl',
  'xslt',
  'svg',
  'svgz',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'wasm',
  'exe',
  'dll',
  'bat',
  'cmd',
  'com',
  'scr',
  'ps1',
  'sh',
  'bash',
  'jar',
  'msi',
  'apk',
  'app',
  'deb',
  'dmg',
]);

const RISKY_FILE_MIME_PREFIXES = [
  'text/html',
  'application/xhtml',
  'image/svg',
  'application/javascript',
  'text/javascript',
  'application/x-msdownload',
  'application/x-executable',
  'application/x-sh',
  'application/vnd.microsoft.portable-executable',
];

/** Raster image types we trust to render inline. Deliberately excludes SVG,
 *  which is an XML document that can carry script. */
const SAFE_INLINE_IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/avif',
  'image/heic',
  'image/heif',
]);

/** Last extension (defeats `safe.png.html` polyglot tricks). */
function fileExtension(filename: string): string | null {
  const dot = filename.lastIndexOf('.');
  if (dot === -1 || dot === filename.length - 1) return null;
  return filename.slice(dot + 1).toLowerCase();
}

/**
 * True for files that could execute as script in the browser origin
 * (HTML/SVG/JS) or as native code (exe/sh/...). The UI shows a "this file may
 * be harmful" warning before opening one. Matches on EITHER extension or MIME
 * so a relabelled file is still caught.
 */
export function isRiskyFile(filename: string, mimeType: string): boolean {
  const ext = fileExtension(filename);
  if (ext && RISKY_FILE_EXTENSIONS.has(ext)) return true;
  const m = (mimeType ?? '').trim().toLowerCase();
  return RISKY_FILE_MIME_PREFIXES.some(
    (p) => m === p || m.startsWith(p + ';') || m.startsWith(p + '+'),
  );
}

/** True only for raster image types safe to serve with `inline` disposition. */
export function isSafeInlineImage(mimeType: string): boolean {
  return SAFE_INLINE_IMAGE_MIME.has((mimeType ?? '').trim().toLowerCase());
}

/** Step 1 of the upload flow: ask the API for a presigned PUT URL. All file
 *  types are permitted; risky ones are contained at serve time (forced
 *  download) and surfaced with a warning in the UI. */
export const presignUploadSchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive(),
  kind: FileKind.optional(),
});
export type PresignUploadInput = z.infer<typeof presignUploadSchema>;

export const presignUploadResponseSchema = z.object({
  uploadUrl: z.string().url(),
  /** The S3 key where the client should PUT bytes. */
  objectKey: z.string(),
  /** The bucket the API expects the bytes to land in. */
  bucket: z.string(),
  /** Headers the client must echo on PUT. */
  headers: z.record(z.string()),
  /** Expiry of the presigned URL (UTC). */
  expiresAt: z.coerce.date(),
});
export type PresignUploadResponse = z.infer<typeof presignUploadResponseSchema>;

/** Step 2: confirm the upload landed and the API records FileObject metadata. */
export const confirmUploadSchema = z.object({
  bucket: z.string(),
  objectKey: z.string(),
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive(),
  kind: FileKind.optional(),
  checksum: z.string().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  durationMs: z.number().int().optional(),
});
export type ConfirmUploadInput = z.infer<typeof confirmUploadSchema>;

export const listFilesQuerySchema = paginationQuerySchema.extend({
  kind: FileKind.optional(),
  search: z.string().optional(),
  sort: z.enum(['createdAt', 'filename', 'sizeBytes']).default('createdAt'),
  order: sortOrderSchema,
});
export type ListFilesQuery = z.infer<typeof listFilesQuerySchema>;
