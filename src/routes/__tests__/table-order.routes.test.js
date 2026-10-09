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
  const client = ioClient(srv.base, { transports: ['websocket'], auth: { token: m.token } });
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

test('Bug M: merchant_id 1 and "1" are the same merchant (no duplicate bypass, order is listed)', async () => {
  const num = await call('/api/table-orders', { method: 'POST', body: { merchant_id: Number(m.id), table_number: 120, items } });
  assert.strictEqual(num.status, 201);
  assert.strictEqual(num.data.data.merchant_id, String(m.id));
  assert.strictEqual((await order(120)).status, 409);
  const list = await call('/api/table-orders', { token: m.token });
  assert.ok(list.data.data.some((o) => o.id === num.data.data.id));
});

test('Bug N: odd merchant_id / table_number / order_type / customer_name types are rejected', async () => {
  const post = (body) => call('/api/table-orders', { method: 'POST', body: { merchant_id: m.id, table_number: 130, items, ...body } });
  assert.strictEqual((await post({ merchant_id: { a: 1 } })).status, 400);
  assert.strictEqual((await post({ table_number: { x: 1 } })).status, 400);
  assert.strictEqual((await post({ table_number: -3 })).status, 400);
  assert.strictEqual((await post({ table_number: 1.5 })).status, 400);
  assert.strictEqual((await post({ order_type: 'teleport' })).status, 400);
  assert.strictEqual((await post({ customer_name: ['x'] })).status, 400);
  assert.strictEqual((await post({ customer_name: 'x'.repeat(101) })).status, 400);
});

function connect(token) {
  const c = ioClient(srv.base, { transports: ['websocket'], auth: token ? { token } : {} });
  const got = [];
  c.on('new_order', (e) => got.push(['new_order', e]));
  c.on('order_status_changed', (e) => got.push(['status', e]));
  c.on('error_message', (e) => got.push(['error', e]));
  return new Promise((resolve) => c.on('connect', () => resolve({ c, got })));
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('Bug O: a socket cannot listen to another merchant\'s orders', async () => {
  const victim = await registerMerchant(call);
  const attacker = await registerMerchant(call);
  const anon = await connect(null);
  const evil = await connect(attacker.token);
  anon.c.emit('join_merchant', victim.id);
  evil.c.emit('join_merchant', victim.id);
  await wait(150);
  await call('/api/table-orders', { method: 'POST', body: { merchant_id: victim.id, table_number: 7, items } });
  await wait(150);
  for (const x of [anon, evil]) {
    assert.ok(!x.got.some(([t]) => t === 'new_order'), 'must not receive victim orders');
    assert.ok(x.got.some(([t]) => t === 'error'), 'must be told it was refused');
    x.c.close();
  }
});

test('Bug O: a socket with an invalid token is refused', async () => {
  const c = ioClient(srv.base, { transports: ['websocket'], auth: { token: 'garbage' } });
  const err = await new Promise((r) => c.on('connect_error', r));
  assert.match(err.message, /Invalid token/);
  c.close();
});

test('Bug P: two merchants with the same table number do not see each other\'s status events', async () => {
  const a = await registerMerchant(call);
  const b = await registerMerchant(call);
  const watcherB = await connect(b.token);
  watcherB.c.emit('join_table', 9);
  await wait(150);
  const created = await call('/api/table-orders', { method: 'POST', body: { merchant_id: a.id, table_number: 9, items } });
  await call(`/api/table-orders/${created.data.data.id}/status`, { method: 'PATCH', token: a.token, body: { status: 'ready' } });
  await wait(150);
  assert.strictEqual(watcherB.got.filter(([t]) => t === 'status').length, 0);
  watcherB.c.close();
});
