const crypto = require('crypto');
const chatService = require('../services/chatService');
const { consume } = require('../middleware/rateLimit');
const { getMembership, can } = require('../services/workspaceAccess');
const redis = require('../db/redis');

const MAX_MESSAGE_LENGTH = 4000;

// Whiteboard: strokes are kept in a capped Redis list so late joiners see the board.
const WB_MAX_STROKES = 3000;
const WB_MAX_POINTS = 2000;
const WB_TTL_SEC = 7 * 24 * 3600;
const WB_TOOLS = ['pen', 'eraser', 'line', 'rect', 'ellipse', 'text'];
const wbKey = (workspaceId) => `whiteboard:${workspaceId}`;

/** Validate/normalise a stroke from a client; returns null if malformed. */
const sanitizeStroke = (raw, userId) => {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || raw.id.length > 64) return null;
  if (!WB_TOOLS.includes(raw.tool)) return null;
  if (!Array.isArray(raw.points) || raw.points.length < 1 || raw.points.length > WB_MAX_POINTS) return null;
  const points = [];
  for (const p of raw.points) {
    if (!Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
    points.push([Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]);
  }
  const color = typeof raw.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.color) ? raw.color : '#000000';
  const size = Math.min(Math.max(Number(raw.size) || 3, 1), 60);
  const stroke = { id: raw.id, userId, tool: raw.tool, color, size, points };
  if (raw.tool === 'text') stroke.text = String(raw.text || '').slice(0, 500);
  return stroke;
};

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

  /**
   * whiteboard:* � shared drawing board. Strokes persist in Redis per workspace.
   */
  socket.on('whiteboard:load', async (_payload, ack) => {
    try {
      if (!(await authorize('whiteboard:read'))) return;
      const raw = await redis.lrange(wbKey(socket.workspaceId), 0, -1);
      const strokes = raw.map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
      socket.emit('whiteboard:state', { strokes });
      if (typeof ack === 'function') ack({ status: 'ok' });
    } catch (err) {
      console.error(`[Socket] whiteboard:load error: ${err.message}`);
    }
  });

  socket.on('whiteboard:stroke', async (payload) => {
    try {
      const stroke = sanitizeStroke(payload, socket.user.id);
      if (!stroke) return;
      if (!(await authorize('whiteboard:write'))) return;
      const key = wbKey(socket.workspaceId);
      await redis.multi().rpush(key, JSON.stringify(stroke)).ltrim(key, -WB_MAX_STROKES, -1).expire(key, WB_TTL_SEC).exec();
      socket.to(room).emit('whiteboard:stroke', stroke);
    } catch (err) {
      console.error(`[Socket] whiteboard:stroke error: ${err.message}`);
    }
  });

  // Remove one of the caller's own strokes (undo).
  socket.on('whiteboard:remove', async (payload) => {
    try {
      const id = payload && payload.id;
      if (typeof id !== 'string' || id.length > 64) return;
      if (!(await authorize('whiteboard:write'))) return;
      const key = wbKey(socket.workspaceId);
      const items = await redis.lrange(key, 0, -1);
      const target = items.find((r) => {
        try { const s = JSON.parse(r); return s.id === id && s.userId === socket.user.id; } catch { return false; }
      });
      if (!target) return;
      await redis.lrem(key, 1, target);
      socket.to(room).emit('whiteboard:remove', { id });
    } catch (err) {
      console.error(`[Socket] whiteboard:remove error: ${err.message}`);
    }
  });

  socket.on('whiteboard:clear', async () => {
    try {
      if (!(await authorize('whiteboard:write'))) return;
      await redis.del(wbKey(socket.workspaceId));
      socket.to(room).emit('whiteboard:clear', { by: socket.user.name });
    } catch (err) {
      console.error(`[Socket] whiteboard:clear error: ${err.message}`);
    }
  });
};

module.exports = { registerHandlers };
