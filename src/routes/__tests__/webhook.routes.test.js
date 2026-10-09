import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { startServer, api, loginSeedMerchant, signed } from '../../test-utils/helpers.js';

let srv, call, token;
before(async () => {
  srv = await startServer();
  call = api(srv.base);
  token = await loginSeedMerchant(call);
});
after(async () => { await srv.close(); });

let n = 0;
const evt = () => `evt_${Date.now()}_${++n}`;

// Creates a fresh pending payment and returns its id.
async function newPayment() {
  const res = await call('/api/payments', {
    method: 'POST', token,
    body: { amount: 20, currency: 'EUR', customer_email: 'w@example.com' },
  });
  return res.data.data.id;
}
const send = (body, headers) => call('/api/webhooks/payment-status', { method: 'POST', body, headers });
const sendSigned = (body) => {
  const { raw, headers } = signed(body);
  return call('/api/webhooks/payment-status', { method: 'POST', raw, headers });
};
const statusOf = async (id) => (await call(`/api/payments/${id}`, { token })).data.data.status;

test('Bug D: webhook without a signature is rejected and changes nothing', async () => {
  const id = await newPayment();
  const res = await send({ payment_id: id, status: 'completed', event_id: evt() });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(await statusOf(id), 'pending');
});

test('Bug D: webhook with a forged signature is rejected', async () => {
  const id = await newPayment();
  const res = await send(
    { payment_id: id, status: 'completed', event_id: evt() },
    { 'x-webhook-signature': 'fake-signature' },
  );
  assert.strictEqual(res.status, 401);
  assert.strictEqual(await statusOf(id), 'pending');
});

test('Bug D: signature made with the wrong secret, or for a different body, is rejected', async () => {
  const id = await newPayment();
  const body = { payment_id: id, status: 'completed', event_id: evt() };
  const wrongSecret = signed(body, 'attacker-secret');
  const r1 = await call('/api/webhooks/payment-status', { method: 'POST', raw: wrongSecret.raw, headers: wrongSecret.headers });
  assert.strictEqual(r1.status, 401);
  // valid signature for a "failed" body replayed on a tampered "completed" body
  const orig = signed({ ...body, status: 'failed' });
  const r2 = await call('/api/webhooks/payment-status', {
    method: 'POST', raw: JSON.stringify(body), headers: orig.headers,
  });
  assert.strictEqual(r2.status, 401);
  assert.strictEqual(await statusOf(id), 'pending');
});

test('Bug D: correctly signed webhook updates the payment', async () => {
  const id = await newPayment();
  const res = await sendSigned({ payment_id: id, status: 'completed', event_id: evt() });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.new_status, 'completed');
  assert.strictEqual(await statusOf(id), 'completed');
});

test('Bug E: the same event_id delivered twice is applied once', async () => {
  const id = await newPayment();
  const event_id = evt();
  const first = await sendSigned({ payment_id: id, status: 'completed', event_id });
  assert.strictEqual(first.status, 200);
  assert.notStrictEqual(first.data.message, 'Already processed');

  // A newer, different event moves the payment on...
  assert.strictEqual((await sendSigned({ payment_id: id, status: 'refunded', event_id: evt() })).status, 200);
  assert.strictEqual(await statusOf(id), 'refunded');

  // ...and the late retry of the first event must NOT overwrite it.
  const replay = await sendSigned({ payment_id: id, status: 'completed', event_id });
  assert.strictEqual(replay.status, 200);
  assert.strictEqual(replay.data.message, 'Already processed');
  assert.strictEqual(await statusOf(id), 'refunded');
});

test('Bug E: a webhook for an unknown payment is not recorded, so it can be retried later', async () => {
  const event_id = evt();
  const miss = await sendSigned({ payment_id: '987654', status: 'completed', event_id });
  assert.strictEqual(miss.status, 404);
  // The 404 must not burn the event_id: the same event can later be applied to a real payment.
  const real = await newPayment();
  const ok = await sendSigned({ payment_id: real, status: 'completed', event_id });
  assert.strictEqual(ok.status, 200);
  assert.notStrictEqual(ok.data.message, 'Already processed');
});

test('invalid status values are rejected (including XSS payloads)', async () => {
  const id = await newPayment();
  for (const status of ['hacked', '<script>alert(1)</script>', '', 123, null]) {
    const res = await sendSigned({ payment_id: id, status, event_id: evt() });
    assert.strictEqual(res.status, 400, `status ${JSON.stringify(status)}`);
  }
  assert.strictEqual(await statusOf(id), 'pending');
});

test('missing fields are rejected with 400', async () => {
  assert.strictEqual((await sendSigned({ status: 'completed', event_id: evt() })).status, 400);
  assert.strictEqual((await sendSigned({ payment_id: '1', event_id: evt() })).status, 400);
  assert.strictEqual((await sendSigned({ payment_id: '1', status: 'completed' })).status, 400);
  assert.strictEqual((await sendSigned({ payment_id: '1', status: 'completed', event_id: '' })).status, 400);
});

test('unknown payment returns 404; SQL-injection style ids are treated as plain unknown ids', async () => {
  assert.strictEqual((await sendSigned({ payment_id: '424242', status: 'completed', event_id: evt() })).status, 404);
  const sqli = await sendSigned({ payment_id: "1' OR '1'='1", status: 'completed', event_id: evt() });
  assert.strictEqual(sqli.status, 404);
  const huge = await sendSigned({ payment_id: 'x'.repeat(100000), status: 'completed', event_id: evt() });
  assert.strictEqual(huge.status, 404);
});

test('malformed JSON with a signature header returns 400, not 500', async () => {
  const res = await call('/api/webhooks/payment-status', {
    method: 'POST', raw: '{"payment_id":', headers: { 'x-webhook-signature': 'abc' },
  });
  assert.strictEqual(res.status, 400);
});

test('concurrent deliveries of the same event are applied exactly once', async () => {
  const id = await newPayment();
  const event_id = evt();
  const results = await Promise.all(
    Array.from({ length: 10 }, () => sendSigned({ payment_id: id, status: 'completed', event_id })),
  );
  const applied = results.filter((r) => r.data.message === 'Webhook processed');
  assert.strictEqual(applied.length, 1);
  assert.ok(results.every((r) => r.status === 200));
});

test('e-invoice webhook also requires a valid signature', async () => {
  const unsigned = await call('/api/webhooks/e-invoice', {
    method: 'POST', body: { invoice_id: 'x', status: 'accepted' },
  });
  assert.strictEqual(unsigned.status, 401);
  const { raw, headers } = signed({ invoice_id: 'does-not-exist', status: 'accepted' });
  const res = await call('/api/webhooks/e-invoice', { method: 'POST', raw, headers });
  assert.strictEqual(res.status, 404); // signature accepted, invoice unknown
});
