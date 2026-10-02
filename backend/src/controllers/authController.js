const authService = require('../services/authService');
const { revokeSession } = require('../services/sessionService');
const { disconnectSession } = require('../services/realtime');

const GENERIC_REGISTER = 'If this email can be registered, a verification link has been sent.';
const GENERIC_RESEND = 'If an unverified account exists for this email, a new verification link has been sent.';
const GENERIC_FORGOT = 'If an account exists for this email, a password reset link has been sent.';

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});

const register = asyncRoute(async (req, res) => {
  await authService.register(body(req));
  res.status(202).json({ message: GENERIC_REGISTER });
});

const verifyEmail = asyncRoute(async (req, res) => {
  await authService.verifyEmail(body(req).token);
  res.json({ message: 'Email verified. You can now sign in.' });
});

const resendVerification = asyncRoute(async (req, res) => {
  await authService.resendVerification(body(req).email);
  res.status(202).json({ message: GENERIC_RESEND });
});

const login = asyncRoute(async (req, res) => {
  const result = await authService.login(body(req), { userAgent: req.get('user-agent'), ip: req.ip });
  res.json(result);
});

const logout = asyncRoute(async (req, res) => {
  await revokeSession(req.user.sessionId, req.user.id);
  disconnectSession(req.user.sessionId);
  res.status(204).end();
});

const me = asyncRoute(async (req, res) => {
  const user = await authService.getUserById(req.user.id);
  res.json({ user });
});

const forgotPassword = asyncRoute(async (req, res) => {
  await authService.requestPasswordReset(body(req).email);
  res.status(202).json({ message: GENERIC_FORGOT });
});

const resetPassword = asyncRoute(async (req, res) => {
  await authService.resetPassword(body(req).token, body(req).password);
  res.json({ message: 'Password updated. Please sign in with your new password.' });
});

module.exports = { register, verifyEmail, resendVerification, login, logout, me, forgotPassword, resetPassword };
