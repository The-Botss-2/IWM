/**
 * Problem-details self-checks (no database): Prisma and validation failures
 * are mapped to plain language before they leave the API. No response body
 * may mention "constraint" or "Prisma", unique-constraint conflicts name the
 * field in words, and validation summaries use readable field names while
 * `errors` keeps the raw JSON-pointer keys.
 *
 * Run: pnpm --filter @botss/api test
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { type ArgumentsHost, BadRequestException, HttpException, Logger } from '@nestjs/common';
import { Prisma } from '@botss/database';
import ts from 'typescript';
import { z } from 'zod';

import { humanizeField } from '../common/humanize-field';
import { ProblemDetailsExceptionFilter } from '../common/filters/problem-details.filter';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';

interface Body {
  title: string;
  status: number;
  detail?: string;
  errors?: Record<string, string[]>;
}

// 5xx bodies and validation failures are logged; keep the test output quiet.
Logger.overrideLogger(false);

const filter = new ProblemDetailsExceptionFilter();

/** Run an exception through the filter and return the JSON body it sends. */
function render(exception: unknown): Body {
  let sent: Body | undefined;
  const res = {
    status() {
      return res;
    },
    type() {
      return res;
    },
    json(body: Body) {
      sent = body;
      return res;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({ method: 'POST', originalUrl: '/api/v1/test' }),
    }),
  } as unknown as ArgumentsHost;
  filter.catch(exception, host);
  assert.ok(sent, 'filter sent a body');
  return sent;
}

function prismaError(
  code: string,
  meta?: Record<string, unknown>,
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `Raw Prisma message for ${code}: constraint failed`,
    {
      code,
      clientVersion: 'test',
      meta,
    },
  );
}

function assertClean(body: Body, label: string): void {
  const text = JSON.stringify({ title: body.title, detail: body.detail, errors: body.errors });
  assert.doesNotMatch(text, /constraint/i, `${label}: mentions "constraint": ${text}`);
  assert.doesNotMatch(text, /prisma/i, `${label}: mentions "Prisma": ${text}`);
}

// humanizeField
assert.equal(humanizeField('/items/0/unitPrice'), 'Unit price');
assert.equal(humanizeField('billing_email'), 'Billing email');
assert.equal(humanizeField('/'), 'Input');
assert.equal(humanizeField('name'), 'Name');

// P2002 - unique constraint, with every target shape Prisma produces.
{
  const body = render(prismaError('P2002', { target: ['organizationId', 'email'] }));
  assertClean(body, 'P2002 array');
  assert.equal(body.status, 409);
  assert.equal(body.title, 'Already exists');
  assert.equal(body.detail, 'Something with this email already exists.');
}
{
  const body = render(prismaError('P2002', { target: 'Client_organizationId_slug_key' }));
  assertClean(body, 'P2002 constraint name');
  assert.equal(body.detail, 'Something with this slug already exists.');
}
{
  const body = render(prismaError('P2002', { target: ['workspaceId', 'userId'] }));
  assertClean(body, 'P2002 ids only');
  assert.equal(body.detail, 'Something with these details already exists.');
}
{
  const body = render(prismaError('P2002'));
  assertClean(body, 'P2002 no meta');
  assert.equal(body.detail, 'Something with these details already exists.');
}
{
  const body = render(prismaError('P2002', { target: ['displayName', 'slug'] }));
  assert.equal(body.detail, 'Something with this display name and slug already exists.');
}

// P2003 / P2025 / anything else.
for (const code of ['P2003', 'P2025', 'P2034', 'P1001']) {
  const body = render(prismaError(code, { field_name: 'Task_projectId_fkey (index)' }));
  assertClean(body, code);
}
assert.equal(render(prismaError('P2003')).status, 400);
assert.equal(render(prismaError('P2025')).status, 404);
assert.equal(render(prismaError('P2034')).status, 500);

// Non-request Prisma errors never echo engine text, even outside production.
{
  const body = render(
    new Prisma.PrismaClientValidationError('Invalid `prisma.task.create()` invocation', {
      clientVersion: 'test',
    }),
  );
  assertClean(body, 'PrismaClientValidationError');
  assert.equal(body.status, 500);
}

// Validation pipe: readable summary, machine-readable `errors` keys.
{
  const pipe = new ZodValidationPipe(
    z.object({ items: z.array(z.object({ unitPrice: z.number() })), billing_email: z.string() }),
  );
  let thrown: unknown;
  try {
    pipe.transform({ items: [{ unitPrice: 'x' }], billing_email: 1 });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof BadRequestException, 'pipe throws BadRequestException');
  const body = render(thrown);
  assertClean(body, 'validation');
  assert.equal(body.status, 400);
  assert.match(body.detail ?? '', /^Unit price: /);
  assert.match(body.detail ?? '', /Billing email: /);
  assert.doesNotMatch(body.detail ?? '', /\/items/);
  assert.ok(body.errors && '/items/0/unitPrice' in body.errors, 'errors keeps JSON-pointer keys');
}

// Plain HttpExceptions pass through untouched.
{
  const body = render(new HttpException({ title: 'Nope', detail: 'Not allowed.' }, 403));
  assert.equal(body.status, 403);
  assert.equal(body.detail, 'Not allowed.');
}

// Static scan: RFC 7807 `title` / `detail` string literals under src must not
// use " - ", en dashes or em dashes (log lines are not scanned).
{
  const BAD_DASH = /[—–]| - /;
  const srcRoot = resolve(__dirname, '..');
  const offenders: string[] = [];
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return walk(p);
      return /\.ts$/.test(name) && !/\.d\.ts$/.test(name) ? [p] : [];
    });
  for (const file of walk(srcRoot)) {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const check = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if (BAD_DASH.test(node.text)) report(node);
      } else if (ts.isTemplateExpression(node)) {
        [node.head, ...node.templateSpans.map((s) => s.literal)].forEach((l) => {
          if (BAD_DASH.test(l.text)) report(l);
        });
        node.templateSpans.forEach((s) => check(s.expression));
      } else if (ts.isConditionalExpression(node)) {
        check(node.whenTrue);
        check(node.whenFalse);
      } else if (ts.isBinaryExpression(node)) {
        check(node.left);
        check(node.right);
      } else if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) {
        check(node.expression);
      }
    };
    const report = (n: ts.Node): void => {
      const at = sf.getLineAndCharacterOfPosition(n.getStart());
      offenders.push(`${relative(srcRoot, file)}:${at.line + 1}: ${n.getText()}`);
    };
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node)) {
        const key =
          ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : '';
        if (key === 'title' || key === 'detail') {
          // Skip log lines such as logger.warn({ title: ... }).
          const call = node.parent.parent;
          const isLog =
            ts.isCallExpression(call) &&
            /(?:logger|log|console)\b/i.test(call.expression.getText());
          if (!isLog) check(node.initializer);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  assert.deepEqual(
    offenders,
    [],
    `Problem details text must not use dashes:\n${offenders.join('\n')}`,
  );
}

console.log('problem-details: OK');
