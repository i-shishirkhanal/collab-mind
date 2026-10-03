const express = require('express');
const authenticate = require('../middleware/authenticate');
const { isUuid } = require('../utils/http');
const { perUser } = require('../middleware/rateLimit');
const invites = require('../services/inviteService');

const router = express.Router();
const actionLimit = perUser('invite-action', 'INVITE_ACTION_LIMIT_PER_MIN', 30);

router.param('inviteId', (req, res, next, value) =>
  isUuid(value) ? next() : res.status(400).json({ error: 'Invalid inviteId' }));

/** GET /api/invites: my pending workspace invitations */
router.get('/', authenticate, async (req, res, next) => {
  try { res.json(await invites.listForUser(req.user.id)); } catch (err) { next(err); }
});

/** POST /api/invites/:inviteId/accept */
router.post('/:inviteId/accept', authenticate, actionLimit, async (req, res, next) => {
  try {
    const workspaceId = await invites.accept(req.params.inviteId, req.user.id);
    res.json({ workspace_id: workspaceId });
  } catch (err) { next(err); }
});

/** POST /api/invites/:inviteId/decline */
router.post('/:inviteId/decline', authenticate, actionLimit, async (req, res, next) => {
  try {
    await invites.decline(req.params.inviteId, req.user.id);
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
