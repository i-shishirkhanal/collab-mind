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
  // Ensure user exists in users table before querying
  await pool.query(
    `INSERT INTO users (id, name, email, created_at)
          VALUES ($1, 'Demo Researcher', 'demo@collabmind.ai', NOW())
     ON CONFLICT (id) DO NOTHING`,
    [userId],
  );

  const { rows } = await pool.query(
    `SELECT w.id, w.name, w.description, w.avatar_url, w.created_at,
            wm.role, wm.joined_at
       FROM workspaces w
       JOIN workspace_members wm ON wm.workspace_id = w.id
      WHERE wm.user_id = $1
      ORDER BY w.created_at DESC`,
    [userId],
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

    // Ensure the user exists in users table before creating workspace to avoid FK constraint error
    await client.query(
      `INSERT INTO users (id, name, email, created_at)
            VALUES ($1, 'Demo Researcher', 'demo@collabmind.ai', NOW())
       ON CONFLICT (id) DO NOTHING`,
      [userId],
    );

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
 * Hard-deletes a workspace. Cascade constraints in DB handle related rows.
 *
 * @param {string} workspaceId
 * @returns {Promise<void>}
 */
const deleteWorkspace = async (workspaceId) => {
  await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
};

module.exports = { getUserWorkspaces, createWorkspace, getWorkspaceById, updateWorkspace, deleteWorkspace };
