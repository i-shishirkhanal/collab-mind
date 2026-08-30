const express = require('express');
const axios = require('axios');
const authenticate = require('../middleware/authenticate');
const requireWorkspaceMember = require('../middleware/requireWorkspaceMember');

const router = express.Router({ mergeParams: true });
const AI_SERVICE_URL = () => process.env.AI_SERVICE_URL || 'http://localhost:8000';

/**
 * POST /api/workspaces/:workspaceId/agents/study-coach
 */
router.post('/:workspaceId/agents/study-coach', authenticate, requireWorkspaceMember, async (req, res, next) => {
  try {
    const { goal } = req.body;
    const response = await axios.post(`${AI_SERVICE_URL()}/agents/study-coach`, {
      workspace_id: req.params.workspaceId,
      user_id: req.user.id,
      goal
    });
    res.json(response.data);
  } catch (err) {
    if (err.response) return res.status(err.response.status).json(err.response.data);
    next(err);
  }
});

/**
 * POST /api/workspaces/:workspaceId/agents/:runId/approve
 */
router.post('/:workspaceId/agents/:runId/approve', authenticate, requireWorkspaceMember, async (req, res, next) => {
  try {
    const response = await axios.post(`${AI_SERVICE_URL()}/agents/${req.params.runId}/approve`);
    res.json(response.data);
  } catch (err) {
    if (err.response) return res.status(err.response.status).json(err.response.data);
    next(err);
  }
});

/**
 * GET /api/workspaces/:workspaceId/agents/:runId/status
 */
router.get('/:workspaceId/agents/:runId/status', authenticate, requireWorkspaceMember, async (req, res, next) => {
  try {
    const response = await axios.get(`${AI_SERVICE_URL()}/agents/${req.params.runId}/status`);
    res.json(response.data);
  } catch (err) {
    if (err.response) return res.status(err.response.status).json(err.response.data);
    next(err);
  }
});

// STUDIO ENDPOINTS

const proxyStudio = (endpoint) => async (req, res, next) => {
  try {
    const body = { workspace_id: req.params.workspaceId, ...req.body };
    const response = await axios.post(`${AI_SERVICE_URL()}/studio/${endpoint}`, body);
    res.json(response.data);
  } catch (err) {
    if (err.response) return res.status(err.response.status).json(err.response.data);
    next(err);
  }
};

router.post('/:workspaceId/studio/flashcards', authenticate, requireWorkspaceMember, proxyStudio('flashcards'));
router.post('/:workspaceId/studio/quiz', authenticate, requireWorkspaceMember, proxyStudio('quiz'));
router.post('/:workspaceId/studio/guide', authenticate, requireWorkspaceMember, proxyStudio('study-guide'));
router.post('/:workspaceId/studio/report', authenticate, requireWorkspaceMember, proxyStudio('report'));

module.exports = router;
