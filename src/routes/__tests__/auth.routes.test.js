import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { startServer, api, loginSeedMerchant } from '../../test-utils/helpers.js';

let srv, call;
before(async () => { srv = await startServer(); call = api(srv.base); });
after(async () => { await srv.close(); });

const reg = (email, extra = {}) =>
  call('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'SecurePass123!', business_name: 'Test Co', ...extra },
  });

test('Bug C: register rejects an email without a TLD (user@domain)', async () => {
  const res = await reg('user@domain');
  assert.strictEqual(res.status, 400);
  assert.match(res.data.error, /email/i);
});

test('Bug C: register rejects other malformed emails', async () => {
  for (const email of ['plain', 'a@b.', '@x.com', 'a@.com', 'a b@x.com', 'a@x.c', 'a@@x.com']) {
    const res = await reg(email);
    assert.strictEqual(res.status, 400, `expected 400 for ${email}`);
  }
});

test('Bug C: register rejects non-string email (type confusion)', async () => {
  const res = await call('/api/auth/register', {
    method: 'POST',
    body: { email: ['a@b.com'], password: 'SecurePass123!', business_name: 'Test Co' },
  });
  assert.strictEqual(res.status, 400);
});

test('register accepts a valid email and returns a token', async () => {
  const res = await reg('valid.user+tag@example.co.uk');
  assert.strictEqual(res.status, 201);
  assert.ok(res.data.token);
  assert.strictEqual(res.data.user.email, 'valid.user+tag@example.co.uk');
});

test('register is case-insensitive: same email in different case is a duplicate', async () => {
  assert.strictEqual((await reg('case@example.com')).status, 201);
  assert.strictEqual((await reg('CASE@Example.com')).status, 409);
});

test('register rejects short password and missing business name', async () => {
  assert.strictEqual((await reg('p1@example.com', { password: 'short' })).status, 400);
  assert.strictEqual((await reg('p2@example.com', { business_name: ' ' })).status, 400);
});

test('login works for the documented seed merchant', async () => {
  const token = await loginSeedMerchant(call);
  assert.ok(token, 'seed merchant must be able to log in');
});

test('login works regardless of email case', async () => {
  await reg('login.case@example.com');
  const res = await call('/api/auth/login', {
    method: 'POST',
    body: { email: 'LOGIN.Case@example.com', password: 'SecurePass123!' },
  });
  assert.strictEqual(res.status, 200);
});

test('login rejects wrong password and unknown user with the same generic error', async () => {
  const bad = await call('/api/auth/login', {
    method: 'POST', body: { email: 'merchant@test.com', password: 'nope' },
  });
  const unknown = await call('/api/auth/login', {
    method: 'POST', body: { email: 'ghost@example.com', password: 'nope' },
  });
  assert.strictEqual(bad.status, 401);
  assert.strictEqual(unknown.status, 401);
  assert.strictEqual(bad.data.error, unknown.data.error); // no user enumeration
});

test('protected routes reject missing, garbage and wrongly-signed tokens', async () => {
  assert.strictEqual((await call('/api/payments')).status, 401);
  assert.strictEqual((await call('/api/payments', { token: 'garbage' })).status, 401);
  // JWT signed with a different secret
  const jwt = (await import('jsonwebtoken')).default;
  const forged = jwt.sign({ id: '1', email: 'merchant@test.com' }, 'wrong-secret');
  assert.strictEqual((await call('/api/payments', { token: forged })).status, 401);
  // "alg: none" token
  const none = Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url') + '.' +
    Buffer.from('{"id":"1"}').toString('base64url') + '.';
  assert.strictEqual((await call('/api/payments', { token: none })).status, 401);
});

test('malformed JSON body returns 400, not 500', async () => {
  const res = await call('/api/auth/login', { method: 'POST', raw: '{bad json' });
  assert.strictEqual(res.status, 400);
});
