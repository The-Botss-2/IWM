/**
 * E-signature self-checks that need no database, Redis, storage or Gotenberg:
 *
 * 1. Page geometry: a field placed on the page as a viewer shows it lands on
 *    the same spot in PDF user space, for every page rotation and for a crop
 *    box that does not start at the origin.
 * 2. The document-to-HTML serializer never lets stored content inject markup.
 * 3. Signing tokens have the shape the public route accepts, and draft
 *    placeholders can never collide with a real token hash.
 * 4. The shared Zod rules reject what the API must never accept.
 * 5. Signature images: a tiny PNG declaring huge dimensions is refused before
 *    sealing would decode it into memory.
 *
 * Run: pnpm --filter @botss/api test (chained after the invoice template check).
 */
import 'reflect-metadata';

import {
  accessCode,
  createSignatureRequestSchema,
  setSignatureFieldsSchema,
  signingToken,
  signPublicSchema,
} from '@botss/shared-types';

import { printDocument, tiptapToPrintHtml } from '../signatures/document-html';
import {
  displaySize,
  displayToUser,
  fieldRect,
  fitInside,
  normaliseRotation,
  placement,
  type Box,
} from '../signatures/geometry';
import { decodeSignaturePng } from '../signatures/signature-image';
import {
  accessCodeMatches,
  attemptsExhausted,
  hashAccessCode,
  MAX_ACCESS_CODE_ATTEMPTS,
} from '../common/access-code';
import {
  hashSigningToken,
  newSigningCredentials,
  newSigningToken,
  unusableTokenHash,
} from '../signatures/token';

let failures = 0;
const EPS = 1e-6;

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < EPS;
}

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) return;
  failures++;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// 1. Geometry
// ---------------------------------------------------------------------------

const boxes: Box[] = [
  { x: 0, y: 0, width: 595, height: 842 }, // A4, Gotenberg output
  { x: 36, y: 18, width: 540, height: 720 }, // cropped, offset
];

for (const box of boxes) {
  for (const rotation of [0, 90, 180, 270, -90, 450]) {
    const r = normaliseRotation(rotation);
    const size = displaySize(box, rotation);
    const label = `box=${box.x},${box.y},${box.width}x${box.height} rot=${rotation}`;

    // Display corners land on crop-box corners.
    const corners = [
      displayToUser(box, rotation, 0, 0),
      displayToUser(box, rotation, size.width, 0),
      displayToUser(box, rotation, 0, size.height),
      displayToUser(box, rotation, size.width, size.height),
    ];
    for (const c of corners) {
      const onX = near(c.x, box.x) || near(c.x, box.x + box.width);
      const onY = near(c.y, box.y) || near(c.y, box.y + box.height);
      check(`${label} corner`, onX && onY, JSON.stringify(c));
    }

    // Top-left of the displayed page is the visual top-left for rotation 0.
    if (r === 0) {
      const tl = displayToUser(box, 0, 0, 0);
      check(`${label} top-left`, near(tl.x, box.x) && near(tl.y, box.y + box.height));
    }

    // A field flush with the right and bottom edges (x+w = 1, y+h = 1).
    const rect = fieldRect(box, rotation, { x: 0.7, y: 0.9, w: 0.3, h: 0.1 });
    check(
      `${label} edge field`,
      near(rect.x + rect.width, size.width) && near(rect.y + rect.height, size.height),
    );

    // An image drawn at `placement` with pdf-lib's counter-clockwise rotation
    // must cover exactly the displayed rectangle: its width axis ends at the
    // displayed bottom-right corner and its height axis at the top-left.
    const img = { x: 100, y: 200, width: 150, height: 40 };
    const p = placement(box, rotation, img);
    const rad = (p.rotate * Math.PI) / 180;
    const widthEnd = { x: p.x + img.width * Math.cos(rad), y: p.y + img.width * Math.sin(rad) };
    const heightEnd = { x: p.x - img.height * Math.sin(rad), y: p.y + img.height * Math.cos(rad) };
    const wantWidthEnd = displayToUser(box, rotation, img.x + img.width, img.y + img.height);
    const wantHeightEnd = displayToUser(box, rotation, img.x, img.y);
    check(
      `${label} image width axis`,
      near(widthEnd.x, wantWidthEnd.x) && near(widthEnd.y, wantWidthEnd.y),
      `${JSON.stringify(widthEnd)} != ${JSON.stringify(wantWidthEnd)}`,
    );
    check(
      `${label} image height axis`,
      near(heightEnd.x, wantHeightEnd.x) && near(heightEnd.y, wantHeightEnd.y),
      `${JSON.stringify(heightEnd)} != ${JSON.stringify(wantHeightEnd)}`,
    );
  }
}

// fitInside keeps the aspect ratio, stays inside, and rests on the bottom.
{
  const f = fitInside(400, 100, 200, 100);
  check('fit wide', near(f.width, 200) && near(f.height, 50) && near(f.y, 50) && near(f.x, 0));
  const g = fitInside(100, 100, 200, 50);
  check('fit tall', near(g.width, 50) && near(g.height, 50) && near(g.x, 75) && near(g.y, 0));
}

// ---------------------------------------------------------------------------
// 2. Document serializer
// ---------------------------------------------------------------------------

{
  const text = (t: string, marks?: unknown[]) => ({
    type: 'text',
    text: t,
    ...(marks ? { marks } : {}),
  });
  const doc = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 9 }, content: [text('Terms & <Conditions>')] },
      { type: 'paragraph', content: [text('<script>alert(1)</script>')] },
      {
        type: 'paragraph',
        content: [
          text('bad', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]),
          text('good', [{ type: 'link', attrs: { href: 'https://x.test/?a="b"' } }]),
          text('bold', [{ type: 'bold' }, { type: 'unknownMark' }]),
        ],
      },
      {
        type: 'callout',
        attrs: { variant: '"><script>x</script>' },
        content: [{ type: 'paragraph' }],
      },
      { type: 'mention', attrs: { label: '<b>Ann</b>', userId: 'u1' } },
      { type: 'image', attrs: { src: 'https://cdn.test/missing.png' } },
      {
        type: 'image',
        attrs: { src: 'https://cdn.test/ok.png', width: 50, align: 'left', alt: '"x"' },
      },
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableCell',
                attrs: { colspan: '2', rowspan: 'x' },
                content: [{ type: 'paragraph', content: [text('cell')] }],
              },
            ],
          },
        ],
      },
      { type: 'someFutureNode', attrs: { onclick: 'evil()' }, content: [text('kept text')] },
      {
        type: 'orderedList',
        attrs: { start: 3 },
        content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [text('item')] }] }],
      },
    ],
  };
  const images = new Map([['https://cdn.test/ok.png', 'data:image/png;base64,AAAA']]);
  const html = tiptapToPrintHtml(doc, images);

  check('html: no raw script tag', !/<script/i.test(html), html);
  check('html: text escaped', html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  check('html: heading level clamped', html.includes('<h4>Terms &amp; &lt;Conditions&gt;</h4>'));
  check('html: javascript link dropped', !html.includes('javascript:') && html.includes('bad'));
  check(
    'html: https link kept and escaped',
    html.includes('<a href="https://x.test/?a=&quot;b&quot;">good</a>'),
  );
  check('html: bold kept, unknown mark ignored', html.includes('<strong>bold</strong>'));
  check(
    'html: callout variant never copied',
    !html.includes('<script>x') && html.includes('<div class="callout" style="background:#eff6ff;'),
  );
  check('html: mention label escaped', html.includes('@&lt;b&gt;Ann&lt;/b&gt;'));
  check(
    'html: missing image becomes placeholder',
    html.includes('[Image not available in the PDF]'),
  );
  check(
    'html: resolved image inlined',
    html.includes('src="data:image/png;base64,AAAA"') && html.includes('width:50%'),
  );
  check('html: image alt escaped', html.includes('alt="&quot;x&quot;"'));
  check('html: numeric colspan only', html.includes('colspan="2"') && !html.includes('rowspan'));
  check(
    'html: unknown node keeps text only',
    html.includes('kept text') && !html.includes('onclick'),
  );
  check('html: list start kept', html.includes('<ol start="3">'));

  const page = printDocument({
    title: '</title><script>x</script>',
    workspaceName: 'A & B',
    authorName: '<i>me</i>',
    updatedAt: new Date('2026-09-25T00:00:00Z'),
    bodyHtml: '<p>body</p>',
  });
  check(
    'print: title escaped',
    !page.includes('</title><script>') && page.includes('&lt;/title&gt;'),
  );
  check('print: author escaped', page.includes('&lt;i&gt;me&lt;/i&gt;'));
  check('print: A4 page rule', page.includes('@page { size: A4; }'));

  check(
    'html: garbage input renders nothing',
    tiptapToPrintHtml(null, new Map()) === '' && tiptapToPrintHtml('x', new Map()) === '',
  );
}

// ---------------------------------------------------------------------------
// 3. Tokens
// ---------------------------------------------------------------------------

{
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const t = newSigningToken();
    check('token: accepted by the public route', signingToken.safeParse(t.raw).success, t.raw);
    check('token: hash is sha256 hex', /^[0-9a-f]{64}$/.test(t.hash));
    check('token: hash matches', hashSigningToken(t.raw) === t.hash);
    check('token: unique', !seen.has(t.raw));
    seen.add(t.raw);
  }
  const placeholder = unusableTokenHash();
  check(
    'token: draft placeholder is not a sha256 hex',
    !/^[0-9a-f]{64}$/.test(placeholder),
    placeholder,
  );
  check(
    'token: malformed rejected',
    !signingToken.safeParse('short').success && !signingToken.safeParse('a/b'.repeat(15)).success,
  );
  // The guessable 6-digit links of commit 007de65 must not reach the service.
  for (const legacy of ['842-195', '842195', 'abcdef', 'A'.repeat(42), 'A'.repeat(44)]) {
    check(
      `token: legacy/short shape refused (${legacy.length})`,
      !signingToken.safeParse(legacy).success,
    );
  }
  check('token: is 43 chars (256 bits)', newSigningToken().raw.length === 43);
}

// ---------------------------------------------------------------------------
// 3b. Second-factor codes
// ---------------------------------------------------------------------------

{
  const codes = new Set<string>();
  for (let i = 0; i < 500; i++) {
    const { token, code } = newSigningCredentials();
    check('code: shape XXX-XXX', /^\d{3}-\d{3}$/.test(code.raw), code.raw);
    check('code: hash is sha256 hex', /^[0-9a-f]{64}$/.test(code.hash));
    check('code: matches its own hash', accessCodeMatches(code.raw, code.hash));
    check(
      'code: matches without the dash',
      accessCodeMatches(code.raw.replace('-', ''), code.hash),
    );
    check(
      'code: matches with spaces',
      accessCodeMatches(` ${code.raw.replace('-', ' ')} `, code.hash),
    );
    check('code: hash differs from the token hash', code.hash !== token.hash);
    check('code: token hash is not the code hash', hashSigningToken(code.raw) !== code.hash);
    codes.add(code.raw);
  }
  check('code: values vary', codes.size > 400, String(codes.size));
  const { code } = newSigningCredentials();
  const wrong = code.raw === '000-000' ? '000-001' : '000-000';
  check('code: wrong code refused', !accessCodeMatches(wrong, code.hash));
  check(
    'code: empty refused',
    !accessCodeMatches('', code.hash) && !accessCodeMatches(undefined, code.hash),
  );
  check('code: no stored hash refused', !accessCodeMatches(code.raw, null));
  check('code: non-digits refused', !accessCodeMatches('abc-def', code.hash));
  check(
    'code: same digits, other hash refused',
    !accessCodeMatches(code.raw, hashAccessCode('999-998')) || code.raw === '999-998',
  );
  check('code: zod accepts 123-456', accessCode.safeParse('123-456').success);
  check('code: zod normalises', accessCode.parse(' 123 456 ') === '123456');
  check('code: zod refuses 12345', !accessCode.safeParse('12345').success);
  check('code: zod refuses letters', !accessCode.safeParse('12a-456').success);
  check(
    'code: lockout after the limit',
    !attemptsExhausted(MAX_ACCESS_CODE_ATTEMPTS - 1) && attemptsExhausted(MAX_ACCESS_CODE_ATTEMPTS),
  );
  check('code: limit is 5', MAX_ACCESS_CODE_ATTEMPTS === 5);
}

// ---------------------------------------------------------------------------
// 4. Validation rules
// ---------------------------------------------------------------------------

{
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const ok = (v: unknown) => signPublicSchema.safeParse(v).success;
  check('sign: drawn png accepted', ok({ consent: true, method: 'DRAWN', imageDataUrl: png }));
  check('sign: consent required', !ok({ consent: false, method: 'DRAWN', imageDataUrl: png }));
  check(
    'sign: svg rejected',
    !ok({ consent: true, method: 'DRAWN', imageDataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }),
  );
  check('sign: typed needs a name', !ok({ consent: true, method: 'TYPED', imageDataUrl: png }));
  check(
    'sign: typed with name accepted',
    ok({ consent: true, method: 'TYPED', imageDataUrl: png, typedName: 'Ann Lee' }),
  );
  check(
    'sign: oversized image rejected',
    !ok({
      consent: true,
      method: 'DRAWN',
      imageDataUrl: `data:image/png;base64,${'A'.repeat(430_000)}`,
    }),
  );
  check(
    'sign: field off the page rejected',
    !ok({
      consent: true,
      method: 'DRAWN',
      imageDataUrl: png,
      fields: [{ kind: 'SIGNATURE', page: 1, x: 0.9, y: 0.1, w: 0.3, h: 0.05 }],
    }),
  );

  const create = (v: unknown) => createSignatureRequestSchema.safeParse(v).success;
  check('create: needs a source', !create({ signers: [{ email: 'a@x.test' }] }));
  check(
    'create: duplicate emails rejected',
    !create({ documentId: 'd1', signers: [{ email: 'A@x.test' }, { email: 'a@x.test' }] }),
  );
  check(
    'create: document source accepted',
    create({ documentId: 'd1', signers: [{ email: 'a@x.test' }] }),
  );
  check(
    'create: upload with document anchor accepted',
    create({ documentId: 'd1', sourceFileId: 'f1', signers: [{ email: 'a@x.test' }] }),
  );
  check(
    'create: at most 20 signers',
    !create({
      documentId: 'd1',
      signers: Array.from({ length: 21 }, (_, i) => ({ email: `s${i}@x.test` })),
    }),
  );

  const fields = (v: unknown) => setSignatureFieldsSchema.safeParse(v).success;
  check(
    'fields: inside page accepted',
    fields({
      fields: [{ signerId: 's1', kind: 'DATE', page: 2, x: 0.8, y: 0.97, w: 0.2, h: 0.03 }],
    }),
  );
  check(
    'fields: overflowing box rejected',
    !fields({
      fields: [{ signerId: 's1', kind: 'SIGNATURE', page: 1, x: 0.8, y: 0.5, w: 0.3, h: 0.05 }],
    }),
  );
  check(
    'fields: page 0 rejected',
    !fields({
      fields: [{ signerId: 's1', kind: 'SIGNATURE', page: 0, x: 0.1, y: 0.1, w: 0.3, h: 0.05 }],
    }),
  );
}

// ---------------------------------------------------------------------------
// 5. Signature image validation
// ---------------------------------------------------------------------------

{
  /** A PNG signature + IHDR declaring w x h, padded with `extra` bytes. */
  const pngWithHeader = (w: number, h: number, extra = 60): string => {
    const b = Buffer.alloc(8 + 25 + extra);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write('IHDR', 12, 'latin1');
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    b[24] = 8; // bit depth
    b[25] = 6; // RGBA
    return `data:image/png;base64,${b.toString('base64')}`;
  };
  const refused = (dataUrl: string): boolean => {
    try {
      decodeSignaturePng(dataUrl);
      return false;
    } catch {
      return true;
    }
  };
  check('png: a pad-sized signature is accepted', !refused(pngWithHeader(1800, 530)));
  check('png: a typed-name signature is accepted', !refused(pngWithHeader(1600, 102)));
  check('png: huge declared dimensions are refused', refused(pngWithHeader(9000, 9000)));
  check('png: too many pixels in total are refused', refused(pngWithHeader(3999, 1999)));
  check('png: zero dimensions are refused', refused(pngWithHeader(0, 100)));
  check(
    'png: a non-PNG is refused',
    refused(`data:image/png;base64,${Buffer.alloc(90, 7).toString('base64')}`),
  );
  check('png: an oversized file is refused', refused(pngWithHeader(100, 100, 310 * 1024)));
}

if (failures > 0) {
  console.error(`Signature checks: ${failures} failed.`);
  process.exit(1);
}
console.log('Signature checks: all passed.');
