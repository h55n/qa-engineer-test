import crypto from 'crypto';

// Each test file runs in its own process (node --test), so importing the
// server once per file gives every file a fresh in-memory database.
// PORT=0 lets the OS pick a free port, so tests never clash with a running
// dev server on :3000.
export async function startServer() {
  process.env.PORT = '0';
  const { httpServer, io } = await import('../server.js');
  if (!httpServer.listening) {
    await new Promise((resolve) => httpServer.once('listening', resolve));
  }
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  return {
    base,
    io,
    close: () => new Promise((resolve) => {
      httpServer.closeAllConnections?.();
      io.close(() => resolve());
    }),
  };
}

export function api(base) {
  return async function call(path, { method = 'GET', token, body, headers = {}, raw } = {}) {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    let payload = raw;
    if (body !== undefined) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    } else if (raw !== undefined) {
      h['Content-Type'] = 'application/json';
    }
    const res = await fetch(base + path, { method, headers: h, body: payload });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    return { status: res.status, data };
  };
}

let counter = 0;
// Registers a brand-new merchant and returns its token and id.
export async function registerMerchant(call) {
  counter += 1;
  const email = `merchant${Date.now()}${counter}@example.com`;
  const res = await call('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'SecurePass123!', business_name: 'Test Co' },
  });
  return { email, token: res.data.token, id: res.data.user.id };
}

export async function loginSeedMerchant(call) {
  const res = await call('/api/auth/login', {
    method: 'POST',
    body: { email: 'merchant@test.com', password: 'Test123!' },
  });
  return res.data?.token;
}

// Must match WEBHOOK_SECRET in src/config.js.
const SECRET = process.env.WEBHOOK_SECRET || 'test-webhook-secret-key';

// Returns { raw, headers } for a correctly signed webhook body.
export function signed(body, secret = SECRET) {
  const raw = JSON.stringify(body);
  const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return { raw, headers: { 'x-webhook-signature': sig } };
}
