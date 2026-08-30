const redisClient = require('../db/redis');

/**
 * agentSubscriber.js
 * ─────────────────
 * Subscribes to Redis agent events.
 * The Python agent (LangGraph) publishes to 'workspace:{id}:agents'.
 * We use PSUBSCRIBE to listen to all workspaces.
 */
const subscriber = redisClient.duplicate();

const initAgentSubscriber = (io) => {
  // Listen to any channel matching workspace:*:agents
  subscriber.psubscribe('workspace:*:agents', (err, count) => {
    if (err) {
      console.error(`[AgentSubscriber] Failed to psubscribe: ${err.message}`);
      return;
    }
    console.log(`[AgentSubscriber] PSubscribed to ${count} pattern(s). Listening on: workspace:*:agents`);
  });

  subscriber.on('pmessage', (pattern, channel, messageStr) => {
    try {
      const parts = channel.split(':');
      if (parts.length >= 2) {
        const workspaceId = parts[1];
        const message = JSON.parse(messageStr);
        
        // Broadcast the event directly to the workspace room
        // type is usually 'agent:status'
        io.to(`workspace:${workspaceId}`).emit(message.type || 'agent:status', message.data);
      }
    } catch (err) {
      console.error(`[AgentSubscriber] Error processing raw message: ${messageStr}`, err);
    }
  });
};

module.exports = { initAgentSubscriber };
