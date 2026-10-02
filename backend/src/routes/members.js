const express = require('express');
const memberController       = require('../controllers/memberController');
const authenticate           = require('../middleware/authenticate');
const requireWorkspaceMember = require('../middleware/requireWorkspaceMember');
const requireRole            = require('../middleware/requireRole');
const { isUuid }             = require('../utils/http');

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
router.post(
  '/:workspaceId/members',
  authenticate,
  requireWorkspaceMember,
  requireRole('owner'),
  memberController.addMember,
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
router.delete(
  '/:workspaceId/members/:userId',
  authenticate,
  requireWorkspaceMember,
  requireRole('owner'),
  memberController.removeMember,
);

module.exports = router;
