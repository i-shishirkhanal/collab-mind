const pool = require('../db/postgres');
const { userRoom, convRoom } = require('../services/realtime');
const { leaveAllCallsFor } = require('../services/callService');
const { isUuid } = require('../utils/http');

// How long a user may be fully disconnected before we drop them from live calls.
// Covers page refreshes and short network blips.
const CALL_DISCONNECT_GRACE_MS = 15_000;

const memberConversationIds = async (userId) => {
  const { rows } = await pool.query(
    'SELECT conversation_id FROM conversation_members WHERE user_id = $1',
    [userId],
  );
  return rows.map((r) => r.conversation_id);
};

const coMemberIds = async (userId) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT cm2.user_id
       FROM conversation_members cm1
       JOIN conversation_members cm2 ON cm2.conversation_id = cm1.conversation_id
      WHERE cm1.user_id = $1 AND cm2.user_id <> $1`,
    [userId],
  );
  return rows.map((r) => r.user_id);
};

const liveMessagingSockets = async (io, userId) =>
  (await io.in(userRoom(userId)).fetchSockets()).filter((s) => s.data?.messaging);

/**
 * Person-to-person messaging channel. Only sockets that connect with
 * `?scope=messaging` take part, so the existing per-workspace socket is untouched.
 *
 * Rooms: `user:<id>` (direct pushes) and `conv:<id>` for every conversation the
 * user belongs to. Message/call state changes are pushed from the REST services;
 * this file only handles presence and typing, which are ephemeral.
 */
const registerMessagingSocket = (io, socket) => {
  if (socket.handshake.query?.scope !== 'messaging') return;

  const userId = socket.user.id;
  socket.data.messaging = true;
  socket.data.userId = userId;
  socket.join(userRoom(userId));

  let convRooms = [];

  (async () => {
    convRooms = (await memberConversationIds(userId)).map(convRoom);
    if (convRooms.length > 0) socket.join(convRooms);

    // Announce "online" only for the user's first messaging socket (they may have several tabs).
    const live = await liveMessagingSockets(io, userId);
    if (live.length === 1 && convRooms.length > 0) {
      socket.to(convRooms).emit('presence:update', { userId, online: true });
    }
    socket.emit('messaging:ready');
  })().catch((err) => {
    console.error(`[Messaging] init failed for ${userId}: ${err.message}`);
    socket.emit('error', { message: 'Failed to initialise messaging' });
  });

  // Which of the people I chat with are online right now?
  socket.on('presence:query', async (ack) => {
    if (typeof ack !== 'function') return;
    try {
      const ids = await coMemberIds(userId);
      if (ids.length === 0) return ack({ onlineUserIds: [] });
      const sockets = await io.in(ids.map(userRoom)).fetchSockets();
      const online = new Set(sockets.filter((s) => s.data?.messaging).map((s) => s.data.userId));
      ack({ onlineUserIds: [...online] });
    } catch (err) {
      ack({ onlineUserIds: [], error: err.message });
    }
  });

  socket.on('conv:typing', ({ conversationId, isTyping } = {}) => {
    // The room check doubles as the authorization check: rooms are only joined for real memberships.
    if (!isUuid(conversationId) || !socket.rooms.has(convRoom(conversationId))) return;
    socket.to(convRoom(conversationId)).emit('conv:typing', {
      conversationId,
      userId,
      name: socket.user.name,
      isTyping: Boolean(isTyping),
    });
  });

  socket.on('disconnecting', () => {
    convRooms = [...socket.rooms].filter((r) => r.startsWith('conv:'));
  });

  socket.on('disconnect', async () => {
    try {
      if ((await liveMessagingSockets(io, userId)).length > 0) return;
      if (convRooms.length > 0) io.to(convRooms).emit('presence:update', { userId, online: false });

      setTimeout(async () => {
        try {
          if ((await liveMessagingSockets(io, userId)).length === 0) await leaveAllCallsFor(userId);
        } catch (err) {
          console.warn(`[Messaging] post-disconnect cleanup failed for ${userId}: ${err.message}`);
        }
      }, CALL_DISCONNECT_GRACE_MS).unref?.();
    } catch (err) {
      console.warn(`[Messaging] disconnect handling failed for ${userId}: ${err.message}`);
    }
  });
};

module.exports = { registerMessagingSocket };
