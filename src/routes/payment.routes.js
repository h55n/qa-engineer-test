import express from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { MAX_PAYMENT_AMOUNT } from '../config.js';
import { isValidEmail } from '../utils/validation.js';
import { createPayment, getPayments, getPaymentById } from '../db/database.js';

const router = express.Router();

// GET /api/payments - List all payments for authenticated merchant
router.get('/', authenticate, (req, res) => {
  try {
    const merchantId = req.user.id;
    const payments = getPayments(merchantId);

    const formattedPayments = payments.map(p => ({
      id: p.id,
      // Bug A fix: amounts are stored as numbers and must stay numbers in the
      // response (strings break client-side maths). Number() is a no-op here.
      amount: Number(p.amount),
      currency: p.currency,
      status: p.status,
      customer_email: p.customer_email,
      created_at: p.created_at
    }));

    res.json({
      success: true,
      data: formattedPayments,
      count: formattedPayments.length
    });
  } catch (error) {
    console.error('Get payments error:', error);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

// GET /api/payments/:id - Get single payment
router.get('/:id', authenticate, (req, res) => {
  try {
    const payment = getPaymentById(req.params.id);

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    // Verify ownership
    if (payment.merchant_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json({
      success: true,
      data: {
        id: payment.id,
        amount: Number(payment.amount), // Bug A fix (see list endpoint)
        currency: payment.currency,
        status: payment.status,
        customer_email: payment.customer_email,
        created_at: payment.created_at
      }
    });
  } catch (error) {
    console.error('Get payment error:', error);
    res.status(500).json({ error: 'Failed to fetch payment' });
  }
});

// POST /api/payments - Create new payment
router.post('/', authenticate, (req, res) => {
  try {
    const { amount, currency, customer_email } = req.body;

    // Validation
    // Only real numbers or numeric strings are accepted. Booleans, arrays and
    // objects pass isNaN() (Number(true) === 1) so they are rejected up front.
    // Strings must look like plain decimals ("12.50"). Number() would also
    // accept "0x10" (16), "1e1" (10) or " 5 ", which are almost certainly mistakes.
    const numeric =
      typeof amount === 'number' ||
      (typeof amount === 'string' && /^\d+(\.\d+)?$/.test(amount));
    const value = numeric ? Number(amount) : NaN;

    // Number.isFinite also rejects Infinity, which isNaN() lets through.
    if (!Number.isFinite(value) || value <= 0) {
      return res.status(400).json({ error: 'Valid amount is required' });
    }

    // Bug B fix: enforce a per-transaction maximum.
    if (value > MAX_PAYMENT_AMOUNT) {
      return res.status(400).json({
        error: `Amount exceeds the maximum of ${MAX_PAYMENT_AMOUNT} per transaction`
      });
    }

    // Money has at most 2 decimals; reject fractions of a cent instead of
    // silently storing them.
    if (Math.round(value * 100) / 100 !== value) {
      return res.status(400).json({ error: 'Amount must have at most 2 decimal places' });
    }

    if (!currency || !['EUR', 'USD', 'GBP'].includes(currency)) {
      return res.status(400).json({ error: 'Valid currency is required (EUR, USD, GBP)' });
    }

    if (!isValidEmail(customer_email)) {
      return res.status(400).json({ error: 'Valid customer email is required' });
    }

    const payment = createPayment({
      merchant_id: req.user.id,
      amount: value,
      currency,
      customer_email,
      status: 'pending'
    });

    res.status(201).json({
      success: true,
      message: 'Payment created',
      data: {
        id: payment.id,
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
        customer_email: payment.customer_email
      }
    });
  } catch (error) {
    console.error('Create payment error:', error);
    res.status(500).json({ error: 'Failed to create payment' });
  }
});

export default router;
