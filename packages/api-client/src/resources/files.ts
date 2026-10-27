import {
  type ConfirmUploadInput,
  type FileKind,
  type FileObject,
  fileObjectSchema,
  type PresignUploadInput,
  type PresignUploadResponse,
  presignUploadResponseSchema,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

export interface UploadFileOptions {
  /** FileObject kind recorded on presign + confirm (e.g. `IMAGE`). */
  kind?: FileKind;
  /** Aborts the byte transfer; the rejection is the fetch `AbortError`. */
  signal?: AbortSignal;
  /** Intrinsic image dimensions to record on the FileObject, if known. */
  width?: number | null;
  height?: number | null;
}

export class FilesResource {
  constructor(private readonly http: HttpClient) {}

  get(id: string) {
    return this.http.get(`/files/${id}`, fileObjectSchema);
  }
  presign(input: PresignUploadInput): Promise<PresignUploadResponse> {
    return this.http.post('/files/presign', presignUploadResponseSchema, input);
  }
  confirm(input: ConfirmUploadInput): Promise<FileObject> {
    return this.http.post('/files/confirm', fileObjectSchema, input);
  }

  /**
   * Fetch the bytes behind a stored file's public URL (object storage, not
   * the API) - e.g. to hand them to a native "save file" bridge.
   */
  fetchBytes(url: string): Promise<Blob> {
    return this.http.getAbsoluteBlob(url);
  }

  /**
   * The full three-step upload: presign -> PUT bytes straight to object
   * storage -> confirm. Returns the recorded FileObject.
   */
  async upload(file: File, opts: UploadFileOptions = {}): Promise<FileObject> {
    const mimeType = file.type || 'application/octet-stream';
    const kind = opts.kind ? { kind: opts.kind } : {};
    const presigned = await this.presign({
      filename: file.name,
      mimeType,
      sizeBytes: file.size,
      ...kind,
    });
    await this.http.putPresigned(presigned.uploadUrl, file, {
      headers: presigned.headers,
      signal: opts.signal,
    });
    return this.confirm({
      bucket: presigned.bucket,
      objectKey: presigned.objectKey,
      filename: file.name,
      mimeType,
      sizeBytes: file.size,
      ...kind,
      ...(opts.width != null ? { width: opts.width } : {}),
      ...(opts.height != null ? { height: opts.height } : {}),
    });
  }
}
