const axios = require('axios');
const pool  = require('../db/postgres');

// Base URL of the Python AI service (FastAPI)
const AI_SERVICE_URL = () => process.env.AI_SERVICE_URL || 'http://localhost:8000';

/**
 * getChatMessages
 * ────────────────
 * Fetches paginated chat messages for a workspace from the database.
 * Messages are returned in ascending (chronological) order so the UI
 * can render them top-to-bottom.
 *
 * @param {string} workspaceId
 * @param {number} [limit=50]    - Max messages to return
 * @param {string} [before]      - ISO timestamp cursor — only return messages BEFORE this time
 * @returns {Promise<Array>}
 */
const getChatMessages = async (workspaceId, limit = 50, before = null) => {
  let query = `
    SELECT cm.id, cm.workspace_id, cm.user_id, cm.role, cm.content,
           cm.metadata, cm.created_at,
           u.name AS user_name, u.avatar_url AS user_avatar
      FROM chat_messages cm
 LEFT JOIN users u ON u.id = cm.user_id
     WHERE cm.workspace_id = $1
  `;
  const params = [workspaceId];

  // Cursor-based pagination: fetch messages before a given timestamp
  if (before) {
    params.push(before);
    query += ` AND cm.created_at < $${params.length}`;
  }

  params.push(limit);
  query += ` ORDER BY cm.created_at ASC LIMIT $${params.length}`;

  const { rows } = await pool.query(query, params);
  return rows;
};

/**
 * sendChatMessage
 * ────────────────
 * Stores the user's message in the database, then proxies the conversation to
 * the Python AI service (FastAPI at AI_SERVICE_URL) to generate an AI reply.
 * The AI response is also persisted before being returned.
 *
 * @param {string} workspaceId
 * @param {string} userId
 * @param {string} message      - The user's raw message text
 * @returns {Promise<Object>}   - { userMessage, aiMessage }
 */
const sendChatMessage = async (workspaceId, userId, message, conversation_history = []) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Persist the user's message
    const { rows: userMsgRows } = await client.query(
      `INSERT INTO chat_messages (workspace_id, user_id, role, content, created_at)
            VALUES ($1, $2, 'user', $3, NOW())
         RETURNING *`,
      [workspaceId, userId, message],
    );
    const userMessage = userMsgRows[0];

    // 2. Proxy to AI service
    let aiContent, citations;
    try {
      const aiResponse = await axios.post(
        `${AI_SERVICE_URL()}/chat`,
        { workspace_id: workspaceId, message, conversation_history },
        { timeout: 30_000 },
      );
      aiContent = aiResponse.data?.answer || '';
      citations = aiResponse.data?.citations || [];
    } catch (aiErr) {
      await client.query('ROLLBACK');
      throw Object.assign(
        new Error(`AI service error: ${aiErr.message}`),
        { status: 502 },
      );
    }

    // 3. Persist the AI response
    const { rows: aiMsgRows } = await client.query(
      `INSERT INTO chat_messages (workspace_id, user_id, role, content, metadata, created_at)
            VALUES ($1, NULL, 'assistant', $2, $3, NOW())
         RETURNING *`,
      [workspaceId, aiContent, JSON.stringify({ citations })]
    );
    const aiMessage = aiMsgRows[0];
    
    const redis = require('../db/redis');
    redis.publish('ai_updates', JSON.stringify({
      workspaceId: workspaceId,
      type: 'chat:message',
      data: aiMessage
    }));

    await client.query('COMMIT');
    return { userMessage, aiMessage };
  } catch (err) {
    // Only rollback if we haven't already (AI error path already ROLLBACK'd)
    if (client._connected) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    }
    throw err;
  } finally {
    client.release();
  }
};

module.exports = { getChatMessages, sendChatMessage };
