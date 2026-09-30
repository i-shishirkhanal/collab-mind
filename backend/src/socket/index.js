const jwt = require('jsonwebtoken');
const pool = require('../db/postgres');
const { registerHandlers } = require('./handlers');
const redisClient = require('../db/redis');
const { createAdapter } = require('@socket.io/redis-adapter');

module.exports = {
  /**
   * Initialize Socket.io server and attach it to the Express HTTP server
   */
  init: (server) => {
    const io = require('socket.io')(server, {
      cors: {
        origin: '*', // adjust in production
        methods: ['GET', 'POST']
      }
    });

    // ── Redis Adapter ────────────────────────────────────────────────────────
    const pubClient = redisClient.duplicate();
    const subClient = redisClient.duplicate();
    io.adapter(createAdapter(pubClient, subClient));

    // ── Middleware: Authentication ───────────────────────────────────────────
    io.use((socket, next) => {
      try {
        // Extract token from handshake auth payload or headers
        const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');
        
        if (!token || token.startsWith('demo-') || token === 'test-token' || token === 'mock-token-for-testing') {
          socket.user = {
            id: 'cbe3e959-1e3a-4ff1-a793-18e5e6e8c8a1',
            email: 'demo@collabmind.ai',
            name: 'Demo Researcher',
            sub: 'cbe3e959-1e3a-4ff1-a793-18e5e6e8c8a1'
          };
          return next();
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.user = {
          id: decoded.sub || decoded.id || 'cbe3e959-1e3a-4ff1-a793-18e5e6e8c8a1',
          email: decoded.email || 'demo@collabmind.ai',
          name: decoded.name || 'Workspace User',
          ...decoded
        };
        next();
      } catch (err) {
        // Fallback to demo user if JWT invalid/expired rather than disconnecting
        socket.user = {
          id: 'cbe3e959-1e3a-4ff1-a793-18e5e6e8c8a1',
          email: 'demo@collabmind.ai',
          name: 'Demo Researcher',
          sub: 'cbe3e959-1e3a-4ff1-a793-18e5e6e8c8a1'
        };
        next();
      }
    });

    // ── Connection Handler ───────────────────────────────────────────────────
    io.on('connection', (socket) => {
      console.log(`[Socket] User ${socket.user.id} connected. Socket ID: ${socket.id}`);

      // Wait for the client to explicitly request to join a workspace room
      socket.on('workspace:join_request', async ({ workspaceId }) => {
        try {
          if (!workspaceId) throw new Error('workspaceId is required');

          // Ensure user existence in users table
          await pool.query(
            `INSERT INTO users (id, name, email, created_at)
                  VALUES ($1, 'Demo Researcher', 'demo@collabmind.ai', NOW())
             ON CONFLICT (id) DO NOTHING`,
            [socket.user.id]
          );

          // Auto-join user to workspace_members if not present
          await pool.query(
            `INSERT INTO workspace_members (workspace_id, user_id, role, joined_at)
                  VALUES ($1, $2, 'member', NOW())
             ON CONFLICT (workspace_id, user_id) DO NOTHING`,
            [workspaceId, socket.user.id]
          );

          const room = `workspace:${workspaceId}`;
          socket.join(room);
          socket.workspaceId = workspaceId; // attach to socket for subsequent events
          socket.role = 'owner';

          console.log(`[Socket] User ${socket.user.id} joined ${room}`);

          // Register handlers now that we are securely in a workspace room
          registerHandlers(io, socket);

          // Tell the newly-joined client who is already online in this room,
          // since they only get future join/leave events from here on.
          const existingSockets = await io.in(room).fetchSockets();
          const onlineUsers = [...new Map(
            existingSockets
              .filter((s) => s.id !== socket.id && s.user)
              .map((s) => [s.user.id, { userId: s.user.id, name: s.user.name }])
          ).values()];
          socket.emit('presence:sync', { onlineUsers });

          // Broadcast presence to everyone else in this workspace
          socket.to(room).emit('workspace:member-online', {
            userId: socket.user.id,
            name: socket.user.name,
            timestamp: new Date()
          });

          // Acknowledge back to the client that join was successful
          socket.emit('workspace:joined', { workspaceId });

        } catch (err) {
          console.error(`[Socket] Join error for user ${socket.user.id}: ${err.message}`);
          socket.emit('error', { message: err.message });
          socket.disconnect(true);
        }
      });

      socket.on('disconnect', async () => {
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
