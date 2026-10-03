const express = require('express');
const chatController         = require('../controllers/chatController');
const authenticate           = require('../middleware/authenticate');
const requireWorkspaceMember = require('../middleware/requireWorkspaceMember');
const { perUser }            = require('../middleware/rateLimit');

// LLM calls cost money: cap each user (CHAT_RATE_LIMIT_PER_MIN, default 20/min).
const chatLimit = perUser('chat', 'CHAT_RATE_LIMIT_PER_MIN', 20);

const router = express.Router({ mergeParams: true });

/**
 * GET /workspaces/:workspaceId/chat/messages
 * GET /workspaces/:workspaceId/chat/history
 * Retrieve chat history for a workspace.
 */
router.get(
  '/:workspaceId/chat/messages',
  authenticate,
  requireWorkspaceMember,
  chatController.getMessages,
);

router.get(
  '/:workspaceId/chat/history',
  authenticate,
  requireWorkspaceMember,
  chatController.getMessages,
);

/**
 * POST /workspaces/:workspaceId/chat
 * Send a message. Persists user message, proxies to AI service,
 * persists AI reply, and returns both.
 */
router.post(
  '/:workspaceId/chat',
  authenticate,
  chatLimit,
  requireWorkspaceMember,
  chatController.sendMessage,
);

module.exports = router;
