const { isProduction, appUrl } = require('../config/env');

/**
 * Outgoing auth email. With SMTP_URL set, mail goes through nodemailer.
 * Without it (non-production only) the message is printed to the server
 * console so local development works without a mail server. Production
 * refuses to start without SMTP_URL (see config/env.validateConfig).
 */
let transporter = null;
const getTransporter = () => {
  if (!transporter) transporter = require('nodemailer').createTransport(process.env.SMTP_URL);
  return transporter;
};

const send = async ({ to, subject, text, devLink }) => {
  if (process.env.SMTP_URL) {
    await getTransporter().sendMail({
      from: process.env.MAIL_FROM || 'CollabMind <no-reply@collabmind.local>',
      to, subject, text,
    });
    return;
  }
  if (isProduction()) throw new Error('SMTP_URL is not configured');
  console.log(`[Mail:dev] To: ${to} | ${subject}\n[Mail:dev] ${devLink}`);
};

const sendVerificationEmail = (to, token) => {
  const link = `${appUrl()}/auth/verify-email?token=${encodeURIComponent(token)}`;
  return send({
    to, devLink: link,
    subject: 'Verify your CollabMind email',
    text: `Confirm your email address to finish creating your CollabMind account:\n\n${link}\n\nThis link expires in 24 hours. If you did not sign up, you can ignore this message.`,
  });
};

const sendPasswordResetEmail = (to, token) => {
  const link = `${appUrl()}/auth/reset-password?token=${encodeURIComponent(token)}`;
  return send({
    to, devLink: link,
    subject: 'Reset your CollabMind password',
    text: `Use this link to choose a new password:\n\n${link}\n\nThis link expires in 1 hour. If you did not request it, you can ignore this message; your password has not changed.`,
  });
};

module.exports = { sendVerificationEmail, sendPasswordResetEmail };
