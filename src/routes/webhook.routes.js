import express from 'express';
import { getPaymentById, db } from '../db/database.js';
import { hasValidSignature } from '../utils/webhook-signature.js';

const router = express.Router();

const VALID_EINVOICE_STATUSES = ['submitted', 'accepted', 'rejected'];
const VALID_PAYMENT_STATUSES = ['pending', 'completed', 'failed', 'cancelled', 'refunded'];

/**
 * POST /api/webhooks/payment-status
 * 
 * Simulates external payment provider webhooks (like Powens)
 * Tests webhook signature verification and idempotency
 */
router.post('/payment-status', (req, res) => {
  try {
    // Bug D fix: authenticate the sender before touching any data. The
    // signature is an HMAC-SHA256 of the raw request body (constant-time compare).
    if (!hasValidSignature(req)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const { payment_id, status, event_id } = req.body;

    if (typeof payment_id !== 'string' && typeof payment_id !== 'number') {
      return res.status(400).json({ error: 'payment_id and status required' });
    }
    if (!status || typeof status !== 'string') {
      return res.status(400).json({ error: 'payment_id and status required' });
    }
    if (!VALID_PAYMENT_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status', valid_statuses: VALID_PAYMENT_STATUSES });
    }
    // event_id is the idempotency key, so it is mandatory.
    if (typeof event_id !== 'string' || event_id.trim() === '' || event_id.length > 200) {
      return res.status(400).json({ error: 'event_id required' });
    }

    // Bug E fix: providers retry deliveries. A repeated event_id must not be
    // applied twice (it could overwrite a newer status with a stale one).
    if (db.processed_webhooks.includes(event_id)) {
      return res.status(200).json({ success: true, message: 'Already processed', event_id });
    }

    const payment = getPaymentById(String(payment_id));
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    // Update payment status
    payment.status = status;
    payment.webhook_received_at = new Date();

    // Record the event only after a successful update, so a webhook for a
    // payment that does not exist yet can still be retried later.
    // (Node runs this handler synchronously, so check-and-set cannot interleave.
    // With a real database use a unique constraint on event_id instead.)
    db.processed_webhooks.push(event_id);

    res.status(200).json({
      success: true,
      message: 'Webhook processed',
      payment_id,
      new_status: status
    });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

/**
 * POST /api/webhooks/e-invoice
 * 
 * Simulates e-invoice submission webhook from tax authority
 */
router.post('/e-invoice', (req, res) => {
  try {
    // Same signature check as the payment webhook: this endpoint is
    // unauthenticated by design, so the signature is the only protection.
    if (!hasValidSignature(req)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const { invoice_id, status, submission_id, tax_authority_id } = req.body;

    if (typeof invoice_id !== 'string' || !invoice_id || typeof status !== 'string' || !status) {
      return res.status(400).json({ error: 'invoice_id and status required' });
    }
    if (!VALID_EINVOICE_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status', valid_statuses: VALID_EINVOICE_STATUSES });
    }

    // Find invoice in database
    const invoice = db.invoices?.find(inv => inv.id === invoice_id);
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    // Update invoice status
    invoice.einvoice_status = status;
    invoice.einvoice_submission_id = submission_id;
    invoice.tax_authority_id = tax_authority_id;
    invoice.submitted_at = new Date();

    res.status(200).json({
      success: true,
      message: 'E-invoice webhook processed',
      invoice_id,
      status
    });
  } catch (error) {
    console.error('E-invoice webhook error:', error);
    res.status(500).json({ error: 'E-invoice webhook failed' });
  }
});

export default router;
