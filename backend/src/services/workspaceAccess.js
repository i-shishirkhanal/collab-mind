const pool = require('../db/postgres');
const { isUuid } = require('../utils/http');

/**
 * Single source of truth for "is this user in this workspace, and as what?".
 * Used by REST middleware, Socket.io joins and every realtime workspace event.
 *
 * Roles, lowest to highest privilege.
 */
const ROLES = ['member', 'admin', 'owner'];

/**
 * Minimum role for each workspace action. Every route and socket event maps to
 * one of these so permissions are defined once.
 */
const PERMISSIONS = {
  'workspace:read':   'member',
  'workspace:update': 'owner',
  'workspace:delete': 'owner',
  'members:read':     'member',
  'members:manage':   'owner',
  'sources:read':     'member',
  'sources:write':    'member',
  'chat:read':        'member',
  'chat:write':       'member',
  'agents:run':       'member',
  'agents:approve':   'admin',
  'studio:generate':  'member',
  'whiteboard:read':  'member',
  'whiteboard:write': 'member',
};

const roleAtLeast = (role, required) => {
  const have = ROLES.indexOf(role);
  const need = ROLES.indexOf(required);
  return have >= 0 && need >= 0 && have >= need;
};

const can = (role, action) => {
  const required = PERMISSIONS[action];
  return required ? roleAtLeast(role, required) : false;
};

/** @returns {Promise<{user_id,workspace_id,role,joined_at}|null>} */
const getMembership = async (userId, workspaceId) => {
  if (!isUuid(userId) || !isUuid(workspaceId)) return null;
  const { rows } = await pool.query(
    `SELECT user_id, workspace_id, role, joined_at
       FROM workspace_members
      WHERE workspace_id = $1 AND user_id = $2
      LIMIT 1`,
    [workspaceId, userId],
  );
  return rows[0] || null;
};

module.exports = { ROLES, PERMISSIONS, roleAtLeast, can, getMembership };
