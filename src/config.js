// Central place for secrets and limits.
// Values can be overridden through environment variables; the defaults are
// the throwaway test values this demo already shipped with.
export const JWT_SECRET =
  process.env.JWT_SECRET || 'test-secret-key-do-not-use-in-production';

export const WEBHOOK_SECRET =
  process.env.WEBHOOK_SECRET || 'test-webhook-secret-key';

// Maximum value of a single payment, in major currency units (EUR/USD/GBP).
export const MAX_PAYMENT_AMOUNT = 50000;
