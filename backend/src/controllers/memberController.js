const memberService = require('../services/memberService');
const { removeUserFromWorkspaceRoom } = require('../services/realtime');

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
 * updateMemberRole — PATCH /workspaces/:workspaceId/members/:userId
 * Body: { role: 'member' | 'admin' | 'owner' }
 * Requires owner role. An owner cannot change their own role (would risk
 * leaving the workspace without an owner).
 */
const updateMemberRole = async (req, res, next) => {
  try {
    const { workspaceId, userId } = req.params;
    const { role } = req.body;

    const validRoles = ['member', 'admin', 'owner'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}` });
    }

    if (userId === req.user.id) {
      return res.status(400).json({ error: 'You cannot change your own role' });
    }

    const membership = await memberService.updateMemberRole(workspaceId, userId, role);

    if (!membership) {
      return res.status(404).json({ error: 'Member not found in this workspace' });
    }

    res.json(membership);
  } catch (err) {
    next(err);
  }
};

/**
 * removeMember — DELETE /workspaces/:workspaceId/members/:userId
 * Owners can remove anyone; any member can remove themselves (leave). The service refuses to
 * remove the last owner, so a workspace can never be left without one.
 */
const removeMember = async (req, res, next) => {
  try {
    const { workspaceId, userId } = req.params;

    const wasRemoved = await memberService.removeMember(workspaceId, userId);

    if (!wasRemoved) {
      return res.status(404).json({ error: 'Member not found in this workspace' });
    }

    // Revoke live access too: pull the removed user's sockets out of the room.
    removeUserFromWorkspaceRoom(workspaceId, userId);

    res.status(204).end();
  } catch (err) {
    next(err);
  }
};

module.exports = { listMembers, addMember, removeMember, updateMemberRole };
