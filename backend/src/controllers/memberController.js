const memberService = require('../services/memberService');
const inviteService = require('../services/inviteService');
const { removeUserFromWorkspaceRoom } = require('../services/realtime');

/**
 * listMembers — GET /workspaces/:workspaceId/members
 * Returns all members of the workspace. Accessible by any member.
 */
const listMembers = async (req, res, next) => {
  try {
    const members = await memberService.listMembers(req.params.workspaceId);
    // Email addresses are for owners and admins only; other members see names.
    const privileged = ['owner', 'admin'].includes(req.membership && req.membership.role);
    res.json(privileged ? members : members.map(({ email, ...rest }) => rest));
  } catch (err) {
    next(err);
  }
};

/**
 * addMember — POST /workspaces/:workspaceId/members
 * Body: { email: string, role?: 'member' | 'admin' | 'owner' }
 * Requires owner role. Sends an invitation (always 202); the invitee accepts via /api/invites.
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

    if (typeof email !== 'string' || email.length > 320) {
      return res.status(400).json({ error: 'email must be a valid address' });
    }

    // An invitation, not an instant membership; the answer is identical whether or not the address is
    // registered or already a member.
    await inviteService.createInvite(req.params.workspaceId, req.user.id, email, role);
    res.status(202).json({ message: 'If that address belongs to a CollabMind account, an invitation has been sent.' });
  } catch (err) {
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
