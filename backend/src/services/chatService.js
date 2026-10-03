const aiClient = require('./aiClient');
const pool  = require('../db/postgres');

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

  // Cursor-based pagination. The cursor is a JS Date (millisecond precision) while created_at has
  // microseconds, so compare at millisecond precision and include ties (the client merges by id)
  // rather than skipping rows that share the cursor's millisecond.
  if (before) {
    params.push(before);
    query += ` AND date_trunc('milliseconds', cm.created_at) <= $${params.length}::timestamptz`;
  }

  // Take the NEWEST `limit` rows (older than the cursor, if any), then return them oldest-first.
  params.push(limit);
  query += ` ORDER BY cm.created_at DESC LIMIT $${params.length}`;

  const { rows } = await pool.query(query, params);
  return rows.reverse();
};

const HISTORY_LIMIT = 10;
// The AI service retries transient provider failures and Pro runs in thinking
// mode, so allow well beyond a single model call.
const AI_TIMEOUT_MS = 150_000;

/** Last turns of this workspace's conversation, oldest first (before the new message is stored). */
const loadHistory = async (client, workspaceId) => {
  const { rows } = await client.query(
    `SELECT role, content FROM chat_messages
      WHERE workspace_id = $1 AND role IN ('user', 'assistant')
      ORDER BY created_at DESC LIMIT $2`,
    [workspaceId, HISTORY_LIMIT],
  );
  return rows.reverse();
};

const readStreamText = (stream) => new Promise((resolve) => {
  const chunks = [];
  stream.on('data', (c) => chunks.push(c));
  stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  stream.on('error', () => resolve(''));
});

/**
 * Turn an AI-service failure into a backend error. Only statuses that are
 * meaningful to the user (rate limit / not configured / timeout) keep their
 * code and the AI service's own safe message; everything else is a generic 502.
 */
const mapAiError = async (err) => {
  const status = err.response && err.response.status;
  let data = err.response && err.response.data;
  if (data && typeof data.on === 'function') {
    try { data = JSON.parse(await readStreamText(data)); } catch (_) { data = null; }
  }
  console.error(`[Chat] AI service error: ${err.message}${data && data.code ? ` (${data.code})` : ''}`);
  if ([429, 503, 504].includes(status) && data && typeof data.detail === 'string') {
    return Object.assign(new Error(data.detail), { status, code: data.code, mapped: true });
  }
  return Object.assign(new Error('The AI service is unavailable'), { status: 502, mapped: true });
};

const buildAiPayload = (workspaceId, userId, message, history, options) => ({
  workspace_id: workspaceId,
  message,
  conversation_history: history,
  user_id: userId,
  ...(options.sourceIds ? { source_ids: options.sourceIds } : {}),
  ...(options.task ? { task: options.task } : {}),
});

/** What we keep with an assistant message: citations (as before) plus how the answer was produced. */
const buildMetadata = (ai) => ({
  citations: ai.citations || [],
  grounding: ai.grounding || null,
  warnings: ai.warnings || [],
  task: ai.task || null,
  model: ai.route || null,   // provider, tier, model_requested, model_used, fallback_used, attempts ...
  usage: ai.usage || null,   // token counts when the provider reports them
});

/**
 * Consume the AI service's server-sent events: `delta` {text} pieces (forwarded
 * to onDelta), then one `result` (the authoritative answer with resolved
 * citations) or one `error`. Resolves with the result payload.
 */
const streamFromAi = async (payload, onDelta) => {
  const response = await aiClient.postStream('/chat/stream', payload, { timeout: AI_TIMEOUT_MS });
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    const fail = (status, message, code) =>
      finish(reject, Object.assign(new Error(message), { status, code, mapped: true }));

    const handleEvent = (raw) => {
      const lines = raw.split('\n');
      const event = (lines.find((l) => l.startsWith('event:')) || '').slice(6).trim();
      const dataLine = lines.find((l) => l.startsWith('data:'));
      if (!event || !dataLine) return;
      let data;
      try { data = JSON.parse(dataLine.slice(5).trim()); } catch (_) { return; }
      if (event === 'delta' && typeof data.text === 'string') {
        try { onDelta(data.text); } catch (_) { /* a broken listener must not abort the answer */ }
      } else if (event === 'result') {
        finish(resolve, data);
      } else if (event === 'error') {
        if (data.code === 'provider_rate_limited') fail(429, data.message, data.code);
        else if (data.code === 'provider_timeout') fail(504, data.message, data.code);
        else fail(502, 'The AI service is unavailable', data.code);
      }
    };

    response.data.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        handleEvent(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
      }
    });
    response.data.on('end', () => fail(502, 'The AI service ended the response early'));
    response.data.on('error', () => fail(502, 'The AI service is unavailable'));
  });
};

/**
 * sendChatMessage
 * ────────────────
 * Stores the user's message, asks the AI service (workspace-scoped RAG with
 * citations) and stores/broadcasts the reply. Conversation history is always
 * the last turns of this workspace's stored conversation (never client input),
 * so follow-up questions work identically from every entry point.
 *
 * @param {string} workspaceId
 * @param {string} userId
 * @param {string} message
 * @param {Array}  [conversation_history]
 * @param {Object} [options]  - { sourceIds?: string[], task?: 'chat'|'study'|'research',
 *                                 onDelta?: (text) => void }  onDelta switches to streaming
 * @returns {Promise<Object>}   - { userMessage, aiMessage }
 */
const sendChatMessage = async (workspaceId, userId, message, conversation_history = [], options = {}) => {
  // History is always read from this workspace's stored conversation. The
  // `conversation_history` argument is accepted for API compatibility but
  // ignored: client-supplied turns are untrusted (a caller could forge
  // assistant/system turns to steer the model).
  void conversation_history;
  const askedAt = new Date();

  // 1. Read history on a short-lived connection. No connection or transaction is
  //    held while the (slow) model call runs, so concurrent chats cannot exhaust the pool.
  const reader = await pool.connect();
  let history;
  try {
    history = await loadHistory(reader, workspaceId);
  } finally {
    reader.release();
  }

  // 2. Ask the AI service
  let ai;
  try {
    const payload = buildAiPayload(workspaceId, userId, message, history, options);
    ai = options.onDelta
      ? await streamFromAi(payload, options.onDelta)
      : (await aiClient.post('/chat', payload, { timeout: AI_TIMEOUT_MS })).data;
  } catch (aiErr) {
    // Nothing was stored: a question whose answer failed is not kept.
    throw aiErr.mapped ? aiErr : await mapAiError(aiErr);
  }

  // 3. Persist the question and the answer together, in order, in one short transaction.
  const client = await pool.connect();
  let userMessage;
  let aiMessage;
  try {
    await client.query('BEGIN');
    const { rows: userMsgRows } = await client.query(
      `INSERT INTO chat_messages (workspace_id, user_id, role, content, created_at)
            VALUES ($1, $2, 'user', $3, $4)
         RETURNING *`,
      [workspaceId, userId, message, askedAt],
    );
    userMessage = userMsgRows[0];
    const { rows: aiMsgRows } = await client.query(
      `INSERT INTO chat_messages (workspace_id, user_id, role, content, metadata, created_at)
            VALUES ($1, NULL, 'assistant', $2, $3, clock_timestamp())
         RETURNING *`,
      [workspaceId, ai.answer || '', JSON.stringify(buildMetadata(ai))]
    );
    aiMessage = aiMsgRows[0];
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }

  // REST callers rely on this broadcast to deliver the answer to the room (published only after
  // the commit). The socket handler emits both messages itself and passes broadcast:false so
  // members don't receive the answer twice.
  if (options.broadcast !== false) {
    try {
      const redis = require('../db/redis');
      Promise.resolve(redis.publish('ai_updates', JSON.stringify({
        workspaceId,
        type: 'chat:message',
        data: aiMessage,
      }))).catch((e) => console.warn(`[Chat] publish failed: ${e.message}`));
    } catch (e) {
      console.warn(`[Chat] publish failed: ${e.message}`);
    }
  }

  return { userMessage, aiMessage };
};

module.exports = { getChatMessages, sendChatMessage, mapAiError, buildMetadata };
