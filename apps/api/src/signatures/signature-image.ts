import { BadRequestException } from '@nestjs/common';

/**
 * Validation for the signature PNG a signer submits. Pure, so
 * `scripts/check-signatures.ts` can exercise it without Nest or a database.
 *
 * The byte cap alone is not enough: a PNG of a few KB can declare enormous
 * dimensions, and pdf-lib decodes the whole image to RGBA in memory when the
 * request is sealed. Bounding the IHDR dimensions keeps that decode small.
 * Every legitimate signature stays far below the limits: the pad at a device
 * pixel ratio of 3 is about 1800x530, the typed renderer at most 1600x102.
 */
export const MAX_SIGNATURE_PNG_BYTES = 300 * 1024;
export const MAX_SIGNATURE_WIDTH = 4000;
export const MAX_SIGNATURE_HEIGHT = 2000;
export const MAX_SIGNATURE_PIXELS = 4_000_000;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function invalidImage(): BadRequestException {
  return new BadRequestException({
    title: 'Invalid signature image',
    status: 400,
    detail: 'The signature must be a PNG image.',
  });
}

/** Decode a `data:image/png;base64,` URL and check it is a sane PNG. */
export function decodeSignaturePng(dataUrl: string): Buffer {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.byteLength > MAX_SIGNATURE_PNG_BYTES) {
    throw new BadRequestException({
      title: 'Signature image too large',
      status: 400,
      detail: 'Clear the pad and sign again.',
    });
  }
  // 8 magic + 4 length + 4 "IHDR" + 13 header data + 4 CRC, plus at least an
  // IDAT and IEND chunk after it.
  if (bytes.byteLength < 67 || !bytes.subarray(0, 8).equals(PNG_MAGIC)) throw invalidImage();
  if (bytes.subarray(12, 16).toString('latin1') !== 'IHDR') throw invalidImage();
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (
    width === 0 ||
    height === 0 ||
    width > MAX_SIGNATURE_WIDTH ||
    height > MAX_SIGNATURE_HEIGHT ||
    width * height > MAX_SIGNATURE_PIXELS
  ) {
    throw invalidImage();
  }
  return bytes;
}
