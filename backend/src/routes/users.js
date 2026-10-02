const express = require('express');
const c = require('../controllers/conversationController');
const authenticate = require('../middleware/authenticate');

const router = express.Router();

/** GET /api/users/search?q= — people the caller shares a workspace with. */
router.get('/search', authenticate, c.searchUsers);

module.exports = router;
