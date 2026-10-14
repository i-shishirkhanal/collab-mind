const express = require('express');
const pool = require('../db/postgres');
const ai = require('../services/aiClient');
const authenticate = require('../middleware/authenticate');
const requireMember = require('../middleware/requireWorkspaceMember');
const { requireUuidParams, isUuid, httpError } = require('../utils/http');
const { perUser } = require('../middleware/rateLimit');

const router = express.Router();
const guard = [authenticate, requireUuidParams('workspaceId'), requireMember];
const jobGuard = [...guard, requireUuidParams('podcastId')];
const limit = perUser('ai-tool', 'AI_TOOL_RATE_LIMIT_PER_MIN', 10);
const route = fn => async (req, res, next) => { try { await fn(req, res); } catch (err) { next(err); } };
const relay = err => {
  const status = err.response?.status;
  const detail = err.response?.data?.detail;
  return [404, 409, 429, 503, 504].includes(status) && typeof detail === 'string'
    ? httpError(status, detail) : httpError(502, 'The podcast service is unavailable. Please try again later.');
};

router.get('/:workspaceId/studio/podcasts/config', ...guard, route(async (_req, res) => {
  try { res.json((await ai.get('/studio/podcasts/config')).data); } catch (err) { throw relay(err); }
}));
router.post('/:workspaceId/studio/podcasts', ...guard, limit, route(async (req, res) => {
  const { source_ids: ids, topic = '', language = 'English', length = 'short' } = req.body || {};
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 6 || ids.some(id => !isUuid(id))) {
    throw httpError(400, 'Choose between one and six sources');
  }
  if (typeof topic !== 'string' || topic.length > 500 || !['English', 'Hindi', 'Spanish', 'French'].includes(language)
      || !['short', 'standard'].includes(length)) throw httpError(400, 'Invalid podcast options');
  try {
    const response = await ai.post('/studio/podcasts', {
      workspace_id: req.params.workspaceId, user_id: req.user.id,
      source_ids: [...new Set(ids)], topic: topic.trim(), language, length,
    }, { timeout: 30000 });
    res.status(202).json(response.data);
  } catch (err) { throw relay(err); }
}));
router.get('/:workspaceId/studio/podcasts', ...guard, route(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, params, status, error, created_at, updated_at FROM studio_podcasts
     WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 20`, [req.params.workspaceId],
  );
  res.json({ podcasts: rows });
}));
async function loadJob(req) {
  const { rows } = await pool.query('SELECT * FROM studio_podcasts WHERE id=$1 AND workspace_id=$2',
    [req.params.podcastId, req.params.workspaceId]);
  if (!rows[0]) throw httpError(404, 'Podcast not found');
  return rows[0];
}
router.get('/:workspaceId/studio/podcasts/:podcastId', ...jobGuard, route(async (req, res) => {
  const row = await loadJob(req);
  res.json({ podcast: row });
}));
router.get('/:workspaceId/studio/podcasts/:podcastId/audio', ...jobGuard, route(async (req, res) => {
  const row = await loadJob(req);
  if (row.status !== 'ready') throw httpError(409, 'Podcast audio is not ready yet');
  let response;
  try {
    response = await ai.getStream(`/studio/podcasts/${req.params.podcastId}/audio?workspace_id=${req.params.workspaceId}`);
  } catch (err) {
    // Axios returns an error body as a stream here. Close it and do not expose vendor internals.
    err.response?.data?.destroy?.();
    if (err.response?.status === 404) throw httpError(404, 'This audio file is no longer available. Generate a new podcast.');
    throw httpError(502, 'Podcast audio is unavailable. Please try again later.');
  }
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', `attachment; filename="collabmind-${req.params.podcastId}.mp3"`);
  const size = Number(response.headers['content-length']);
  if (Number.isFinite(size) && size > 0) res.setHeader('Content-Length', size);
  response.data.on('error', () => res.destroy());
  res.on('close', () => response.data.destroy());
  response.data.pipe(res);
}));

module.exports = router;
