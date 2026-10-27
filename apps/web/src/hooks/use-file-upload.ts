'use client';

import { useMutation } from '@tanstack/react-query';
import type { FileObject } from '@botss/shared-types';

import { getApi } from '@/lib/api';

/**
 * Three-step upload (presign → PUT to object storage → confirm, via
 * `files.upload` in the api-client). Returns the created FileObject on
 * success. Used by mail compose for attachments and by any other surface
 * that needs to push bytes through the standard files pipeline.
 */
export function useFileUpload() {
  return useMutation({
    meta: { errorTitle: "Couldn't upload file" },
    mutationFn: (file: File): Promise<FileObject> => getApi().files.upload(file),
  });
}
