const redisClient = require('../db/redis');

/**
 * pubsubService.js
 * ─────────────────
 * Creates a dedicated duplicate Redis client strictly for subscribing to
 * events emitted by the AI FastAPI backend.
 * 
 * When the Python backend publishes an event (e.g. agent status change) securely
 * through Redis, this Node.js process receives it and broadcasts it to the
 * connected Socket.io clients securely scoped to the workspace room.
 */

// Dedicated subscriber client (duplicate because subscribe blocks other commands)
const subscriber = redisClient.duplicate();

/**
 * Initializes the pub/sub listener.
 * 
 * @param {Object} io - The Socket.io server instance
 */
const initPubSub = (io) => {
  const channel = 'ai_updates';

  subscriber.subscribe(channel, (err, count) => {
    if (err) {
      console.error(`[PubSub] Failed to subscribe: ${err.message}`);
      return;
    }
    console.log(`[PubSub] Subscribed to ${count} channel(s). Listening on: ${channel}`);
  });

  // Listen for messages published to the ai_updates channel
  subscriber.on('message', (chan, messageStr) => {
    if (chan !== channel) return;

    try {
      // Expected structure from FastAPI:
      // {
      //    "workspaceId": "abc...",
      //    "type": "agent:status_update",
      //    "data": { "status": "running", "agent_id": "..." }
      // }
      const message = JSON.parse(messageStr);

      if (!message.workspaceId || !message.type) {
        console.warn('[PubSub] Received malformed message: lacking workspaceId or type');
        return;
      }

      const room = `workspace:${message.workspaceId}`;

      // Broadcast the event directly to the workspace room
      io.to(room).emit(message.type, message.data);

    } catch (err) {
      console.error(`[PubSub] Error processing raw message: ${messageStr}`, err);
    }
  });
};

module.exports = { initPubSub };
