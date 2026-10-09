import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { startServer, api, loginSeedMerchant, registerMerchant } from '../../test-utils/helpers.js';

let srv, call, token;
before(async () => {
  srv = await startServer();
  call = api(srv.base);
  token = await loginSeedMerchant(call);
});
after(async () => { await srv.close(); });

const create = (body, t = token) => call('/api/payments', { method: 'POST', token: t, body });
const valid = { amount: 10, currency: 'EUR', customer_email: 'c@example.com' };

test('Bug A: GET /payments returns amount as a number', async () => {
  const res = await call('/api/payments', { token });
  assert.strictEqual(res.status, 200);
  assert.ok(res.data.data.length >= 2);
  for (const p of res.data.data) assert.strictEqual(typeof p.amount, 'number');
  assert.strictEqual(res.data.data[0].amount, 25.5);
});

test('Bug A: GET /payments/:id returns amount as a number', async () => {
  const res = await call('/api/payments/1', { token });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.data.amount, 25.5);
});

test('Bug B: amount above the 50,000 maximum is rejected', async () => {
  const res = await create({ ...valid, amount: 999999999 });
  assert.strictEqual(res.status, 400);
  assert.match(res.data.error, /maximum/i);
});

test('Bug B: boundary - 50000 accepted, 50000.01 rejected', async () => {
  assert.strictEqual((await create({ ...valid, amount: 50000 })).status, 201);
  assert.strictEqual((await create({ ...valid, amount: 50000.01 })).status, 400);
});

test('Bug B: Infinity / exponent strings cannot bypass the maximum', async () => {
  assert.strictEqual((await create({ ...valid, amount: '1e999' })).status, 400);
  assert.strictEqual((await create({ ...valid, amount: '1e9' })).status, 400);
});

test('amount must be a positive finite number', async () => {
  for (const amount of [0, -5, 'abc', '', null, true, [5], {}, NaN]) {
    const res = await create({ ...valid, amount });
    assert.strictEqual(res.status, 400, `expected 400 for ${JSON.stringify(amount)}`);
  }
});

test('amount with more than 2 decimals is rejected, 2 decimals accepted', async () => {
  assert.strictEqual((await create({ ...valid, amount: 10.999 })).status, 400);
  const ok = await create({ ...valid, amount: 10.99 });
  assert.strictEqual(ok.status, 201);
  assert.strictEqual(ok.data.data.amount, 10.99);
});

test('numeric string amount is still accepted (existing behaviour) and stored as number', async () => {
  const res = await create({ ...valid, amount: '12.50' });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.data.data.amount, 12.5);
});

test('currency and customer_email are validated', async () => {
  assert.strictEqual((await create({ ...valid, currency: 'JPY' })).status, 400);
  assert.strictEqual((await create({ ...valid, currency: undefined })).status, 400);
  assert.strictEqual((await create({ ...valid, customer_email: 'x@y' })).status, 400);
});

test('payments require authentication', async () => {
  assert.strictEqual((await create(valid, null)).status, 401);
});

test('merchants cannot read each other\'s payments (IDOR)', async () => {
  const other = await registerMerchant(call);
  const res = await call('/api/payments/1', { token: other.token });
  assert.strictEqual(res.status, 403);
  const list = await call('/api/payments', { token: other.token });
  assert.strictEqual(list.data.count, 0);
});

test('unknown payment id returns 404', async () => {
  assert.strictEqual((await call('/api/payments/99999', { token })).status, 404);
});

test('Bug T: hex, exponent and padded strings are not valid amounts', async () => {
  for (const amount of ['0x10', '1e1', ' 5 ', '5.', '.5', '+5', '5,00']) {
    assert.strictEqual((await create({ ...valid, amount })).status, 400, `amount ${amount}`);
  }
});
