import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { startServer, api, registerMerchant } from '../../test-utils/helpers.js';

let srv, call, m;
before(async () => {
  srv = await startServer();
  call = api(srv.base);
  m = await registerMerchant(call);
});
after(async () => { await srv.close(); });

const SIRET = '12345678901234';
const submit = (invoice_id, customer_siret = SIRET, token = m.token) =>
  call('/api/einvoice/submit', { method: 'POST', token, body: { invoice_id, customer_siret } });

test('submits an invoice and reports status', async () => {
  const res = await submit('inv-1');
  assert.strictEqual(res.status, 200);
  assert.match(res.data.data.submission_id, /^SUB-/);
  const st = await call('/api/einvoice/status/inv-1', { token: m.token });
  assert.strictEqual(st.data.data.einvoice_status, 'submitted');
});

test('Bug G: submitting the same invoice twice is rejected and keeps the first submission id', async () => {
  const first = await submit('inv-2');
  assert.strictEqual(first.status, 200);
  const second = await submit('inv-2');
  assert.strictEqual(second.status, 409);
  const st = await call('/api/einvoice/status/inv-2', { token: m.token });
  assert.strictEqual(st.data.data.submission_id, first.data.data.submission_id);
});

test('Bug G: a rejected duplicate also applies to accepted invoices', async () => {
  await submit('inv-3');
  // Simulate the tax authority accepting the invoice via the signed webhook.
  const { signed } = await import('../../test-utils/helpers.js');
  const { raw, headers } = signed({ invoice_id: 'inv-3', status: 'accepted', submission_id: 'X1' });
  const hook = await call('/api/webhooks/e-invoice', { method: 'POST', raw, headers });
  assert.strictEqual(hook.status, 200);
  assert.strictEqual((await submit('inv-3')).status, 409);
});

test('invalid SIRET is rejected (length, letters, missing, wrong type) and leaves no invoice behind', async () => {
  for (const s of ['123', '1234567890123a', '123456789012345', null, 12345678901234]) {
    const res = await submit('inv-4', s);
    assert.strictEqual(res.status, 400, `siret ${JSON.stringify(s)}`);
  }
  const st = await call('/api/einvoice/status/inv-4', { token: m.token });
  assert.strictEqual(st.status, 404);
});

test('a SIRET error does not block a later valid submission', async () => {
  assert.strictEqual((await submit('inv-5', 'bad')).status, 400);
  assert.strictEqual((await submit('inv-5')).status, 200);
});

test('invoice_id is required; auth is required', async () => {
  const noId = await call('/api/einvoice/submit', { method: 'POST', token: m.token, body: { customer_siret: SIRET } });
  assert.strictEqual(noId.status, 400);
  const noAuth = await call('/api/einvoice/submit', { method: 'POST', body: { invoice_id: 'x', customer_siret: SIRET } });
  assert.strictEqual(noAuth.status, 401);
});

test('another merchant cannot submit or read someone else\'s invoice', async () => {
  await submit('inv-6');
  const other = await registerMerchant(call);
  assert.strictEqual((await submit('inv-6', SIRET, other.token)).status, 403);
  assert.strictEqual((await call('/api/einvoice/status/inv-6', { token: other.token })).status, 403);
});

test('status of an unknown invoice is 404', async () => {
  assert.strictEqual((await call('/api/einvoice/status/nope', { token: m.token })).status, 404);
});
