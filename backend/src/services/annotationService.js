const pool = require('../db/postgres');
const { httpError, isUuid } = require('../utils/http');

function commentInput(body) {
  const text = typeof body?.body === 'string' ? body.body.trim() : '';
  const mentions = body?.mentions ?? [];
  if (!text || text.length > 4000) throw httpError(400, 'Comment must contain 1–4000 characters');
  if (!Array.isArray(mentions) || mentions.length > 20 || mentions.some((id) => !isUuid(id))) {
    throw httpError(400, 'Choose up to 20 workspace members to mention');
  }
  return { text, mentions: [...new Set(mentions)] };
}

const transaction = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
};

async function insertComment(client, workspaceId, annotationId, userId, input) {
  const { text, mentions } = commentInput(input);
  if (mentions.length) {
    const { rows } = await client.query(
      'SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND user_id = ANY($2::uuid[]) FOR SHARE',
      [workspaceId, mentions],
    );
    if (rows.length !== mentions.length) throw httpError(400, 'Mentions must be current workspace members');
  }
  const { rows } = await client.query(
    'INSERT INTO annotation_comments (annotation_id, user_id, body) VALUES ($1,$2,$3) RETURNING id',
    [annotationId, userId, text],
  );
  if (mentions.length) await client.query(
    'INSERT INTO annotation_mentions (comment_id, user_id) SELECT $1, unnest($2::uuid[])', [rows[0].id, mentions],
  );
  await client.query('UPDATE source_annotations SET updated_at = NOW() WHERE id = $1', [annotationId]);
  return rows[0];
}

async function create(workspaceId, sourceId, userId, input) {
  const { chunk_index: index, start_offset: start, end_offset: end, chunk_content: snapshot } = input || {};
  if (!Number.isInteger(index) || index < 0 || !Number.isInteger(start) || !Number.isInteger(end)
      || start < 0 || end <= start || end - start > 4000 || typeof snapshot !== 'string' || snapshot.length > 50000) {
    throw httpError(400, 'Select a passage of up to 4000 characters');
  }
  commentInput(input);
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT sc.content FROM source_chunks sc JOIN sources s ON s.id = sc.source_id
       WHERE sc.workspace_id = $1 AND sc.source_id = $2 AND sc.chunk_index = $3 AND s.status = 'ready'
       FOR SHARE OF sc, s`, [workspaceId, sourceId, index],
    );
    if (!rows[0]) throw httpError(404, 'Indexed passage not found');
    const content = rows[0].content;
    if (content !== snapshot || end > content.length) throw httpError(409, 'The passage changed. Reload it before annotating.');
    const quote = content.slice(start, end);
    if (!quote.trim()) throw httpError(400, 'Select some text to annotate');
    const result = await client.query(
      `INSERT INTO source_annotations
       (workspace_id, source_id, chunk_index, chunk_content, start_offset, end_offset, quote, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [workspaceId, sourceId, index, content, start, end, quote, userId],
    );
    await insertComment(client, workspaceId, result.rows[0].id, userId, input);
    return result.rows[0];
  });
}

async function list(workspaceId, sourceId, after = null, annotationId = null) {
  const { rows } = await pool.query(
    `SELECT a.*, u.name AS author_name, r.name AS resolved_by_name,
      NOT EXISTS (SELECT 1 FROM source_chunks sc WHERE sc.workspace_id = a.workspace_id
        AND sc.source_id = a.source_id AND sc.chunk_index = a.chunk_index AND sc.content = a.chunk_content) AS stale,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'body', c.body, 'user_id', c.user_id,
        'author_name', cu.name, 'created_at', c.created_at, 'mentions',
        COALESCE((SELECT jsonb_agg(jsonb_build_object('user_id', m.user_id, 'name', mu.name))
          FROM annotation_mentions m JOIN users mu ON mu.id = m.user_id WHERE m.comment_id = c.id), '[]'::jsonb))
        ORDER BY c.created_at, c.id)
        FROM annotation_comments c LEFT JOIN users cu ON cu.id = c.user_id WHERE c.annotation_id = a.id), '[]'::jsonb) AS comments
     FROM source_annotations a LEFT JOIN users u ON u.id = a.created_by LEFT JOIN users r ON r.id = a.resolved_by
     WHERE a.workspace_id = $1 AND a.source_id = $2
       AND ($4::uuid IS NULL OR a.id = $4::uuid)
       AND ($3::uuid IS NULL OR (a.created_at, a.id) <
         (SELECT cursor.created_at, cursor.id FROM source_annotations cursor
          WHERE cursor.id = $3::uuid AND cursor.workspace_id = $1 AND cursor.source_id = $2))
     ORDER BY a.created_at DESC, a.id DESC LIMIT 51`, [workspaceId, sourceId, after, annotationId],
  );
  const annotations = rows.slice(0, 50).map(({ chunk_content, ...row }) => ({ ...row, snapshot: chunk_content }));
  return { annotations, next: rows.length > 50 ? annotations[49].id : null };
}

async function reply(workspaceId, sourceId, annotationId, userId, input) {
  return transaction(async (client) => {
    const { rows } = await client.query(
      'SELECT resolved FROM source_annotations WHERE id = $1 AND workspace_id = $2 AND source_id = $3 FOR UPDATE',
      [annotationId, workspaceId, sourceId],
    );
    if (!rows[0]) throw httpError(404, 'Discussion not found');
    if (rows[0].resolved) throw httpError(409, 'Reopen this discussion before replying');
    return insertComment(client, workspaceId, annotationId, userId, input);
  });
}

async function resolve(workspaceId, sourceId, annotationId, userId, role, resolved) {
  if (typeof resolved !== 'boolean') throw httpError(400, 'resolved must be true or false');
  const { rows } = await pool.query(
    `UPDATE source_annotations SET resolved = $4, resolved_by = CASE WHEN $4 THEN $5::uuid ELSE NULL END,
       updated_at = NOW() WHERE id = $1 AND workspace_id = $2 AND source_id = $3
       AND (created_by = $5 OR $6::boolean) RETURNING id`,
    [annotationId, workspaceId, sourceId, resolved, userId, ['owner', 'admin'].includes(role)],
  );
  if (!rows[0]) throw httpError(403, 'Only the discussion author or a workspace admin can resolve or reopen it');
  return rows[0];
}

module.exports = { create, list, reply, resolve, commentInput };
