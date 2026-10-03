const pool = require('../db/postgres');
const realtime = require('./realtime');
const chatStorage = require('./chatStorage');
const { assertMember } = require('./conversationService');
const { httpError, isUuid } = require('../utils/http');

const MAX_BODY = 4000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

// Allow-list on purpose: HTML/SVG/JS would be stored-XSS vectors, executables are malware vectors.
const ALLOWED_FILE_TYPES = [
  /^image\/(png|jpeg|gif|webp)$/,
  /^audio\//,
  /^video\//,
  /^application\/pdf$/,
  /^application\/zip$/,
  /^application\/vnd\.openxmlformats-officedocument\./,
  /^application\/msword$/,
  /^application\/vnd\.ms-(excel|powerpoint)$/,
  /^text\/(plain|csv|markdown)$/,
];

const isAllowedFileType = (mime) => ALLOWED_FILE_TYPES.some((re) => re.test(mime || ''));

const startsWith = (buf, bytes) => bytes.every((b, i) => buf[i] === b);

/**
 * The MIME type comes from the client, so for the types we can verify, the file's leading bytes must
 * match it (an HTML page labelled image/png is rejected). Types without a reliable signature
 * (audio/video, legacy Office) are accepted on the allow-list alone.
 */
const contentMatchesType = (mime, buf) => {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return false;
  switch (true) {
    case mime === 'image/png': return startsWith(buf, [0x89, 0x50, 0x4e, 0x47]);
    case mime === 'image/jpeg': return startsWith(buf, [0xff, 0xd8, 0xff]);
    case mime === 'image/gif': return startsWith(buf, [0x47, 0x49, 0x46, 0x38]);
    case mime === 'image/webp': return startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && buf.subarray(8, 12).toString('latin1') === 'WEBP';
    case mime === 'application/pdf': return buf.subarray(0, 1024).includes('%PDF-');
    case mime === 'application/zip' || mime.startsWith('application/vnd.openxmlformats-officedocument.'):
      return startsWith(buf, [0x50, 0x4b, 0x03, 0x04]);
    case /^text\/(plain|csv|markdown)$/.test(mime): return !buf.subarray(0, 8192).includes(0);
    default: return true;
  }
};

const MESSAGE_SELECT = `
  SELECT m.id, m.conversation_id, m.sender_id, m.kind, m.body, m.created_at, m.deleted_at,
         m.attachment_name, m.attachment_type, m.attachment_size, m.reply_to_id,
         u.name AS sender_name, u.avatar_url AS sender_avatar,
         r.body AS reply_body, r.deleted_at AS reply_deleted_at, ru.name AS reply_sender_name
    FROM messages m
    LEFT JOIN users u  ON u.id = m.sender_id
    LEFT JOIN messages r ON r.id = m.reply_to_id
    LEFT JOIN users ru ON ru.id = r.sender_id`;

/** Shapes a DB row for clients. Never leaks the storage path; hides content of deleted messages. */
const toDto = (r) => {
  const deleted = Boolean(r.deleted_at);
  return {
    id: r.id,
    conversation_id: r.conversation_id,
    sender_id: r.sender_id,
    sender_name: r.sender_name,
    sender_avatar: r.sender_avatar,
    kind: r.kind,
    body: deleted ? '' : r.body,
    attachment: !deleted && r.attachment_name
      ? { name: r.attachment_name, type: r.attachment_type, size: Number(r.attachment_size) }
      : null,
    reply_to: r.reply_to_id
      ? {
          id: r.reply_to_id,
          sender_name: r.reply_sender_name,
          body: r.reply_deleted_at ? '' : (r.reply_body || '').slice(0, 140),
        }
      : null,
    created_at: r.created_at,
    deleted: deleted,
  };
};

const fetchMessage = async (id) => {
  const { rows } = await pool.query(`${MESSAGE_SELECT} WHERE m.id = $1`, [id]);
  return rows[0] ? toDto(rows[0]) : null;
};

/**
 * Oldest-first page of history. `before` is an ISO cursor (created_at of the
 * oldest message the client already has). Also returns each member's read
 * pointer so the client can render read receipts.
 */
const listMessages = async (conversationId, userId, { limit, before }) => {
  await assertMember(conversationId, userId);
  const take = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);

  const params = [conversationId];
  let cursor = '';
  if (before) {
    if (Number.isNaN(Date.parse(before))) throw httpError(400, 'before must be an ISO timestamp');
    params.push(before);
    cursor = `AND m.created_at < $${params.length}`;
  }
  params.push(take + 1);
  const { rows } = await pool.query(
    `${MESSAGE_SELECT}
      WHERE m.conversation_id = $1 ${cursor}
      ORDER BY m.created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  const hasMore = rows.length > take;
  const page = rows.slice(0, take).reverse().map(toDto);

  const reads = await pool.query(
    'SELECT user_id, last_read_at FROM conversation_members WHERE conversation_id = $1',
    [conversationId],
  );
  return {
    messages: page,
    has_more: hasMore,
    read_state: reads.rows.map((r) => ({ user_id: r.user_id, last_read_at: r.last_read_at })),
  };
};

const insertMessage = async ({ conversationId, senderId, kind, body, attachment, replyToId }) => {
  if (replyToId) {
    if (!isUuid(replyToId)) throw httpError(400, 'Invalid replyToId');
    const { rows } = await pool.query(
      'SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2',
      [replyToId, conversationId],
    );
    if (rows.length === 0) throw httpError(400, 'Replied-to message not found in this conversation');
  }

  const client = await pool.connect();
  let id;
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO messages
         (conversation_id, sender_id, kind, body, attachment_path, attachment_name,
          attachment_type, attachment_size, reply_to_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, created_at`,
      [
        conversationId, senderId, kind, body,
        attachment?.path || null, attachment?.name || null,
        attachment?.type || null, attachment?.size || null, replyToId || null,
      ],
    );
    id = ins.rows[0].id;
    await client.query('UPDATE conversations SET last_message_at = $2 WHERE id = $1', [
      conversationId, ins.rows[0].created_at,
    ]);
    // The sender has, by definition, read everything up to their own message.
    await client.query(
      `UPDATE conversation_members SET last_read_at = $3
        WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, senderId, ins.rows[0].created_at],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const dto = await fetchMessage(id);
  realtime.emitToConversation(conversationId, 'message:new', dto);
  return dto;
};

const sendMessage = async (conversationId, userId, { body, replyToId }) => {
  await assertMember(conversationId, userId);
  const text = typeof body === 'string' ? body.trim() : '';
  if (!text) throw httpError(400, 'Message body is required');
  if (text.length > MAX_BODY) throw httpError(400, `Message is too long (max ${MAX_BODY} characters)`);
  return insertMessage({ conversationId, senderId: userId, kind: 'text', body: text, replyToId });
};

const sendAttachment = async (conversationId, userId, file, { body, replyToId } = {}) => {
  await assertMember(conversationId, userId);
  if (!file) throw httpError(400, 'A file is required');
  if (file.size > MAX_FILE_BYTES) throw httpError(413, 'File is too large (max 25 MB)');
  if (!isAllowedFileType(file.mimetype)) throw httpError(415, 'This file type is not allowed');
  if (!contentMatchesType(file.mimetype, file.buffer)) throw httpError(415, 'The file content does not match its type');

  const caption = typeof body === 'string' ? body.trim().slice(0, MAX_BODY) : '';
  const path = await chatStorage.upload(conversationId, file.buffer, file.originalname, file.mimetype);
  return insertMessage({
    conversationId, senderId: userId, kind: 'file', body: caption, replyToId,
    attachment: { path, name: file.originalname.slice(0, 200), type: file.mimetype, size: file.size },
  });
};

const getAttachmentUrl = async (conversationId, messageId, userId) => {
  await assertMember(conversationId, userId);
  const { rows } = await pool.query(
    `SELECT attachment_path, attachment_name FROM messages
      WHERE id = $1 AND conversation_id = $2 AND deleted_at IS NULL AND attachment_path IS NOT NULL`,
    [messageId, conversationId],
  );
  if (rows.length === 0) throw httpError(404, 'Attachment not found');
  const url = await chatStorage.createSignedUrl(rows[0].attachment_path, rows[0].attachment_name);
  return { url, expires_in: 300 };
};

/** Soft delete; only the sender can delete their own message. */
const deleteMessage = async (conversationId, messageId, userId) => {
  await assertMember(conversationId, userId);
  const { rowCount } = await pool.query(
    `UPDATE messages SET deleted_at = NOW()
      WHERE id = $1 AND conversation_id = $2 AND sender_id = $3
        AND deleted_at IS NULL AND kind <> 'system'`,
    [messageId, conversationId, userId],
  );
  if (rowCount === 0) throw httpError(404, 'Message not found');
  realtime.emitToConversation(conversationId, 'message:deleted', { conversationId, messageId });
  return { ok: true };
};

/** Advances the caller's read pointer to now and tells the rest of the conversation. */
const markRead = async (conversationId, userId) => {
  await assertMember(conversationId, userId);
  const { rows } = await pool.query(
    `UPDATE conversation_members SET last_read_at = GREATEST(last_read_at, NOW())
      WHERE conversation_id = $1 AND user_id = $2
  RETURNING last_read_at`,
    [conversationId, userId],
  );
  const lastReadAt = rows[0].last_read_at;
  realtime.emitToConversation(conversationId, 'message:read', { conversationId, userId, lastReadAt });
  return { last_read_at: lastReadAt };
};

module.exports = {
  isAllowedFileType, contentMatchesType, toDto, listMessages, sendMessage, sendAttachment,
  getAttachmentUrl, deleteMessage, markRead, MAX_FILE_BYTES,
};
