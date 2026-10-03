const { v4: uuidv4 } = require('uuid');
const pool = require('../db/postgres');

/**
 * getUserWorkspaces
 * ──────────────────
 * Returns all workspaces that a user is a member of, along with their role.
 *
 * @param {string} userId
 * @returns {Promise<Array>}
 */
const getUserWorkspaces = async (userId) => {
  const { rows } = await pool.query(
    `SELECT w.id, w.name, w.description, w.avatar_url, w.created_at,
            wm.role, wm.joined_at,
            (SELECT COUNT(*)::int FROM workspace_members m WHERE m.workspace_id = w.id) AS member_count,
            (SELECT COUNT(*)::int FROM sources s WHERE s.workspace_id = w.id) AS source_count,
            (SELECT COUNT(*)::int FROM sources s
              WHERE s.workspace_id = w.id AND s.status = 'processing') AS processing_count,
            (SELECT COUNT(*)::int FROM sources s
              WHERE s.workspace_id = w.id AND s.status = 'failed') AS failed_count,
            (SELECT COUNT(*)::int FROM agent_runs r
              WHERE r.workspace_id = w.id AND r.status = 'awaiting_approval') AS pending_approvals,
            GREATEST(
              w.updated_at,
              (SELECT MAX(c.created_at) FROM chat_messages c WHERE c.workspace_id = w.id),
              (SELECT MAX(s.created_at) FROM sources s WHERE s.workspace_id = w.id),
              (SELECT MAX(r.updated_at) FROM agent_runs r WHERE r.workspace_id = w.id)
            ) AS last_activity_at
       FROM workspaces w
       JOIN workspace_members wm ON wm.workspace_id = w.id
      WHERE wm.user_id = $1
      ORDER BY w.created_at DESC`,
    [userId],
  );
  return rows;
};

/**
 * getRecentActivity
 * ─────────────────
 * Latest questions, uploads and agent runs across every workspace the user belongs to, newest first.
 *
 * @param {string} userId
 * @param {number} [limit=8]
 * @returns {Promise<Array>} [{ kind, workspace_id, workspace_name, actor_name, label, status, created_at }]
 */
const getRecentActivity = async (userId, limit = 8) => {
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT 'question' AS kind, w.id AS workspace_id, w.name AS workspace_name,
              u.name AS actor_name, LEFT(c.content, 140) AS label, NULL AS status, c.created_at
         FROM chat_messages c
         JOIN workspaces w ON w.id = c.workspace_id
         JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = $1
         LEFT JOIN users u ON u.id = c.user_id
        WHERE c.role = 'user'
       UNION ALL
       SELECT 'source', w.id, w.name, u.name, s.name, s.status, s.created_at
         FROM sources s
         JOIN workspaces w ON w.id = s.workspace_id
         JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = $1
         LEFT JOIN users u ON u.id = s.created_by
       UNION ALL
       SELECT 'agent', w.id, w.name, u.name, r.agent_type, r.status, r.created_at
         FROM agent_runs r
         JOIN workspaces w ON w.id = r.workspace_id
         JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = $1
         LEFT JOIN users u ON u.id = r.user_id
     ) activity
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return rows;
};

/**
 * createWorkspace
 * ────────────────
 * Creates a new workspace and automatically adds the creator as its owner.
 * Both operations run in a single transaction for atomicity.
 *
 * @param {string} userId        - Creator's user id
 * @param {Object} data          - { name, description?, avatar_url? }
 * @returns {Promise<Object>}    - The newly created workspace row
 */
const createWorkspace = async (userId, { name, description = null, avatar_url = null }) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const workspaceId = uuidv4();

    const { rows: wsRows } = await client.query(
      `INSERT INTO workspaces (id, name, description, avatar_url, created_by, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         RETURNING *`,
      [workspaceId, name, description, avatar_url, userId],
    );

    // Automatically add creator as owner
    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, joined_at)
            VALUES ($1, $2, 'owner', NOW())
       ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [workspaceId, userId],
    );

    await client.query('COMMIT');
    return wsRows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

/**
 * getWorkspaceById
 * ─────────────────
 * Fetches a single workspace by its id.
 *
 * @param {string} workspaceId
 * @returns {Promise<Object|null>}
 */
const getWorkspaceById = async (workspaceId) => {
  const { rows } = await pool.query(
    `SELECT * FROM workspaces WHERE id = $1`,
    [workspaceId],
  );
  return rows[0] || null;
};

/**
 * updateWorkspace
 * ────────────────
 * Partially updates a workspace's mutable fields.
 *
 * @param {string} workspaceId
 * @param {Object} data - { name?, description?, avatar_url? }
 * @returns {Promise<Object>} Updated workspace row
 */
const updateWorkspace = async (workspaceId, { name, description, avatar_url }) => {
  const { rows } = await pool.query(
    `UPDATE workspaces
        SET name        = COALESCE($1, name),
            description = COALESCE($2, description),
            avatar_url  = COALESCE($3, avatar_url),
            updated_at  = NOW()
      WHERE id = $4
  RETURNING *`,
    [name ?? null, description ?? null, avatar_url ?? null, workspaceId],
  );
  return rows[0] || null;
};

/**
 * deleteWorkspace
 * ────────────────
 * Hard-deletes a workspace. Cascade constraints in DB handle related rows; the
 * workspace's uploaded files are removed from storage afterwards.
 *
 * @param {string} workspaceId
 * @returns {Promise<void>}
 */
const deleteWorkspace = async (workspaceId) => {
  // Cascades remove the rows (sources, chunks, chat, runs) but not the uploaded
  // files, so remember where they are and remove them once the delete succeeded.
  const { rows: stored } = await pool.query(
    `SELECT url FROM sources WHERE workspace_id = $1 AND type NOT IN ('url', 'youtube') AND url IS NOT NULL`,
    [workspaceId],
  );
  await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
  const { deleteStoredFile } = require('./storageService'); // lazy: pulls in the GCS client
  await Promise.all(stored.map((r) => deleteStoredFile(r.url))); // best-effort, never throws
};

module.exports = { getUserWorkspaces, getRecentActivity, createWorkspace, getWorkspaceById, updateWorkspace, deleteWorkspace };
