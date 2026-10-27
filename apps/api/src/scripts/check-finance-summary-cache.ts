/**
 * Finance summary cache (finance-summary-cache.ts), no Redis needed: a hit
 * serializes byte-for-byte like the computed summary, a bump makes the next
 * read miss, a value computed under an older epoch is never served, and a
 * missing, slow or failing Redis degrades to "compute" without throwing.
 *
 * Run: pnpm --filter @botss/api test.
 */
import assert from 'node:assert/strict';

import type { FinanceSummary, FinanceSummaryQuery } from '@botss/shared-types';

import {
  bumpFinanceSummary,
  financeSummaryKey,
  readFinanceSummary,
  storeFinanceSummary,
} from '../finance/finance-summary-cache';
import type { RedisService } from '../redis/redis.service';

/** The slice of ioredis the cache uses, over a Map. */
class FakeRedis {
  status = 'ready';
  store = new Map<string, string>();
  ttl = new Map<string, number>();
  mode: 'ok' | 'hang' | 'fail' = 'ok';

  private run<T>(fn: () => T): Promise<T> {
    if (this.mode === 'hang') return new Promise<T>(() => undefined);
    if (this.mode === 'fail') return Promise.reject(new Error('boom'));
    return Promise.resolve(fn());
  }
  mget(...keys: string[]) {
    return this.run(() => keys.map((k) => this.store.get(k) ?? null));
  }
  set(key: string, value: string, _ex: 'EX', seconds: number) {
    return this.run(() => {
      this.store.set(key, value);
      this.ttl.set(key, seconds);
      return 'OK';
    });
  }
  multi() {
    const ops: Array<() => void> = [];
    const chain = {
      incr: (key: string) => {
        ops.push(() => this.store.set(key, String(Number(this.store.get(key) ?? '0') + 1)));
        return chain;
      },
      expire: (key: string, seconds: number) => {
        ops.push(() => this.ttl.set(key, seconds));
        return chain;
      },
      exec: () => this.run(() => ops.forEach((op) => op())),
    };
    return chain;
  }
}

const fake = new FakeRedis();
const redis = { client: fake } as unknown as RedisService;

const q: FinanceSummaryQuery = {
  from: new Date('2026-09-01T00:00:00.000Z'),
  to: new Date('2026-09-30T23:59:59.999Z'),
  projectId: 'cproj1',
};
const summary: FinanceSummary = {
  baseCurrency: 'PKR',
  range: { from: q.from, to: q.to },
  receivedBase: '1200.50',
  receivedGrossBase: '1250.00',
  paymentCount: 3,
  spentBase: '100.00',
  expenseCount: 1,
  netProfitBase: '1100.50',
  outstandingBase: '0.00',
  overdueBase: '0.00',
  contractedBase: '5000.00',
  awaitingPaymentBase: '10.01',
  byStatus: { NOT_PAID: 1, PARTIAL: 0, PAID: 2 },
  bySource: [{ paymentSourceId: null, name: 'Unattributed', kind: 'OTHER', amountBase: '1200.50', count: 3 }],
  byRegion: [],
  byCurrency: [{ currency: 'USD', amount: '4.30', amountBase: '1200.50' }],
  byExpenseCategory: [],
  monthly: [{ month: '2026-09', receivedBase: '1200.50', spentBase: '100.00' }],
  topClients: [],
  outstandingByCurrency: [],
};

async function main() {
  // Key pins every query parameter.
  assert.notEqual(financeSummaryKey('w1', q), financeSummaryKey('w1', { ...q, projectId: undefined }));
  assert.notEqual(financeSummaryKey('w1', q), financeSummaryKey('w2', q));
  assert.notEqual(financeSummaryKey('w1', q), financeSummaryKey('w1', { ...q, clientId: 'ccli1' }));

  // Cold: a miss that hands back the epoch to store under.
  const cold = await readFinanceSummary(redis, 'w1', q);
  assert.deepEqual(cold, { epoch: '0', hit: null });
  storeFinanceSummary(redis, 'w1', q, cold!.epoch, summary);
  await new Promise((r) => setImmediate(r));
  assert.equal(fake.ttl.get(financeSummaryKey('w1', q)), 45);

  // Warm: the hit is the same response, Dates included and key order kept.
  const warm = await readFinanceSummary(redis, 'w1', q);
  assert.ok(warm?.hit);
  assert.ok(warm.hit.range.from instanceof Date && warm.hit.range.to instanceof Date);
  assert.equal(JSON.stringify(warm.hit), JSON.stringify(summary));
  assert.deepEqual(warm.hit, summary);
  console.log('  ok  hit is identical to the computed summary');

  // A write elsewhere: other workspaces keep their cache.
  await bumpFinanceSummary(redis, 'w2');
  assert.ok((await readFinanceSummary(redis, 'w1', q))?.hit);

  // A write here: the next read misses.
  await bumpFinanceSummary(redis, 'w1', null, undefined, 'w1');
  assert.equal(fake.store.get('finsum:epoch:w1'), '1', 'duplicate ids bump once');
  const after = await readFinanceSummary(redis, 'w1', q);
  assert.deepEqual(after, { epoch: '1', hit: null });
  console.log('  ok  bump invalidates only its own workspace');

  // A summary computed before the bump (older epoch) is never served.
  storeFinanceSummary(redis, 'w1', q, '0', summary);
  await new Promise((r) => setImmediate(r));
  assert.equal((await readFinanceSummary(redis, 'w1', q))?.hit, null);
  console.log('  ok  a value from an older epoch is ignored');

  // Corrupt value: miss, no throw.
  fake.store.set(financeSummaryKey('w1', q), '{nope');
  assert.deepEqual(await readFinanceSummary(redis, 'w1', q), { epoch: '1', hit: null });

  // Not connected: no command is even issued.
  fake.status = 'reconnecting';
  fake.mode = 'hang';
  assert.equal(await readFinanceSummary(redis, 'w1', q), null);
  await bumpFinanceSummary(redis, 'w1');
  storeFinanceSummary(redis, 'w1', q, '1', summary);
  fake.status = 'ready';

  // Connected but hanging: bounded by the timeout.
  const t0 = Date.now();
  assert.equal(await readFinanceSummary(redis, 'w1', q), null);
  await bumpFinanceSummary(redis, 'w1');
  const waited = Date.now() - t0;
  assert.ok(waited < 1000, `hung Redis held the request for ${waited} ms`);

  // Connected but failing: no throw, no unhandled rejection.
  fake.mode = 'fail';
  assert.equal(await readFinanceSummary(redis, 'w1', q), null);
  await bumpFinanceSummary(redis, 'w1');
  storeFinanceSummary(redis, 'w1', q, '1', summary);
  await new Promise((r) => setImmediate(r));

  // Never initialized: the getter throws, the cache shrugs.
  const uninit = {
    get client(): never {
      throw new Error('RedisService accessed before initialization');
    },
  } as unknown as RedisService;
  assert.equal(await readFinanceSummary(uninit, 'w1', q), null);
  await bumpFinanceSummary(uninit, 'w1');
  console.log('  ok  Redis down, slow or failing never fails the request');

  console.log('\nfinance summary cache checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
