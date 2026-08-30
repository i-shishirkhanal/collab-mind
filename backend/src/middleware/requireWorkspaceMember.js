const pool = require('../db/postgres');

/**
 * requireWorkspaceMember middleware
 * ──────────────────────────────────
 * Ensures that the authenticated user (req.user) is an active member of the
 * workspace identified by req.params.workspaceId.
 *
 * Must run AFTER the `authenticate` middleware so that req.user is available.
 *
 * Flow:
 *  1. Read workspaceId from route params.
 *  2. Query the `workspace_members` table for a row matching both workspaceId
 *     and the authenticated user's id.
 *  3. If no row is found → 403 Forbidden (user is not a member).
 *  4. If a row is found → attach the full membership record to `req.membership`
 *     so subsequent middleware (e.g. requireRole) can inspect the role without
 *     an extra DB round-trip.
 */
const requireWorkspaceMember = async (req, res, next) => {
  try {
    const { workspaceId } = req.params;
    const userId          = req.user.id;

    if (!workspaceId) {
      return res.status(400).json({ error: 'workspaceId param is required' });
    }

    // ── Query membership ─────────────────────────────────────────────────────
    const { rows } = await pool.query(
      `SELECT wm.user_id, wm.workspace_id, wm.role, wm.joined_at
         FROM workspace_members wm
        WHERE wm.workspace_id = $1
          AND wm.user_id      = $2
        LIMIT 1`,
      [workspaceId, userId],
    );

    // ── Guard: user is not a member ──────────────────────────────────────────
    if (rows.length === 0) {
      return res.status(403).json({ error: 'You are not a member of this workspace' });
    }

    // ── Attach membership to request for downstream use ─────────────────────
    // Shape: { user_id, workspace_id, role, joined_at }
    req.membership = rows[0];

    next();
  } catch (err) {
    next(err); // Delegate to global error handler
  }
};

module.exports = requireWorkspaceMember;
