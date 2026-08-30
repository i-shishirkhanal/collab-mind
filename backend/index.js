require('dotenv').config();
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
app.use(helmet());                          // Secure HTTP headers
app.use(cors());                            // Enable CORS for all origins
app.use(morgan('dev'));                      // Request logging
app.use(express.json());                    // Parse JSON bodies
app.use(express.urlencoded({ extended: true }));

// ── Health check ───────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// ── Mount routers ──────────────────────────────────────────────────────────────
app.use('/api/auth',       authRoutes);
app.use('/api/workspaces', workspaceRoutes);
app.use('/api/workspaces', memberRoutes);   // /api/workspaces/:workspaceId/members
app.use('/api/workspaces', sourceRoutes);   // /api/workspaces/:workspaceId/sources
app.use('/api/workspaces', chatRoutes);     // /api/workspaces/:workspaceId/chat
app.use('/api/workspaces', require('./src/routes/agents')); // /api/workspaces/:workspaceId/agents and /studio

// ── 404 handler ────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ── Global error handler ───────────────────────────────────────────────────────
// Must have 4 params so Express recognises it as an error handler
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err);
  const status  = err.status || err.statusCode || 500;
  const message = err.message || 'Internal server error';
  res.status(status).json({ error: message });
});

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`✅  CollabMind backend listening on http://localhost:${PORT}`);
});

module.exports = server; // Exporting server for testing if needed
