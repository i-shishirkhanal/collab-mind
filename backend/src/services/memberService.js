const pool = require('../db/postgres');

/**
 * Role changes and removals run under a row lock on the workspace so two owners
 * demoting/removing each other at the same time cannot leave it ownerless.
 */
const withWorkspaceLock = async (workspaceId, fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM workspaces WHERE id = $1 FOR UPDATE', [workspaceId]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
};

const ownerCount = async (client, workspaceId) => {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS n FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'`,
    [workspaceId],
  );
  return rows[0].n;
};

/**
 * updateMemberRole
 * ─────────────────
 * Changes a member's role within a workspace.
 *
 * @param {string} workspaceId
 * @param {string} userId
 * @param {string} role         - 'member' | 'admin' | 'owner'
 * @returns {Promise<Object|null>} - The updated row, or null if not a member
 */
const updateMemberRole = async (workspaceId, userId, role) => {
  return withWorkspaceLock(workspaceId, async (client) => {
    const { rows: current } = await client.query(
      `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId],
    );
    if (!current[0]) return null;
    if (current[0].role === 'owner' && role !== 'owner' && (await ownerCount(client, workspaceId)) <= 1) {
      throw Object.assign(new Error('A workspace must keep at least one owner'), { status: 409 });
    }
    const { rows } = await client.query(
      `UPDATE workspace_members SET role = $3
        WHERE workspace_id = $1 AND user_id = $2
       RETURNING *`,
      [workspaceId, userId, role],
    );
    return rows[0] || null;
  });
};

/**
 * removeMember
 * ─────────────
 * Removes a user from a workspace.
 * It is a no-op if the user is not currently a member (idempotent).
 *
 * @param {string} workspaceId
 * @param {string} userId       - The user id to remove
 * @returns {Promise<boolean>}  - true if a row was deleted, false otherwise
 */
const removeMember = async (workspaceId, userId) => {
  return withWorkspaceLock(workspaceId, async (client) => {
    const { rows: current } = await client.query(
      `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId],
    );
    if (!current[0]) return false;
    if (current[0].role === 'owner' && (await ownerCount(client, workspaceId)) <= 1) {
      throw Object.assign(new Error('A workspace must keep at least one owner'), { status: 409 });
    }
    await client.query(
      `DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId],
    );
    return true;
  });
};

/**
 * listMembers
 * ────────────
 * Returns all members of a workspace with user profile information.
 *
 * @param {string} workspaceId
 * @returns {Promise<Array>}
 */
const listMembers = async (workspaceId) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.id AS user_id, u.email, u.name, u.avatar_url, wm.role, wm.joined_at
       FROM workspace_members wm
       JOIN users u ON u.id = wm.user_id
      WHERE wm.workspace_id = $1
      ORDER BY wm.joined_at ASC`,
    [workspaceId],
  );
  return rows;
};

module.exports = { removeMember, listMembers, updateMemberRole };
