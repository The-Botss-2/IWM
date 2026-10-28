/**
 * Page geometry for stamping signatures. Pure functions, no pdf-lib types, so
 * `scripts/check-signature-geometry.ts` can verify them without a PDF.
 *
 * Fields are stored as fractions (0..1) of the page AS DISPLAYED (pdf.js
 * applies the page's /Rotate and crop box when rendering), with the origin at
 * the top-left. PDF user space has its origin at the bottom-left of the
 * UNROTATED page. These helpers map one to the other.
 */

export interface Box {
  /** Crop box in user space. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FieldFractions {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Normalise a /Rotate value to 0, 90, 180 or 270. */
export function normaliseRotation(angle: number): 0 | 90 | 180 | 270 {
  const r = (((Math.round(angle / 90) * 90) % 360) + 360) % 360;
  return r as 0 | 90 | 180 | 270;
}

/** Width and height of the page as a viewer shows it. */
export function displaySize(box: Box, rotation: number): { width: number; height: number } {
  const r = normaliseRotation(rotation);
  return r === 90 || r === 270
    ? { width: box.height, height: box.width }
    : { width: box.width, height: box.height };
}

/**
 * Map a point in display space (points, origin top-left) to PDF user space
 * (origin bottom-left of the unrotated page, offset by the crop box).
 */
export function displayToUser(
  box: Box,
  rotation: number,
  dx: number,
  dy: number,
): { x: number; y: number } {
  const r = normaliseRotation(rotation);
  const W = box.width;
  const H = box.height;
  let ux: number;
  let uy: number;
  switch (r) {
    case 0:
      ux = dx;
      uy = H - dy;
      break;
    case 90:
      ux = dy;
      uy = dx;
      break;
    case 180:
      ux = W - dx;
      uy = dy;
      break;
    case 270:
      ux = W - dy;
      uy = H - dx;
      break;
  }
  return { x: box.x + ux, y: box.y + uy };
}

/** Largest rectangle with the image's aspect ratio that fits in the box,
 *  centred horizontally and sitting on the box's bottom edge (signatures
 *  read best resting on the line). */
export function fitInside(
  imgW: number,
  imgH: number,
  boxW: number,
  boxH: number,
): { x: number; y: number; width: number; height: number } {
  if (imgW <= 0 || imgH <= 0) return { x: 0, y: 0, width: boxW, height: boxH };
  const scale = Math.min(boxW / imgW, boxH / imgH);
  const width = imgW * scale;
  const height = imgH * scale;
  return { x: (boxW - width) / 2, y: boxH - height, width, height };
}

/**
 * Where to draw an image (or a line of text) whose display-space rectangle is
 * `rect` (points, origin top-left): the pdf-lib origin for `drawImage` and the
 * rotation, in degrees counter-clockwise, that makes it upright on screen.
 */
export function placement(
  box: Box,
  rotation: number,
  rect: { x: number; y: number; width: number; height: number },
): { x: number; y: number; rotate: number } {
  const r = normaliseRotation(rotation);
  // The drawn object's own bottom-left corner, in display space.
  const origin = displayToUser(box, r, rect.x, rect.y + rect.height);
  return { x: origin.x, y: origin.y, rotate: r };
}

/** Field fractions to a display-space rectangle in points. */
export function fieldRect(
  box: Box,
  rotation: number,
  f: FieldFractions,
): { x: number; y: number; width: number; height: number } {
  const size = displaySize(box, rotation);
  return {
    x: f.x * size.width,
    y: f.y * size.height,
    width: f.w * size.width,
    height: f.h * size.height,
  };
}
