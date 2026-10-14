const express = require('express');
const authenticate = require('../middleware/authenticate');
const requireMember = require('../middleware/requireWorkspaceMember');
const { requireUuidParams, httpError, isUuid } = require('../utils/http');
const { perUser } = require('../middleware/rateLimit');
const pool = require('../db/postgres');
const annotations = require('../services/annotationService');
const ai = require('../services/aiClient');

const router = express.Router();
const guard = [authenticate, requireUuidParams('workspaceId'), requireMember];
const sourceGuard = [...guard, requireUuidParams('sourceId')];
const writeLimit = perUser('annotations', 'ANNOTATION_RATE_LIMIT_PER_MIN', 30);
const compareLimit = perUser('ai-tool', 'AI_TOOL_RATE_LIMIT_PER_MIN', 10);
const route = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (err) { next(err); } };

router.get('/:workspaceId/sources/:sourceId/passages', ...sourceGuard, route(async (req, res) => {
  const after = req.query.after === undefined ? -1 : Number(req.query.after);
  if (!Number.isInteger(after) || after < -1 || after > 2147483646) throw httpError(400, 'Invalid passage cursor');
  const { rows } = await pool.query(
    `SELECT chunk_index, content, page_number, location_label FROM source_chunks
     WHERE workspace_id = $1 AND source_id = $2 AND chunk_index > $3 ORDER BY chunk_index LIMIT 21`,
    [req.params.workspaceId, req.params.sourceId, after],
  );
  res.json({ passages: rows.slice(0, 20), next: rows.length > 20 ? rows[19].chunk_index : null });
}));

router.get('/:workspaceId/sources/:sourceId/annotations', ...sourceGuard, route(async (req, res) => {
  if (req.query.after !== undefined && !isUuid(req.query.after)) throw httpError(400, 'Invalid discussion cursor');
  res.json(await annotations.list(req.params.workspaceId, req.params.sourceId, req.query.after || null));
}));
router.post('/:workspaceId/sources/:sourceId/annotations', ...sourceGuard, writeLimit, route(async (req, res) => {
  res.status(201).json(await annotations.create(req.params.workspaceId, req.params.sourceId, req.user.id, req.body));
}));
router.get('/:workspaceId/sources/:sourceId/annotations/:annotationId', ...sourceGuard,
  requireUuidParams('annotationId'), route(async (req, res) => {
    const result = await annotations.list(req.params.workspaceId, req.params.sourceId, null, req.params.annotationId);
    if (!result.annotations[0]) throw httpError(404, 'Discussion not found');
    res.json({ annotation: result.annotations[0] });
  }));
router.post('/:workspaceId/sources/:sourceId/annotations/:annotationId/comments', ...sourceGuard,
  requireUuidParams('annotationId'), writeLimit, route(async (req, res) => {
    res.status(201).json(await annotations.reply(req.params.workspaceId, req.params.sourceId, req.params.annotationId, req.user.id, req.body));
  }));
router.patch('/:workspaceId/sources/:sourceId/annotations/:annotationId', ...sourceGuard,
  requireUuidParams('annotationId'), writeLimit, route(async (req, res) => {
    res.json(await annotations.resolve(req.params.workspaceId, req.params.sourceId, req.params.annotationId,
      req.user.id, req.membership.role, req.body?.resolved));
  }));

router.get('/:workspaceId/annotation-mentions', ...guard, route(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT m.comment_id, m.read_at, c.body, c.created_at, u.name AS author_name,
       a.id AS annotation_id, a.source_id, a.chunk_index, a.quote, s.name AS source_name
     FROM annotation_mentions m JOIN annotation_comments c ON c.id = m.comment_id
     JOIN source_annotations a ON a.id = c.annotation_id JOIN sources s ON s.id = a.source_id
     LEFT JOIN users u ON u.id = c.user_id
     WHERE m.user_id = $1 AND a.workspace_id = $2
     ORDER BY (m.read_at IS NULL) DESC, c.created_at DESC LIMIT 50`, [req.user.id, req.params.workspaceId],
  );
  res.json({ mentions: rows });
}));
router.patch('/:workspaceId/annotation-mentions/:commentId', ...guard, requireUuidParams('commentId'), route(async (req, res) => {
  await pool.query(
    `UPDATE annotation_mentions m SET read_at = NOW() FROM annotation_comments c, source_annotations a
     WHERE m.comment_id = $1 AND m.user_id = $2 AND c.id = m.comment_id
       AND a.id = c.annotation_id AND a.workspace_id = $3`, [req.params.commentId, req.user.id, req.params.workspaceId],
  );
  res.status(204).end();
}));

router.post('/:workspaceId/sources/compare', ...guard, compareLimit, route(async (req, res) => {
  const ids = req.body?.source_ids;
  const focus = req.body?.focus ?? '';
  if (!Array.isArray(ids) || ids.length !== 2 || ids.some((id) => !isUuid(id)) || ids[0] === ids[1]) {
    throw httpError(400, 'Choose two different sources');
  }
  if (typeof focus !== 'string' || focus.length > 500) throw httpError(400, 'Comparison focus must be at most 500 characters');
  const { rows } = await pool.query(
    'SELECT id, status FROM sources WHERE workspace_id = $1 AND id = ANY($2::uuid[])', [req.params.workspaceId, ids],
  );
  if (rows.length !== 2) throw httpError(404, 'Source not found');
  if (rows.some((s) => s.status !== 'ready')) throw httpError(409, 'Both sources must finish processing before comparison');
  try {
    const response = await ai.post('/sources/compare', {
      workspace_id: req.params.workspaceId, user_id: req.user.id, source_ids: ids, focus: focus.trim(),
    }, { timeout: 150000 });
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.detail;
    if ([404, 429, 503, 504].includes(status) && typeof detail === 'string') throw httpError(status, detail);
    throw httpError(502, 'The AI service could not compare these sources. Please try again.');
  }
}));

module.exports = router;
