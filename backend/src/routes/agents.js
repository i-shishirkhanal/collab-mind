const express = require('express');
const aiClient = require('../services/aiClient');
const pool = require('../db/postgres');
const authenticate = require('../middleware/authenticate');
const requireWorkspaceMember = require('../middleware/requireWorkspaceMember');
const { requireUuidParams, httpError } = require('../utils/http');
const { perUser } = require('../middleware/rateLimit');

// Agent runs and studio generation are the most expensive calls (long prompts, Pro-capable): AI_TOOL_RATE_LIMIT_PER_MIN, default 10/min per user.
const toolLimit = perUser('ai-tool', 'AI_TOOL_RATE_LIMIT_PER_MIN', 10);

const router = express.Router({ mergeParams: true });

const guard = [authenticate, requireUuidParams('workspaceId'), requireWorkspaceMember];
const costlyGuard = [authenticate, toolLimit, requireUuidParams('workspaceId'), requireWorkspaceMember];
const guardRun = [authenticate, requireUuidParams('workspaceId', 'runId'), requireWorkspaceMember];

// Never relay AI-service error bodies (they can carry internals).
const relayError = (err, res, next) => {
  if (err.response) {
    const status = err.response.status;
    const detail = err.response.data && err.response.data.detail;
    // Rate limit / not configured / timeout carry a safe, user-facing message from the AI service.
    if ([429, 503, 504].includes(status) && typeof detail === 'string') {
      return res.status(status).json({ error: detail });
    }
    // A 401/403 here is OUR credential problem, never the end user's: hide it as a 502.
    return res.status(status >= 500 || status === 401 || status === 403 ? 502 : status)
      .json({ error: 'The AI service could not complete the request' });
  }
  return next(err);
};

/** An agent run is only reachable through the workspace that owns it. */
const assertRunInWorkspace = async (req, _res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM agent_runs WHERE id = $1 AND workspace_id = $2',
      [req.params.runId, req.params.workspaceId],
    );
    if (rows.length === 0) throw httpError(404, 'Run not found');
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/workspaces/:workspaceId/agents/study-coach
 */
router.post('/:workspaceId/agents/study-coach', ...costlyGuard, async (req, res, next) => {
  try {
    const goal = req.body && req.body.goal;
    if (typeof goal !== 'string' || !goal.trim() || goal.length > 2000) {
      throw httpError(400, 'goal is required (max 2000 characters)');
    }
    const response = await aiClient.post('/agents/study-coach', {
      workspace_id: req.params.workspaceId,
      user_id: req.user.id,
      goal: goal.trim(),
    });
    res.json(response.data);
  } catch (err) {
    relayError(err, res, next);
  }
});

/**
 * POST /api/workspaces/:workspaceId/agents/:runId/approve
 */
router.post('/:workspaceId/agents/:runId/approve', ...guardRun, assertRunInWorkspace, async (req, res, next) => {
  try {
    // Approval only counts while the run is actually waiting for it; a pre-approval would
    // skip the human review step.
    const { rows } = await pool.query('SELECT status FROM agent_runs WHERE id = $1 AND workspace_id = $2',
      [req.params.runId, req.params.workspaceId]);
    if (!rows[0] || rows[0].status !== 'awaiting_approval') {
      throw httpError(409, 'This run is not waiting for approval');
    }
    const response = await aiClient.post(`/agents/${req.params.runId}/approve`, {});
    res.json(response.data);
  } catch (err) {
    relayError(err, res, next);
  }
});

/**
 * GET /api/workspaces/:workspaceId/agents/:runId/status
 */
router.get('/:workspaceId/agents/:runId/status', ...guardRun, assertRunInWorkspace, async (req, res, next) => {
  try {
    const response = await aiClient.get(`/agents/${req.params.runId}/status`);
    res.json(response.data);
  } catch (err) {
    relayError(err, res, next);
  }
});

// STUDIO ENDPOINTS

const STUDIO_KINDS = ['flashcards', 'quiz', 'guide', 'report'];
const STUDIO_KEEP = 20; // saved generations kept per workspace and tool

/** Saves a generation so a page refresh can show it again. Best effort: never fails the request. */
const saveStudioOutput = async (workspaceId, userId, kind, params, content) => {
  try {
    await pool.query(
      `INSERT INTO studio_outputs (workspace_id, user_id, kind, params, content)
       VALUES ($1, $2, $3, $4, $5)`,
      [workspaceId, userId, kind, JSON.stringify(params), JSON.stringify(content)],
    );
    await pool.query(
      `DELETE FROM studio_outputs
        WHERE workspace_id = $1 AND kind = $2
          AND id NOT IN (SELECT id FROM studio_outputs WHERE workspace_id = $1 AND kind = $2
                          ORDER BY created_at DESC LIMIT $3)`,
      [workspaceId, kind, STUDIO_KEEP],
    );
  } catch (err) {
    console.error(`[Studio] could not save ${kind} output: ${err.message}`);
  }
};

const proxyStudio = (endpoint, kind) => async (req, res, next) => {
  try {
    const params = req.body && typeof req.body === 'object' ? req.body : {};
    // workspace_id comes LAST so a client-supplied value can never override the
    // workspace the caller was authorised for.
    const body = {
      ...params,
      workspace_id: req.params.workspaceId,
      user_id: req.user.id, // usage is attributed to the caller, never to a client-supplied id
    };
    const response = await aiClient.post(`/studio/${endpoint}`, body, { timeout: 120_000 });
    await saveStudioOutput(req.params.workspaceId, req.user.id, kind, params, response.data);
    res.json(response.data);
  } catch (err) {
    relayError(err, res, next);
  }
};

router.post('/:workspaceId/studio/flashcards', ...costlyGuard, proxyStudio('flashcards', 'flashcards'));
router.post('/:workspaceId/studio/quiz', ...costlyGuard, proxyStudio('quiz', 'quiz'));
router.post('/:workspaceId/studio/guide', ...costlyGuard, proxyStudio('study-guide', 'guide'));
router.post('/:workspaceId/studio/report', ...costlyGuard, proxyStudio('report', 'report'));

/**
 * GET /api/workspaces/:workspaceId/studio/:kind/latest
 * The most recent saved result for a tool, or { output: null } when there is none.
 */
router.get('/:workspaceId/studio/:kind/latest', ...guard, async (req, res, next) => {
  try {
    const { kind } = req.params;
    if (!STUDIO_KINDS.includes(kind)) throw httpError(404, 'Unknown studio tool');
    const { rows } = await pool.query(
      `SELECT params, content, created_at FROM studio_outputs
        WHERE workspace_id = $1 AND kind = $2 ORDER BY created_at DESC LIMIT 1`,
      [req.params.workspaceId, kind],
    );
    res.json({ output: rows[0] || null });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/workspaces/:workspaceId/agents/latest
 * The id of the workspace's most recent study-coach run, so the page can resume it after a refresh.
 */
router.get('/:workspaceId/agents/latest', ...guard, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id FROM agent_runs WHERE workspace_id = $1 AND agent_type = 'study_coach'
        ORDER BY created_at DESC LIMIT 1`,
      [req.params.workspaceId],
    );
    res.json({ run_id: rows[0] ? rows[0].id : null });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
