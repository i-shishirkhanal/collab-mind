const express = require('express');
const memberController       = require('../controllers/memberController');
const authenticate           = require('../middleware/authenticate');
const requireWorkspaceMember = require('../middleware/requireWorkspaceMember');
const requireRole            = require('../middleware/requireRole');
const { isUuid }             = require('../utils/http');
const { perUser }            = require('../middleware/rateLimit');

// mergeParams lets us access :workspaceId defined in the parent router (index.js)
const router = express.Router({ mergeParams: true });

router.param('userId', (req, res, next, value) =>
  isUuid(value) ? next() : res.status(400).json({ error: 'Invalid userId' }));

/**
 * GET /workspaces/:workspaceId/members
 * List all members. Any workspace member may view the list.
 * Middleware: authenticate → requireWorkspaceMember
 */
router.get(
  '/:workspaceId/members',
  authenticate,
  requireWorkspaceMember,
  memberController.listMembers,
);

/**
 * POST /workspaces/:workspaceId/members
 * Invite a user by email. Only owners may add members.
 * Body: { email, role? }
 * Middleware: authenticate → requireWorkspaceMember → requireRole('owner')
 */
// Adding by email reveals whether an address is registered, so it is tightly limited per user.
const addMemberLimit = perUser('member-add', 'MEMBER_ADD_RATE_LIMIT_PER_HOUR', 20, 60 * 60 * 1000);

router.post(
  '/:workspaceId/members',
  authenticate,
  addMemberLimit,
  requireWorkspaceMember,
  requireRole('owner'),
  memberController.addMember,
);

/** GET /workspaces/:workspaceId/invites: pending invitations (owner only) */
router.get(
  '/:workspaceId/invites',
  authenticate,
  requireWorkspaceMember,
  requireRole('owner'),
  async (req, res, next) => {
    try { res.json(await require('../services/inviteService').listForWorkspace(req.params.workspaceId)); } catch (err) { next(err); }
  },
);

/** DELETE /workspaces/:workspaceId/invites/:inviteId: withdraw an invitation (owner only) */
router.delete(
  '/:workspaceId/invites/:inviteId',
  authenticate,
  requireWorkspaceMember,
  requireRole('owner'),
  async (req, res, next) => {
    try {
      if (!isUuid(req.params.inviteId)) return res.status(400).json({ error: 'Invalid inviteId' });
      await require('../services/inviteService').cancel(req.params.workspaceId, req.params.inviteId);
      res.status(204).end();
    } catch (err) { next(err); }
  },
);

/**
 * PATCH /workspaces/:workspaceId/members/:userId
 * Change a member's role. Only owners may change roles.
 * Body: { role }
 * Middleware: authenticate → requireWorkspaceMember → requireRole('owner')
 */
router.patch(
  '/:workspaceId/members/:userId',
  authenticate,
  requireWorkspaceMember,
  requireRole('owner'),
  memberController.updateMemberRole,
);

/**
 * DELETE /workspaces/:workspaceId/members/:userId
 * Remove a member by their user id. Only owners may remove members.
 * Middleware: authenticate → requireWorkspaceMember → requireRole('owner')
 */
// Owners can remove anyone; any member can remove THEMSELVES (leave the workspace).
const ownerOrSelf = (req, res, next) =>
  (req.params.userId === req.user.id ? next() : requireRole('owner')(req, res, next));

router.delete(
  '/:workspaceId/members/:userId',
  authenticate,
  requireWorkspaceMember,
  ownerOrSelf,
  memberController.removeMember,
);

module.exports = router;
