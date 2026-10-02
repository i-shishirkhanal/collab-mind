const express = require('express');
const ctrl = require('../controllers/authController');
const authenticate = require('../middleware/authenticate');
const { rateLimit, emailKey } = require('../middleware/rateLimit');

const router = express.Router();

const HOUR = 60 * 60 * 1000;
const WINDOW_15M = 15 * 60 * 1000;

// Per-IP and per-account limits (the account limit stops distributed guessing).
const loginIp      = rateLimit({ name: 'login-ip',    windowMs: WINDOW_15M, max: 30 });
const loginAccount = rateLimit({ name: 'login-email', windowMs: WINDOW_15M, max: 10, keyFn: emailKey });
const registerIp   = rateLimit({ name: 'register-ip', windowMs: HOUR, max: 10 });
const mailIp       = rateLimit({ name: 'mail-ip',     windowMs: HOUR, max: 20 });
const mailAccount  = rateLimit({ name: 'mail-email',  windowMs: HOUR, max: 5, keyFn: emailKey });
const tokenIp      = rateLimit({ name: 'token-ip',    windowMs: WINDOW_15M, max: 30 });

router.post('/register',            registerIp, mailAccount, ctrl.register);
router.post('/login',               loginIp, loginAccount, ctrl.login);
router.post('/verify-email',        tokenIp, ctrl.verifyEmail);
router.post('/resend-verification', mailIp, mailAccount, ctrl.resendVerification);
router.post('/forgot-password',     mailIp, mailAccount, ctrl.forgotPassword);
router.post('/reset-password',      tokenIp, ctrl.resetPassword);
router.post('/logout',              authenticate, ctrl.logout);
router.get('/me',                   authenticate, ctrl.me);

module.exports = router;
