const express = require('express');
const c = require('../controllers/callController');
const authenticate = require('../middleware/authenticate');
const { requireUuidParams } = require('../utils/http');

const router = express.Router();
router.use(authenticate);

router.get('/history', c.history);
router.get('/pending', c.pending);

// LiveKit credentials are only minted for users who are participants of the call.
router.post('/:callId/join', requireUuidParams('callId'), c.join);
router.post('/:callId/token', requireUuidParams('callId'), c.token);
router.post('/:callId/decline', requireUuidParams('callId'), c.decline);
router.post('/:callId/leave', requireUuidParams('callId'), c.leave);
router.post('/:callId/end', requireUuidParams('callId'), c.end);

module.exports = router;
