import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import authRoutes from "./routes/auth.routes.js";
import paymentRoutes from "./routes/payment.routes.js";
import webhookRoutes from "./routes/webhook.routes.js";
import tableOrderRoutes from "./routes/table-order.routes.js";
import einvoiceRoutes from "./routes/einvoice.routes.js";
import jwt from "jsonwebtoken";
import { initDatabase } from "./db/database.js";
import { JWT_SECRET } from "./config.js";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
// Keep the raw request bytes: webhook signatures are computed over them.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

// Initialize database
initDatabase();

// Socket.IO connection handling
// A socket may only listen to its own merchant's data, so it has to prove who
// it is. Clients pass the same JWT used for the REST API:
//   io(url, { auth: { token } })
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
      socket.data.merchantId = String(decoded.id);
    } catch {
      return next(new Error("Invalid token"));
    }
  }
  next(); // anonymous sockets may connect but cannot join any room
});

io.on("connection", (socket) => {
  console.log("📱 Client connected:", socket.id);

  // Join merchant room for real-time updates (own merchant only)
  socket.on("join_merchant", (merchantId) => {
    if (!socket.data.merchantId || String(merchantId) !== socket.data.merchantId) {
      socket.emit("error_message", { error: "Not allowed to join this merchant room" });
      return;
    }
    socket.join(`merchant_${socket.data.merchantId}`);
    console.log(`Merchant ${socket.data.merchantId} joined room`);
  });

  // Join table room for order updates. Room names include the merchant, so two
  // merchants that both have a "table 5" never see each other's events.
  socket.on("join_table", (tableNumber) => {
    if (!socket.data.merchantId) {
      socket.emit("error_message", { error: "Authentication required" });
      return;
    }
    socket.join(`table_${socket.data.merchantId}_${tableNumber}`);
    console.log(`Joined table ${tableNumber} room`);
  });

  socket.on("disconnect", () => {
    console.log("📱 Client disconnected:", socket.id);
  });
});

// Make io accessible in routes (for emitting events)
app.set("io", io);

// Routes
app.get("/", (req, res) => {
  res.json({
    message: "EU Pay QA Test API",
    version: "1.0.0",
    features: [
      "🔐 Authentication (JWT)",
      "💳 Payment Processing",
      "🪝 Webhook Handling",
      "🍽️ Table Orders (Socket.IO)",
      "📄 E-Invoicing",
    ],
    endpoints: [
      "POST /api/auth/register",
      "POST /api/auth/login",
      "GET /api/payments",
      "POST /api/payments",
      "GET /api/payments/:id",
      "POST /api/webhooks/payment-status",
      "POST /api/webhooks/e-invoice",
      "GET /api/table-orders",
      "POST /api/table-orders",
      "PATCH /api/table-orders/:id/status",
      "POST /api/einvoice/submit",
      "GET /api/einvoice/status/:invoice_id",
    ],
    socket_events: [
      "join_merchant",
      "join_table",
      "new_order",
      "order_status_changed",
    ],
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/webhooks", webhookRoutes);
app.use("/api/table-orders", tableOrderRoutes);
app.use("/api/einvoice", einvoiceRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

// Error handler
app.use((err, req, res, next) => {
  // Malformed JSON is a client error, not a server error.
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON body" });
  }
  console.error(err.stack);
  res.status(500).json({ error: "Something went wrong!" });
});

httpServer.listen(PORT, () => {
  console.log(`✅ EU Pay QA Test API running on http://localhost:${PORT}`);
  console.log(`📖 Visit http://localhost:${PORT} for available endpoints`);
  console.log(`🔌 Socket.IO ready for real-time updates`);
});

export { app, httpServer, io };
export default app;
