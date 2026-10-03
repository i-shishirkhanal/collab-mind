const express = require('express');
const sourceController       = require('../controllers/sourceController');
const authenticate           = require('../middleware/authenticate');
const requireWorkspaceMember = require('../middleware/requireWorkspaceMember');
const { uploadSingle }       = require('../middleware/upload');
const { requireUuidParams }  = require('../utils/http');
const { perUser }            = require('../middleware/rateLimit');

// Uploads and URL imports trigger extraction + embedding; summaries call the LLM.
const ingestLimit    = perUser('ingest',    'INGEST_RATE_LIMIT_PER_MIN', 30);
const summarizeLimit = perUser('summarize', 'AI_TOOL_RATE_LIMIT_PER_MIN', 10);

const router = express.Router({ mergeParams: true });

// Every route is authenticated, then checked for workspace membership; ids are
// validated as UUIDs before they reach the database or the storage path.
const guard = [authenticate, requireUuidParams('workspaceId'), requireWorkspaceMember];
const guardSource = [authenticate, requireUuidParams('workspaceId', 'sourceId'), requireWorkspaceMember];

/**
 * GET /workspaces/:workspaceId/sources
 */
router.get('/:workspaceId/sources', ...guard, sourceController.listSources);

/**
 * POST /workspaces/:workspaceId/sources/upload
 */
router.post('/:workspaceId/sources/upload', authenticate, ingestLimit, requireUuidParams('workspaceId'), requireWorkspaceMember, uploadSingle, sourceController.uploadFile);

/**
 * POST /workspaces/:workspaceId/sources/url
 */
router.post('/:workspaceId/sources/url', authenticate, ingestLimit, requireUuidParams('workspaceId'), requireWorkspaceMember, sourceController.addUrlSource);

/**
 * GET /workspaces/:workspaceId/sources/:sourceId
 */
router.get('/:workspaceId/sources/:sourceId', ...guardSource, sourceController.getSource);

/**
 * DELETE /workspaces/:workspaceId/sources/:sourceId
 */
router.delete('/:workspaceId/sources/:sourceId', ...guardSource, sourceController.deleteSource);

/**
 * POST /workspaces/:workspaceId/sources/:sourceId/retry
 */
router.post('/:workspaceId/sources/:sourceId/retry', authenticate, ingestLimit, requireUuidParams('workspaceId', 'sourceId'), requireWorkspaceMember, sourceController.retrySource);

/**
 * POST /workspaces/:workspaceId/sources/:sourceId/summarize
 */
router.post('/:workspaceId/sources/:sourceId/summarize', authenticate, summarizeLimit, requireUuidParams('workspaceId', 'sourceId'), requireWorkspaceMember, sourceController.summarizeSource);

module.exports = router;
