import crypto from 'crypto';
import { WEBHOOK_SECRET } from '../config.js';

/**
 * Verify the HMAC-SHA256 signature of a webhook request.
 *
 * The signature is computed over the exact bytes the provider sent (captured
 * as req.rawBody by the JSON body parser). Re-serialising req.body is only a
 * fallback, because key order and whitespace may differ from the original.
 */
export function hasValidSignature(req) {
  const signature = req.headers['x-webhook-signature'];
  if (typeof signature !== 'string' || signature.length === 0) return false;

  const payload = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so check length first.
  // Length is not secret (always 64 hex chars), so this leaks nothing useful.
  if (a.length !== b.length) return false;
  // Constant-time comparison prevents timing attacks on the signature.
  return crypto.timingSafeEqual(a, b);
}
