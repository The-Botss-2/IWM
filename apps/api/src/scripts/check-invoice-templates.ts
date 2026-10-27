/**
 * Checks the invoice template engine and every template folder.
 *
 *   pnpm --filter @botss/api test
 *
 * 1. Engine self-test: escaping, blocks, loops, parent scope, helpers.
 * 2. Every folder under invoice-templates/ compiles and renders against sample
 *    data without throwing, so a typo in someone's template fails CI instead
 *    of failing a customer's invoice.
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';

import { InvoiceTemplatesService, TEMPLATE_HELPERS } from '../invoices/invoice-templates.service';
import { compileTemplate, TemplateError } from '../invoices/template-engine';

function engineSelfTest(): void {
  const render = (src: string, data: unknown) => compileTemplate(src, TEMPLATE_HELPERS).render(data);

  assert.equal(render('Hi {{name}}', { name: '<b>Ann</b>' }), 'Hi &lt;b&gt;Ann&lt;/b&gt;');
  assert.equal(render('{{{raw}}}', { raw: '<i>x</i>' }), '<i>x</i>');
  assert.equal(render('{{#if a}}yes{{else}}no{{/if}}', { a: 0 }), 'no');
  assert.equal(render('{{#unless a}}none{{/unless}}', { a: [] }), 'none');
  assert.equal(
    render('{{#each items}}{{@number}}.{{name}}({{../cur}}){{#unless @last}},{{/unless}}{{/each}}', {
      cur: 'USD',
      items: [{ name: 'a' }, { name: 'b' }],
    }),
    '1.a(USD),2.b(USD)',
  );
  assert.equal(render('{{#each items}}x{{else}}empty{{/each}}', { items: [] }), 'empty');
  assert.equal(render('{{#with c}}{{name}}{{/with}}', { c: { name: 'Co' } }), 'Co');
  assert.equal(render('{{money total "USD"}}', { total: '1250.5' }), '$1,250.50');
  assert.equal(render('{{percent rate}}', { rate: '17.00' }), '17%');
  assert.equal(render('{{date d "iso"}}', { d: new Date('2026-09-11T10:00:00Z') }), '2026-09-11');
  assert.equal(render('{{nl2br t}}', { t: 'a\n<b>' }), 'a<br>&lt;b&gt;');
  assert.equal(render('{{#if (eq s "PAID")}}paid{{/if}}', { s: 'PAID' }), 'paid');
  assert.equal(render('{{#if (gt n 0)}}pos{{/if}}', { n: '2.00' }), 'pos');
  assert.equal(render('{{! hidden }}ok', {}), 'ok');
  assert.equal(render('{{#each items}}{{company}}{{/each}}', { company: 'Root', items: [{}] }), 'Root');

  assert.throws(() => compileTemplate('{{#if a}}open', TEMPLATE_HELPERS), TemplateError);
  assert.throws(() => compileTemplate('{{/each}}', TEMPLATE_HELPERS), TemplateError);
  assert.throws(() => compileTemplate('{{#loop a}}{{/loop}}', TEMPLATE_HELPERS), TemplateError);
  assert.throws(() => render('{{nope x}}', {}), TemplateError);
}

const SAMPLE = {
  invoice: {
    number: 'INV-2026-0001',
    status: 'SENT',
    isDraft: false,
    isPaid: false,
    currency: 'USD',
    issuedAt: new Date('2026-09-01T00:00:00Z'),
    dueAt: new Date('2026-09-15T00:00:00Z'),
    subtotal: '1500.00',
    discount: '50.00',
    tax: '100.00',
    total: '1550.00',
    amountPaid: '500.00',
    balanceDue: '1050.00',
    notes: 'Thank you for your business.\nSecond line.',
    terms: 'Net 14.',
    footer: 'The Botss',
  },
  client: {
    name: 'Acme <Corp>',
    legalName: 'Acme Corporation LLC',
    email: 'billing@acme.test',
    phone: null,
    website: null,
    taxId: 'TX-1',
    addressLines: ['1 Main St', 'Dubai'],
    address: '1 Main St\nDubai',
  },
  project: { name: 'Website rebuild' },
  contract: { title: 'Phase 1' },
  company: {
    name: 'The Botss',
    logo: null,
    address: 'Lahore, Pakistan',
    email: 'billing@example.com',
    phone: null,
    website: 'example.com',
    taxId: null,
    bankDetails: 'Bank: Example\nIBAN: PK00 0000',
    paymentTerms: 'Net 14.',
    footer: 'Thank you',
    accentColor: '#7b6fe8',
  },
  lineItems: [
    {
      position: 1,
      description: 'Design',
      quantity: '1',
      unitPrice: '1000.00',
      taxRate: '10',
      discountRate: '5',
      amount: '1045.00',
    },
    {
      position: 2,
      description: 'Build',
      quantity: '2',
      unitPrice: '250.00',
      taxRate: '0',
      discountRate: '0',
      amount: '500.00',
    },
  ],
};

async function checkTemplates(): Promise<void> {
  const service = new InvoiceTemplatesService();
  const templates = await service.list();
  assert.ok(
    templates.some((t) => t.key === 'default'),
    `The default template is missing from ${service.rootDir}`,
  );
  for (const t of templates) {
    const loaded = await service.load(t.key);
    const html = loaded.compiled.render(SAMPLE);
    assert.ok(html.includes('INV-2026-0001'), `${t.key}: does not print the invoice number`);
    assert.ok(!html.includes('<Corp>'), `${t.key}: client name was not escaped`);
    console.log(`invoice template ok: ${t.key} (${t.name})`);
  }
}

async function main(): Promise<void> {
  engineSelfTest();
  console.log('invoice template engine ok');
  await checkTemplates();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
