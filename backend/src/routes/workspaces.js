const express = require('express');
const workspaceController    = require('../controllers/workspaceController');
const authenticate           = require('../middleware/authenticate');
const requireWorkspaceMember = require('../middleware/requireWorkspaceMember');
const requireRole            = require('../middleware/requireRole');

const router = express.Router();

/**
 * GET /workspaces
 * List all workspaces the authenticated user belongs to.
 * Middleware: authenticate
 */
router.get(
  '/',
  authenticate,
  workspaceController.listWorkspaces,
);

/**
 * POST /workspaces
 * Create a new workspace. The creator is automatically added as owner.
 * Middleware: authenticate
 */
router.post(
  '/',
  authenticate,
  workspaceController.createWorkspace,
);

/**
 * GET /workspaces/:workspaceId
 * Get a specific workspace.
 * Middleware: authenticate → requireWorkspaceMember
 */
router.get(
  '/:workspaceId',
  authenticate,
  requireWorkspaceMember,
  workspaceController.getWorkspace,
);

/**
 * PUT /workspaces/:workspaceId
 * Update workspace details. Only owners may update.
 * Middleware: authenticate → requireWorkspaceMember → requireRole('owner')
 */
router.put(
  '/:workspaceId',
  authenticate,
  requireWorkspaceMember,
  requireRole('owner'),
  workspaceController.updateWorkspace,
);

/**
 * DELETE /workspaces/:workspaceId
 * Delete a workspace. Only owners may delete.
 * Middleware: authenticate → requireWorkspaceMember → requireRole('owner')
 */
router.delete(
  '/:workspaceId',
  authenticate,
  requireWorkspaceMember,
  requireRole('owner'),
  workspaceController.deleteWorkspace,
);

module.exports = router;
