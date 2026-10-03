const chatService = require('../services/chatService');

/**
 * getMessages — GET /workspaces/:workspaceId/chat/messages
 * Returns paginated chat history for a workspace.
 *
 * Query params:
 *   ?limit=50      - number of messages (default 50, max 100)
 *   ?before=<ISO>  - cursor: return messages older than this timestamp
 */
const getMessages = async (req, res, next) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const before = req.query.before || null;
    if (before !== null && (typeof before !== 'string' || Number.isNaN(Date.parse(before)))) {
      return res.status(400).json({ error: 'before must be an ISO timestamp' });
    }

    const messages = await chatService.getChatMessages(
      req.params.workspaceId,
      limit,
      before,
    );

    res.json({ messages, count: messages.length });
  } catch (err) {
    next(err);
  }
};

/**
 * sendMessage — POST /workspaces/:workspaceId/chat
 * Persists the user message and proxies it to the AI service.
 *
 * Request body: { message: string }
 * Response:     { userMessage: Object, aiMessage: Object }
 */
const sendMessage = async (req, res, next) => {
  try {
    const { message, conversation_history } = req.body;

    if (!message || typeof message !== 'string' || message.trim() === '') {
      return res.status(400).json({ error: 'message is required and must be a non-empty string' });
    }

    if (message.length > 4000) {
      return res.status(400).json({ error: 'message is too long' });
    }

    // Client-supplied history is untrusted prompt input: keep only well-formed turns.
    const history = (Array.isArray(conversation_history) ? conversation_history : [])
      .filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

    // Optional: restrict answers to specific documents, or force the model tier.
    // (The AI service only searches this workspace regardless of what ids are sent.)
    const { source_ids, task } = req.body;
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (source_ids !== undefined && (!Array.isArray(source_ids) || source_ids.length > 50
        || !source_ids.every((id) => typeof id === 'string' && UUID.test(id)))) {
      return res.status(400).json({ error: 'source_ids must be an array of source ids' });
    }
    if (task !== undefined && !['chat', 'study', 'research'].includes(task)) {
      return res.status(400).json({ error: "task must be 'chat', 'study' or 'research'" });
    }

    const result = await chatService.sendChatMessage(
      req.params.workspaceId,
      req.user.id,
      message.trim(),
      history,
      { sourceIds: source_ids, task }
    );

    res.status(201).json(result);
  } catch (err) {
    // Surface 502 from AI service failures directly
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
};

module.exports = { getMessages, sendMessage };
