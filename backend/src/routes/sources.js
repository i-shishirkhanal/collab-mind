const express = require('express');
const sourceController       = require('../controllers/sourceController');
const authenticate           = require('../middleware/authenticate');
const requireWorkspaceMember = require('../middleware/requireWorkspaceMember');
const upload                 = require('../middleware/upload');

const router = express.Router({ mergeParams: true });

/**
 * GET /workspaces/:workspaceId/sources
 */
router.get(
  '/:workspaceId/sources',
  authenticate,
  requireWorkspaceMember,
  sourceController.listSources,
);

/**
 * POST /workspaces/:workspaceId/sources/upload
 */
router.post(
  '/:workspaceId/sources/upload',
  authenticate,
  requireWorkspaceMember,
  upload.single('file'),
  sourceController.uploadFile,
);

/**
 * POST /workspaces/:workspaceId/sources/url
 */
router.post(
  '/:workspaceId/sources/url',
  authenticate,
  requireWorkspaceMember,
  sourceController.addUrlSource,
);

/**
 * POST /workspaces/:workspaceId/sources/:sourceId/summarize
 */
router.post(
  '/:workspaceId/sources/:sourceId/summarize',
  authenticate,
  requireWorkspaceMember,
  sourceController.summarizeSource,
);

module.exports = router;
