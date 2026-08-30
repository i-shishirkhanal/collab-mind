const express = require('express');
const authController = require('../controllers/authController');

const router = express.Router();

/**
 * POST /auth/google
 * Public endpoint — no authentication required.
 * Accepts a Google ID token and returns a signed JWT.
 */
router.post('/google', authController.googleAuth);
router.post('/email', authController.emailAuth);

module.exports = router;
