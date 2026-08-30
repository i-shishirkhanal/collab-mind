const chatService = require('../services/chatService');

/**
 * Register event handlers for an authenticated socket that has successfully
 * joined a workspace room.
 *
 * @param {Object} io - The Socket.io server instance
 * @param {Object} socket - The Socket.io socket instance
 */
const registerHandlers = (io, socket) => {
  const room = `workspace:${socket.workspaceId}`;

  /**
   * chat:message
   * ────────────
   * Client sends a new chat message. 
   * Server persists it to DB, proxies to AI backend, and broadcasts both the
   * user message and the AI reply to the workspace room.
   */
  socket.on('chat:message', async ({ content }, ack) => {
    try {
      if (!content || typeof content !== 'string' || content.trim() === '') {
        throw new Error('Message content is required');
      }

      // We don't block the socket loop, we perform the async operation
      // and optionally acknowledge receipt immediately
      if (typeof ack === 'function') ack({ status: 'processing' });

      // sendChatMessage persists to DB and proxies to Python AI service
      const { userMessage, aiMessage } = await chatService.sendChatMessage(
        socket.workspaceId,
        socket.user.id,
        content.trim()
      );

      // Broadcast the strictly user message to everyone in the room (including sender)
      // so their UI updates with the finalized DB record
      io.to(room).emit('chat:message', userMessage);

      // Broadcast the AI response as a separate message event
      io.to(room).emit('chat:message', aiMessage);

    } catch (err) {
      console.error(`[Socket] chat:message error: ${err.message}`);
      socket.emit('error', { message: `Failed to process message: ${err.message}` });
    }
  });

  /**
   * presence:typing
   * ───────────────
   * Client indicates they are typing. We broadcast a typing indicator
   * securely to only the workspace room.
   */
  socket.on('presence:typing', ({ isTyping }) => {
    socket.to(room).emit('presence:typing', {
      userId: socket.user.id,
      name: socket.user.name,
      isTyping: !!isTyping
    });
  });
};

module.exports = { registerHandlers };
