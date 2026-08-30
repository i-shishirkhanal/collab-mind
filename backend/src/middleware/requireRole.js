/**
 * requireRole(role) — middleware factory
 * ────────────────────────────────────────
 * Returns a middleware function that enforces a minimum role within a workspace.
 *
 * Must run AFTER `requireWorkspaceMember` because it reads `req.membership.role`
 * which is set by that middleware.
 *
 * Supported roles in ascending privilege order:
 *   member → admin → owner
 *
 * Usage in a route:
 *   router.delete(
 *     '/:workspaceId',
 *     authenticate,
 *     requireWorkspaceMember,
 *     requireRole('owner'),   // only owners may delete
 *     workspaceController.deleteWorkspace,
 *   );
 *
 * @param {string} requiredRole - The exact role string required ('owner', 'admin', 'member')
 * @returns {Function} Express middleware
 */

// Define allowed roles in order of privilege. Higher index = higher privilege.
const ROLE_HIERARCHY = ['member', 'admin', 'owner'];

const requireRole = (requiredRole) => {
  // Validate the argument at definition time to catch typos early
  if (!ROLE_HIERARCHY.includes(requiredRole)) {
    throw new Error(`requireRole: unknown role "${requiredRole}". Valid roles: ${ROLE_HIERARCHY.join(', ')}`);
  }

  /**
   * The actual middleware function returned and used by Express.
   *
   * Flow:
   *  1. Read the user's role from req.membership (set by requireWorkspaceMember).
   *  2. Compare privilege levels using ROLE_HIERARCHY indices.
   *  3. Allow if user's role index >= required role index; else 403.
   */
  return (req, res, next) => {
    // req.membership is guaranteed to exist if requireWorkspaceMember ran first
    const userRole = req.membership?.role;

    if (!userRole) {
      // Defensive: should never happen if middleware order is correct
      return res.status(403).json({ error: 'Membership information missing — check middleware order' });
    }

    const userRoleIndex     = ROLE_HIERARCHY.indexOf(userRole);
    const requiredRoleIndex = ROLE_HIERARCHY.indexOf(requiredRole);

    if (userRoleIndex < requiredRoleIndex) {
      return res.status(403).json({
        error: `Insufficient role. Required: "${requiredRole}", your role: "${userRole}"`,
      });
    }

    next();
  };
};

module.exports = requireRole;
