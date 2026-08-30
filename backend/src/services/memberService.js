const pool = require('../db/postgres');

/**
 * addMember
 * ──────────
 * Adds a user (looked up by email) to a workspace with the given role.
 * Throws a 404-status error if the email is not found in the users table.
 * Throws a 409-status error if the user is already a member.
 *
 * @param {string} workspaceId
 * @param {string} email       - Email of the user to invite
 * @param {string} role        - 'member' | 'admin' | 'owner'
 * @returns {Promise<Object>}  - The new workspace_members row
 */
const addMember = async (workspaceId, email, role = 'member') => {
  // 1. Resolve email → user id
  const { rows: userRows } = await pool.query(
    `SELECT id FROM users WHERE email = $1 LIMIT 1`,
    [email],
  );

  if (userRows.length === 0) {
    throw Object.assign(
      new Error(`No user found with email "${email}"`),
      { status: 404 },
    );
  }

  const userId = userRows[0].id;

  // 2. Insert membership (fails with unique-constraint if already a member)
  try {
    const { rows } = await pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, joined_at)
            VALUES ($1, $2, $3, NOW())
         RETURNING *`,
      [workspaceId, userId, role],
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505') { // unique_violation
      throw Object.assign(
        new Error('User is already a member of this workspace'),
        { status: 409 },
      );
    }
    throw err;
  }
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
  const { rowCount } = await pool.query(
    `DELETE FROM workspace_members
      WHERE workspace_id = $1
        AND user_id      = $2`,
    [workspaceId, userId],
  );
  return rowCount > 0;
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
    `SELECT u.id, u.email, u.name, u.avatar_url, wm.role, wm.joined_at
       FROM workspace_members wm
       JOIN users u ON u.id = wm.user_id
      WHERE wm.workspace_id = $1
      ORDER BY wm.joined_at ASC`,
    [workspaceId],
  );
  return rows;
};

module.exports = { addMember, removeMember, listMembers };
