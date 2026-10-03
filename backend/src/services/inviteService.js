const pool = require('../db/postgres');
const { httpError } = require('../utils/http');

const INVITE_TTL_DAYS = 14;

const normalizeEmail = (email) => String(email).normalize('NFKC').trim().toLowerCase();

/**
 * Creates (or refreshes) a pending invitation. The caller always gets the same answer whether or not the
 * address belongs to a verified account or the person is already a member, so this cannot be used to find
 * out who is registered.
 */
const createInvite = async (workspaceId, invitedBy, email, role = 'member') => {
  const { rows } = await pool.query(
    `SELECT id FROM users WHERE email = $1 AND email_verified_at IS NOT NULL LIMIT 1`,
    [normalizeEmail(email)],
  );
  const user = rows[0];
  if (!user) return;
  const { rows: member } = await pool.query(
    `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, user.id],
  );
  if (member.length > 0) return;
  await pool.query(
    `INSERT INTO workspace_invites (workspace_id, invited_user_id, invited_by, role)
          VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, invited_user_id)
       DO UPDATE SET invited_by = EXCLUDED.invited_by, role = EXCLUDED.role, created_at = NOW()`,
    [workspaceId, user.id, invitedBy, role],
  );
};

const liveFilter = `i.created_at > NOW() - INTERVAL '${INVITE_TTL_DAYS} days'`;

/** Pending invitations addressed to this user. */
const listForUser = async (userId) => {
  const { rows } = await pool.query(
    `SELECT i.id, i.workspace_id, w.name AS workspace_name, i.role, i.created_at, u.name AS invited_by_name
       FROM workspace_invites i
       JOIN workspaces w ON w.id = i.workspace_id
  LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.invited_user_id = $1 AND ${liveFilter}
      ORDER BY i.created_at DESC`,
    [userId],
  );
  return rows;
};

/** Pending invitations of a workspace (owner view). Names only: no email of people who have not accepted. */
const listForWorkspace = async (workspaceId) => {
  const { rows } = await pool.query(
    `SELECT i.id, i.role, i.created_at, u.name AS invited_name
       FROM workspace_invites i JOIN users u ON u.id = i.invited_user_id
      WHERE i.workspace_id = $1 AND ${liveFilter}
      ORDER BY i.created_at DESC`,
    [workspaceId],
  );
  return rows;
};

const withTransaction = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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

/** Consumes the invitation and creates the membership atomically. Returns the workspace id. */
const accept = async (inviteId, userId) => withTransaction(async (client) => {
  const { rows } = await client.query(
    `DELETE FROM workspace_invites i
      WHERE i.id = $1 AND i.invited_user_id = $2 AND ${liveFilter}
  RETURNING i.workspace_id, i.role`,
    [inviteId, userId],
  );
  if (rows.length === 0) throw httpError(404, 'Invitation not found or expired');
  await client.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role, joined_at)
          VALUES ($1, $2, $3, NOW())
     ON CONFLICT (workspace_id, user_id) DO NOTHING`,
    [rows[0].workspace_id, userId, rows[0].role],
  );
  return rows[0].workspace_id;
});

const decline = async (inviteId, userId) => {
  const { rowCount } = await pool.query(
    `DELETE FROM workspace_invites WHERE id = $1 AND invited_user_id = $2`,
    [inviteId, userId],
  );
  if (rowCount === 0) throw httpError(404, 'Invitation not found or expired');
};

/** Owner withdraws an invitation. */
const cancel = async (workspaceId, inviteId) => {
  const { rowCount } = await pool.query(
    `DELETE FROM workspace_invites WHERE id = $1 AND workspace_id = $2`,
    [inviteId, workspaceId],
  );
  if (rowCount === 0) throw httpError(404, 'Invitation not found');
};

module.exports = { createInvite, listForUser, listForWorkspace, accept, decline, cancel, INVITE_TTL_DAYS };
