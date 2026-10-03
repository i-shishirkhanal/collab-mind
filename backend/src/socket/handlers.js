const crypto = require('crypto');
const chatService = require('../services/chatService');
const { consume } = require('../middleware/rateLimit');
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
    let requestId = null;
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

      // Same per-user budget as the REST endpoint (chat calls the LLM).
      const limit = Number(process.env.CHAT_RATE_LIMIT_PER_MIN) > 0 ? Number(process.env.CHAT_RATE_LIMIT_PER_MIN) : 20;
      const { allowed, retryAfterSec } = await consume('chat', socket.user.id, limit);
      if (!allowed) {
        if (typeof ack === 'function') ack({ status: 'rate_limited', retryAfterSec });
        socket.emit('error', { message: 'Too many requests. Please try again shortly.', code: 'RATE_LIMITED' });
        return;
      }

      if (typeof ack === 'function') ack({ status: 'processing' });

      // Stream the answer as it is generated. `chat:delta` is a preview only; the
      // persisted `chat:message` that follows is authoritative (its citations are
      // resolved against retrieved chunks and invalid references are removed).
      requestId = crypto.randomUUID();
      const { userMessage, aiMessage } = await chatService.sendChatMessage(
        socket.workspaceId,
        socket.user.id,
        content.trim(),
        [],
        { broadcast: false, onDelta: (text) => io.to(room).emit('chat:delta', { requestId, text }) }
      );

      io.to(room).emit('chat:message', userMessage);
      io.to(room).emit('chat:message', aiMessage);

    } catch (err) {
      console.error(`[Socket] chat:message error: ${err.message}`);
      // Preview text already sent to the room belongs to an answer that will never be stored: tell clients to discard it.
      if (requestId) io.to(room).emit('chat:aborted', { requestId });
      // Rate-limit / timeout / not-configured messages come from the AI service and are safe to show.
      const userFacing = [429, 503, 504].includes(err.status) ? err.message : 'Failed to process message';
      socket.emit('error', { message: userFacing });
    }
  });

  /**
   * presence:typing — typing indicator, scoped to the workspace room.
   */
  let lastTypingAt = 0;
  socket.on('presence:typing', async (payload) => {
    try {
      // "Started typing" events are throttled per socket before any database work; "stopped" always passes.
      const isTyping = !!(payload && payload.isTyping);
      const now = Date.now();
      if (isTyping) {
        if (now - lastTypingAt < 1500) return;
        lastTypingAt = now;
      }
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
