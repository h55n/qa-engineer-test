import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { io as ioClient } from 'socket.io-client';
import { startServer, api, registerMerchant } from '../../test-utils/helpers.js';

let srv, call, m;
before(async () => {
  srv = await startServer();
  call = api(srv.base);
  m = await registerMerchant(call);
});
after(async () => { await srv.close(); });

const items = [{ name: 'Pasta', price: 12.5, quantity: 2 }];
const order = (table, extra = {}) =>
  call('/api/table-orders', {
    method: 'POST',
    body: { merchant_id: m.id, table_number: table, items, ...extra },
  });

test('creates an order with the correct total', async () => {
  const res = await order(1);
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.data.data.total, 25);
  assert.strictEqual(res.data.data.status, 'pending');
});

test('Bug F: a second order for a table with an open order is rejected', async () => {
  assert.strictEqual((await order(2)).status, 201);
  const dup = await order(2);
  assert.strictEqual(dup.status, 409);
  assert.ok(dup.data.existing_order_id);
});

test('Bug F: "5" and 5 are the same table', async () => {
  assert.strictEqual((await order(5)).status, 201);
  assert.strictEqual((await order('5')).status, 409);
});

test('Bug F: different tables, or different merchants, do not conflict', async () => {
  assert.strictEqual((await order(30)).status, 201);
  assert.strictEqual((await order(31)).status, 201);
  const other = await registerMerchant(call);
  const res = await call('/api/table-orders', {
    method: 'POST', body: { merchant_id: other.id, table_number: 30, items },
  });
  assert.strictEqual(res.status, 201);
});

test('Bug F: table becomes free again once the order is served', async () => {
  const first = await order(40);
  const patch = await call(`/api/table-orders/${first.data.data.id}/status`, {
    method: 'PATCH', token: m.token, body: { status: 'served' },
  });
  assert.strictEqual(patch.status, 200);
  assert.strictEqual((await order(40)).status, 201);
});

test('Bug F: simultaneous requests for one table create only one order', async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => order(50)));
  assert.strictEqual(results.filter((r) => r.status === 201).length, 1);
  assert.strictEqual(results.filter((r) => r.status === 409).length, 7);
});

test('invalid items are rejected (negative price, zero/fractional quantity)', async () => {
  for (const bad of [
    [{ price: -5, quantity: 1 }],
    [{ price: 5, quantity: 0 }],
    [{ price: 5, quantity: 1.5 }],
    [{ price: '5', quantity: 1 }],
    [null],
  ]) {
    const res = await order(60 + Math.floor(Math.random() * 1000), { items: bad });
    assert.strictEqual(res.status, 400, JSON.stringify(bad));
  }
  assert.strictEqual((await order(70, { items: [] })).status, 400);
});

test('total is rounded to cents', async () => {
  const res = await order(71, { items: [{ price: 0.1, quantity: 1 }, { price: 0.2, quantity: 1 }] });
  assert.strictEqual(res.data.data.total, 0.3);
});

test('status update requires auth, a valid status and ownership', async () => {
  const created = await order(80);
  const id = created.data.data.id;
  assert.strictEqual((await call(`/api/table-orders/${id}/status`, { method: 'PATCH', body: { status: 'ready' } })).status, 401);
  assert.strictEqual((await call(`/api/table-orders/${id}/status`, { method: 'PATCH', token: m.token, body: { status: 'bogus' } })).status, 400);
  const other = await registerMerchant(call);
  assert.strictEqual((await call(`/api/table-orders/${id}/status`, { method: 'PATCH', token: other.token, body: { status: 'ready' } })).status, 403);
  assert.strictEqual((await call(`/api/table-orders/does-not-exist/status`, { method: 'PATCH', token: m.token, body: { status: 'ready' } })).status, 404);
});

test('Socket.IO: new_order and order_status_changed are emitted to the right rooms', async () => {
  const client = ioClient(srv.base, { transports: ['websocket'] });
  const events = [];
  client.on('new_order', (e) => events.push(['new_order', e]));
  client.on('order_status_changed', (e) => events.push(['status', e]));
  await new Promise((r) => client.on('connect', r));
  client.emit('join_merchant', m.id);
  client.emit('join_table', 90);
  await new Promise((r) => setTimeout(r, 150)); // let the joins land

  const created = await order(90);
  await call(`/api/table-orders/${created.data.data.id}/status`, {
    method: 'PATCH', token: m.token, body: { status: 'preparing' },
  });
  await new Promise((r) => setTimeout(r, 150));
  client.close();

  assert.ok(events.some(([t, e]) => t === 'new_order' && e.table_number === 90));
  assert.ok(events.some(([t, e]) => t === 'status' && e.status === 'preparing' && e.table_number === 90));
});
