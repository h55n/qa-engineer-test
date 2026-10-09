import express from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { db } from '../db/database.js';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

/**
 * GET /api/table-orders
 * List all table orders for authenticated merchant
 */
router.get('/', authenticate, (req, res) => {
  try {
    const merchantId = req.user.id;
    const orders = (db.table_orders || []).filter(o => o.merchant_id === merchantId);

    res.json({
      success: true,
      data: orders,
      count: orders.length
    });
  } catch (error) {
    console.error('Get table orders error:', error);
    res.status(500).json({ error: 'Failed to fetch table orders' });
  }
});

/**
 * POST /api/table-orders
 * Create new table order
 */
router.post('/', (req, res) => {
  try {
    const { merchant_id, table_number, items, customer_name, order_type } = req.body;

    if (!merchant_id || !table_number || !items || !Array.isArray(items)) {
      return res.status(400).json({ error: 'merchant_id, table_number, and items array required' });
    }

    if (items.length === 0) {
      return res.status(400).json({ error: 'Order must have at least one item' });
    }

    // Validate line items: a negative price or fractional quantity would
    // silently produce a wrong (even negative) order total.
    const itemsValid = items.every(
      (i) =>
        i && typeof i === 'object' &&
        typeof i.price === 'number' && Number.isFinite(i.price) && i.price >= 0 &&
        Number.isInteger(i.quantity) && i.quantity > 0
    );
    if (!itemsValid) {
      return res.status(400).json({
        error: 'Each item needs a price >= 0 and a whole-number quantity > 0'
      });
    }

    // Bug F fix: a table may only have one open order at a time.
    // Everything that is not served/cancelled still occupies the table.
    // (Single-threaded handler: check and insert cannot interleave. In a real
    // database this needs a partial unique index to be race-safe.)
    const OPEN_STATUSES = ['pending', 'confirmed', 'preparing', 'ready'];
    const existingOrder = (db.table_orders || []).find(
      (o) =>
        o.merchant_id === merchant_id &&
        String(o.table_number) === String(table_number) &&
        OPEN_STATUSES.includes(o.status)
    );
    if (existingOrder) {
      return res.status(409).json({
        error: 'Table already has an open order',
        existing_order_id: existingOrder.id
      });
    }

    // Calculate total (rounded to cents to avoid float artefacts like 0.1+0.2)
    const total =
      Math.round(items.reduce((sum, item) => sum + item.price * item.quantity, 0) * 100) / 100;

    const newOrder = {
      id: uuidv4(),
      merchant_id,
      table_number,
      items,
      customer_name: customer_name || 'Guest',
      order_type: order_type || 'dine_in',
      status: 'pending',
      total,
      created_at: new Date(),
      updated_at: new Date()
    };

    if (!db.table_orders) db.table_orders = [];
    db.table_orders.push(newOrder);

    // Real-time update. The event was documented but never emitted before.
    const io = req.app.get('io');
    if (io) io.to(`merchant_${merchant_id}`).emit('new_order', newOrder);

    res.status(201).json({
      success: true,
      message: 'Table order created',
      data: newOrder
    });
  } catch (error) {
    console.error('Create table order error:', error);
    res.status(500).json({ error: 'Failed to create table order' });
  }
});

/**
 * PATCH /api/table-orders/:id/status
 * Update order status (triggers socket.io event)
 */
router.patch('/:id/status', authenticate, (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending', 'confirmed', 'preparing', 'ready', 'served', 'cancelled'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ 
        error: 'Valid status required', 
        valid_statuses: validStatuses 
      });
    }

    const order = (db.table_orders || []).find(o => o.id === id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Verify ownership
    if (order.merchant_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    order.status = status;
    order.updated_at = new Date();

    // Emit socket event for real-time update
    const io = req.app.get('io');
    if (io) {
      io.to(`table_${order.table_number}`).emit('order_status_changed', {
        order_id: order.id,
        status: status,
        table_number: order.table_number
      });
    }

    res.json({
      success: true,
      message: 'Order status updated',
      data: order
    });
  } catch (error) {
    console.error('Update order status error:', error);
    res.status(500).json({ error: 'Failed to update order status' });
  }
});

export default router;
