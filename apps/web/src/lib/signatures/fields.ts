import type { SignatureFieldKind } from '@botss/shared-types';

/**
 * Field geometry on the client. Every value is a fraction (0..1) of the page
 * as displayed, origin top-left: the same space the API stores and stamps.
 * Pure functions only, so the components stay presentational.
 */

export interface FieldBox {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DraftField extends FieldBox {
  /** Local key for React lists and drag state. */
  key: string;
  kind: SignatureFieldKind;
  /** Owner of the field, by signer id (request dialog) or 'me' (signer page). */
  signerId: string;
}

/** Default box sizes, as fractions of an A4 portrait page's width/height. */
export const DEFAULT_SIZE: Record<SignatureFieldKind, { w: number; h: number }> = {
  SIGNATURE: { w: 0.3, h: 0.06 },
  DATE: { w: 0.2, h: 0.03 },
};

const MIN_W = 0.04;
const MIN_H = 0.015;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Keep a box inside its page and above the minimum size. */
export function clampBox<T extends FieldBox>(f: T): T {
  const w = clamp(f.w, MIN_W, 1);
  const h = clamp(f.h, MIN_H, 1);
  return { ...f, w, h, x: clamp(f.x, 0, 1 - w), y: clamp(f.y, 0, 1 - h) };
}

/** A new box of `kind` centred on a point given in page fractions. */
export function boxAt(kind: SignatureFieldKind, page: number, cx: number, cy: number): FieldBox {
  const { w, h } = DEFAULT_SIZE[kind];
  return clampBox({ page, x: cx - w / 2, y: cy - h / 2, w, h });
}


export function moveBy<T extends FieldBox>(f: T, dx: number, dy: number): T {
  return clampBox({ ...f, x: f.x + dx, y: f.y + dy });
}

/** Resize from the bottom-right corner. */
export function resizeBy<T extends FieldBox>(f: T, dw: number, dh: number): T {
  return clampBox({ ...f, w: Math.min(f.w + dw, 1 - f.x), h: Math.min(f.h + dh, 1 - f.y) });
}

let counter = 0;
export function fieldKey(): string {
  counter += 1;
  return `f${Date.now().toString(36)}${counter}`;
}

/** Colours that tell signers' fields apart in the request dialog. */
export const SIGNER_COLORS = ['#4f46e5', '#0891b2', '#c026d3', '#ea580c', '#16a34a', '#dc2626'];

export function signerColor(index: number): string {
  return SIGNER_COLORS[index % SIGNER_COLORS.length]!;
}
