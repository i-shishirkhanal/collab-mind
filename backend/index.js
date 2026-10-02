require('dotenv').config();

// Fail fast on missing/weak secrets or bad security config (no insecure fallbacks).
const config = require('./src/config/env');
try {
  config.validateConfig();
} catch (err) {
  console.error(`❌  Invalid configuration: ${err.message}`);
  process.exit(1);
}

const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

// ── Route imports ──────────────────────────────────────────────────────────────
const authRoutes      = require('./src/routes/auth');
const workspaceRoutes = require('./src/routes/workspaces');
const memberRoutes    = require('./src/routes/members');
const sourceRoutes    = require('./src/routes/sources');
const chatRoutes      = require('./src/routes/chat');

const socket = require('./src/socket');
const { initPubSub } = require('./src/services/pubsubService');

const app = express();

// ── Create HTTP Server & Attach Socket.io ──────────────────────────────────────
const server = http.createServer(app);
const io = socket.init(server);
initPubSub(io);
require('./src/services/agentSubscriber').initAgentSubscriber(io);

// ── Global middleware ──────────────────────────────────────────────────────────
// Only trust X-Forwarded-For when explicitly behind a proxy (rate limits key on req.ip).
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
app.use(helmet());                          // Secure HTTP headers
app.use(cors({ origin: config.corsOrigins() })); // Explicit origin allow-list (CORS_ORIGINS)
app.use(morgan('dev'));                      // Request logging
app.use(express.json({ limit: '100kb' }));  // Parse JSON bodies
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// ── Health check ───────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// ── Mount routers ──────────────────────────────────────────────────────────────
app.use('/api/auth',       authRoutes);
app.use('/api/workspaces', workspaceRoutes);
app.use('/api/workspaces', memberRoutes);   // /api/workspaces/:workspaceId/members
app.use('/api/workspaces', sourceRoutes);   // /api/workspaces/:workspaceId/sources
app.use('/api/workspaces', chatRoutes);     // /api/workspaces/:workspaceId/chat
app.use('/api/workspaces', require('./src/routes/agents')); // /api/workspaces/:workspaceId/agents and /studio
app.use('/api/conversations', require('./src/routes/conversations')); // 1:1 + group chat, files, calls per conversation
app.use('/api/calls',         require('./src/routes/calls'));         // call history + LiveKit token/join/leave
app.use('/api/users',         require('./src/routes/users'));         // people search (shared workspaces only)

// ── 404 handler ────────────────────────────────────────────────────────────────
const { notFound, errorHandler } = require('./src/middleware/errorHandler');
app.use(notFound);

// ── Global error handler (never leaks 5xx internals) ───────────────────────────
app.use(errorHandler);

// Expired sessions / tokens are purged hourly.
setInterval(() => require('./src/services/sessionService').purgeExpired().catch((e) => console.error('[Auth] purge failed:', e.message)), 60 * 60 * 1000).unref();

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
require('./src/services/callService').startSweeper(); // expires unanswered / abandoned calls
server.listen(PORT, () => {
  console.log(`✅  CollabMind backend listening on http://localhost:${PORT}`);
});

module.exports = server; // Exporting server for testing if needed
