const chatService = require('../services/chatService');
const { getMembership, can } = require('../services/workspaceAccess');

const MAX_MESSAGE_LENGTH = 4000;

/**
 * Register event handlers for an authenticated socket that has successfully
 * joined a workspace room.
 *
 * Every event re-checks membership/role in the database: a user removed from
 * the workspace (or demoted) after joining loses access immediately and is
 * dropped from the room.
 *
 * @param {Object} io - The Socket.io server instance
 * @param {Object} socket - The Socket.io socket instance
 */
const registerHandlers = (io, socket) => {
  const room = `workspace:${socket.workspaceId}`;

  /** @returns {Promise<object|null>} membership, or null after evicting the socket */
  const authorize = async (action) => {
    const membership = await getMembership(socket.user.id, socket.workspaceId);
    if (!membership) {
      socket.leave(room);
      socket.emit('error', { message: 'You are no longer a member of this workspace', code: 'FORBIDDEN' });
      return null;
    }
    socket.role = membership.role;
    if (!can(membership.role, action)) {
      socket.emit('error', { message: 'You do not have permission to do that', code: 'FORBIDDEN' });
      return null;
    }
    return membership;
  };

  /**
   * chat:message
   * ────────────
   * Persists the user message, proxies to the AI service, and broadcasts both
   * the user message and the AI reply to the workspace room.
   */
  socket.on('chat:message', async (payload, ack) => {
    try {
      const content = payload && payload.content;
      if (!content || typeof content !== 'string' || content.trim() === '') {
        throw new Error('Message content is required');
      }
      if (content.length > MAX_MESSAGE_LENGTH) throw new Error('Message is too long');

      if (!(await authorize('chat:write'))) {
        if (typeof ack === 'function') ack({ status: 'forbidden' });
        return;
      }

      if (typeof ack === 'function') ack({ status: 'processing' });

      const { userMessage, aiMessage } = await chatService.sendChatMessage(
        socket.workspaceId,
        socket.user.id,
        content.trim()
      );

      io.to(room).emit('chat:message', userMessage);
      io.to(room).emit('chat:message', aiMessage);

    } catch (err) {
      console.error(`[Socket] chat:message error: ${err.message}`);
      socket.emit('error', { message: 'Failed to process message' });
    }
  });

  /**
   * presence:typing — typing indicator, scoped to the workspace room.
   */
  socket.on('presence:typing', async (payload) => {
    try {
      if (!(await authorize('chat:read'))) return;
      socket.to(room).emit('presence:typing', {
        userId: socket.user.id,
        name: socket.user.name,
        isTyping: !!(payload && payload.isTyping)
      });
    } catch (err) {
      console.error(`[Socket] presence:typing error: ${err.message}`);
    }
  });
};

module.exports = { registerHandlers };
