const memberService = require('../services/memberService');

/**
 * listMembers — GET /workspaces/:workspaceId/members
 * Returns all members of the workspace. Accessible by any member.
 */
const listMembers = async (req, res, next) => {
  try {
    const members = await memberService.listMembers(req.params.workspaceId);
    res.json(members);
  } catch (err) {
    next(err);
  }
};

/**
 * addMember — POST /workspaces/:workspaceId/members
 * Body: { email: string, role?: 'member' | 'admin' | 'owner' }
 * Requires owner role.
 */
const addMember = async (req, res, next) => {
  try {
    const { email, role = 'member' } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    const validRoles = ['member', 'admin', 'owner'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}` });
    }

    const membership = await memberService.addMember(req.params.workspaceId, email, role);
    res.status(201).json(membership);
  } catch (err) {
    // Propagate known status codes (404 user not found, 409 already member)
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
};

/**
 * removeMember — DELETE /workspaces/:workspaceId/members/:userId
 * Requires owner role. Owners cannot remove themselves (guard below).
 */
const removeMember = async (req, res, next) => {
  try {
    const { workspaceId, userId } = req.params;

    // Prevent self-removal of the requesting owner
    if (userId === req.user.id) {
      return res.status(400).json({ error: 'You cannot remove yourself from the workspace' });
    }

    const wasRemoved = await memberService.removeMember(workspaceId, userId);

    if (!wasRemoved) {
      return res.status(404).json({ error: 'Member not found in this workspace' });
    }

    res.status(204).end();
  } catch (err) {
    next(err);
  }
};

module.exports = { listMembers, addMember, removeMember };
