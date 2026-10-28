'use client';

/**
 * Turn a typed name into the PNG that gets stamped on the PDF, so the sealed
 * document shows exactly what the signer previewed. Uses a script-looking
 * system font stack (no web font fetch; the page CSP allows only self).
 */
export const TYPED_SIGNATURE_FONT =
  '"Segoe Script", "Brush Script MT", "Lucida Handwriting", "Apple Chancery", "Snell Roundhand", cursive';

export function typedSignaturePng(name: string): string {
  const text = name.trim();
  const fontSize = 64;
  const canvas = document.createElement('canvas');
  const measure = canvas.getContext('2d');
  if (!measure) throw new Error('Canvas is not available');
  measure.font = `italic ${fontSize}px ${TYPED_SIGNATURE_FONT}`;
  const width = Math.ceil(measure.measureText(text).width) + 40;
  canvas.width = Math.min(Math.max(width, 200), 1600);
  canvas.height = Math.round(fontSize * 1.6);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = `italic ${fontSize}px ${TYPED_SIGNATURE_FONT}`;
  ctx.fillStyle = '#0f1f5c';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, 20, Math.round(fontSize * 1.15), canvas.width - 40);
  return canvas.toDataURL('image/png');
}

/**
 * Crop a drawn signature to its ink so it fills the field instead of sitting
 * small in a corner of the pad. Returns null when the pad is empty.
 */
export function trimmedCanvasPng(source: HTMLCanvasElement): string | null {
  const ctx = source.getContext('2d');
  if (!ctx) return null;
  const { width, height } = source;
  const data = ctx.getImageData(0, 0, width, height).data;
  let top = height;
  let left = width;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! > 8) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < 0) return null;
  const pad = 8;
  left = Math.max(0, left - pad);
  top = Math.max(0, top - pad);
  right = Math.min(width - 1, right + pad);
  bottom = Math.min(height - 1, bottom + pad);
  const out = document.createElement('canvas');
  out.width = right - left + 1;
  out.height = bottom - top + 1;
  out
    .getContext('2d')
    ?.drawImage(source, left, top, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}
