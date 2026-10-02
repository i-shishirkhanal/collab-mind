const { registerHandlers } = require('./handlers');
const redisClient = require('../db/redis');
const realtime = require('../services/realtime');
const { registerMessagingSocket } = require('./messaging');
const { verifySessionToken } = require('../services/sessionService');
const { getMembership } = require('../services/workspaceAccess');
const { corsOrigins } = require('../config/env');
const { createAdapter } = require('@socket.io/redis-adapter');

// Longest setTimeout delay Node supports (~24.8 days).
const MAX_TIMER_MS = 2 ** 31 - 1;

module.exports = {
  /**
   * Initialize Socket.io server and attach it to the Express HTTP server
   */
  init: (server) => {
    const io = require('socket.io')(server, {
      cors: {
        origin: corsOrigins(),
        methods: ['GET', 'POST'],
      },
    });

    realtime.setIo(io);

    // ── Redis Adapter ────────────────────────────────────────────────────────
    const pubClient = redisClient.duplicate();
    const subClient = redisClient.duplicate();
    io.adapter(createAdapter(pubClient, subClient));

    // ── Middleware: Authentication ───────────────────────────────────────────
    // A valid, live session token is mandatory. No token / bad token / revoked
    // session => the connection is refused. There is no demo identity.
    io.use(async (socket, next) => {
      try {
        const header = socket.handshake.headers?.authorization;
        const token = socket.handshake.auth?.token
          || (typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null);
        const user = await verifySessionToken(token);
        socket.user = { id: user.id, email: user.email, name: user.name };
        socket.sessionId = user.sessionId;
        socket.sessionExpiresAt = user.expiresAt;
        next();
      } catch (err) {
        next(new Error(err.status === 401 ? 'unauthorized' : 'authentication_unavailable'));
      }
    });

    // ── Connection Handler ───────────────────────────────────────────────────
    io.on('connection', (socket) => {
      console.log(`[Socket] User ${socket.user.id} connected. Socket ID: ${socket.id}`);

      // Lets logout / password reset drop this socket, and membership removal
      // pull it out of workspace rooms.
      socket.join([`session:${socket.sessionId}`, `wsuser:${socket.user.id}`]);

      // Sessions end when the token does.
      const msLeft = new Date(socket.sessionExpiresAt).getTime() - Date.now();
      const expiryTimer = setTimeout(() => socket.disconnect(true), Math.min(Math.max(msLeft, 0), MAX_TIMER_MS));
      expiryTimer.unref();

      // Person-to-person chat, presence and call signalling (independent of workspace rooms)
      registerMessagingSocket(io, socket);

      // The client explicitly asks to join ONE workspace room; membership is
      // verified in the database every time. Nothing is auto-created or auto-joined.
      socket.on('workspace:join_request', async (payload) => {
        try {
          const workspaceId = payload && payload.workspaceId;
          const membership = await getMembership(socket.user.id, workspaceId);
          if (!membership) {
            socket.emit('error', { message: 'You are not a member of this workspace', code: 'FORBIDDEN' });
            return;
          }

          if (socket.workspaceId) {
            if (socket.workspaceId === workspaceId) {
              socket.emit('workspace:joined', { workspaceId }); // idempotent re-join
            } else {
              socket.emit('error', { message: 'This connection is already bound to another workspace', code: 'CONFLICT' });
            }
            return;
          }

          const room = `workspace:${workspaceId}`;
          socket.join(room);
          socket.workspaceId = workspaceId;
          socket.role = membership.role;

          console.log(`[Socket] User ${socket.user.id} joined ${room}`);

          registerHandlers(io, socket);

          // Tell the newly-joined client who is already online in this room.
          const existingSockets = await io.in(room).fetchSockets();
          const onlineUsers = [...new Map(
            existingSockets
              .filter((s) => s.id !== socket.id && s.user)
              .map((s) => [s.user.id, { userId: s.user.id, name: s.user.name }])
          ).values()];
          socket.emit('presence:sync', { onlineUsers });

          socket.to(room).emit('workspace:member-online', {
            userId: socket.user.id,
            name: socket.user.name,
            timestamp: new Date()
          });

          socket.emit('workspace:joined', { workspaceId });
        } catch (err) {
          console.error(`[Socket] Join error for user ${socket.user.id}: ${err.message}`);
          socket.emit('error', { message: 'Could not join workspace' });
        }
      });

      socket.on('disconnect', async () => {
        clearTimeout(expiryTimer);
        console.log(`[Socket] User ${socket.user.id} disconnected. Socket ID: ${socket.id}`);
        if (socket.workspaceId) {
          const room = `workspace:${socket.workspaceId}`;
          // A user may have several tabs/sockets open; only announce them as
          // offline once their last socket in this room has disconnected.
          const remaining = await io.in(room).fetchSockets();
          const stillOnline = remaining.some((s) => s.id !== socket.id && s.user?.id === socket.user.id);
          if (!stillOnline) {
            io.to(room).emit('workspace:member-offline', {
              userId: socket.user.id,
              timestamp: new Date()
            });
          }
        }
      });
    });

    return io;
  }
};
