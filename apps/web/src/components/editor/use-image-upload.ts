'use client';

import { useCallback } from 'react';
import type { FileObject } from '@botss/shared-types';

import { getApi } from '@/lib/api';

export interface UploadedImage {
  src: string;
  width: number | null;
  height: number | null;
  file: FileObject;
}

/**
 * Three-step image upload: presign → direct PUT to S3-compatible storage →
 * confirm, via `files.upload` in the api-client.
 */
export function useImageUpload() {
  return useCallback(async (file: File): Promise<UploadedImage> => {
    if (!file.type.startsWith('image/')) {
      throw new Error('Only image files can be uploaded here.');
    }

    // Measure intrinsic dimensions client-side so the confirm row carries
    // width/height - useful for the gallery view later and for letting the
    // browser reserve space without a layout shift.
    const dims = await readImageDimensions(file);

    const confirmed = await getApi().files.upload(file, {
      kind: 'IMAGE',
      width: dims.width,
      height: dims.height,
    });

    if (!confirmed.url) {
      throw new Error('Storage did not return a public URL for the uploaded image.');
    }

    return {
      src: confirmed.url,
      width: dims.width,
      height: dims.height,
      file: confirmed,
    };
  }, []);
}

function readImageDimensions(file: File): Promise<{ width: number | null; height: number | null }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new window.Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      // Non-fatal - confirm payload tolerates missing dimensions.
      resolve({ width: null, height: null });
    };
    img.src = url;
  });
}
