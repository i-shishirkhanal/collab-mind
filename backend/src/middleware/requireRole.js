const { ROLES: ROLE_HIERARCHY, roleAtLeast } = require('../services/workspaceAccess');

/**
 * requireRole(role) — middleware factory enforcing a minimum workspace role
 * (member < admin < owner). Must run AFTER requireWorkspaceMember.
 * Unknown/missing roles are denied.
 */
const requireRole = (requiredRole) => {
  if (!ROLE_HIERARCHY.includes(requiredRole)) {
    throw new Error(`requireRole: unknown role "${requiredRole}". Valid roles: ${ROLE_HIERARCHY.join(', ')}`);
  }

  return (req, res, next) => {
    const userRole = req.membership?.role;
    if (!userRole) {
      return res.status(403).json({ error: 'Membership information missing — check middleware order' });
    }
    if (!roleAtLeast(userRole, requiredRole)) {
      return res.status(403).json({ error: `Insufficient role. Required: "${requiredRole}", your role: "${userRole}"` });
    }
    next();
  };
};

module.exports = requireRole;
