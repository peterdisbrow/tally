'use strict';

const crypto = require('node:crypto');

/**
 * Email verification route handlers.
 *
 * @param {import('express').Express} app
 * @param {Object} ctx
 * @param {Object} ctx.db
 * @param {string} ctx.APP_URL
 * @param {Function} ctx.log
 * @param {Function} ctx.rateLimit
 * @param {Function} ctx.sendOnboardingEmail
 */
module.exports = function setupEmailVerificationRoutes(app, ctx) {
  const { db, APP_URL, log, rateLimit, sendOnboardingEmail } = ctx;

  // Email verification endpoint
  app.get('/api/church/verify-email', (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Verification token required' });

    const church = db.prepare('SELECT churchId, name, email_verified FROM churches WHERE email_verify_token = ?').get(token);
    if (!church) return res.status(404).json({ error: 'Invalid or expired verification link' });

    if (church.email_verified) {
      return res.redirect(`${APP_URL}/portal?verified=already`);
    }

    db.prepare('UPDATE churches SET email_verified = 1, email_verify_token = NULL WHERE churchId = ?').run(church.churchId);
    log(`[EmailVerify] \u2705 Email verified for "${church.name}" (${church.churchId})`);

    res.redirect(`${APP_URL}/portal?verified=true`);
  });

  // Resend verification email
  app.post('/api/church/resend-verification', rateLimit(3, 60_000), (req, res) => {
    const { email } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail) return res.status(400).json({ error: 'email required' });

    const church = db.prepare('SELECT churchId, name, portal_email, email_verified, email_verify_token FROM churches WHERE portal_email = ?').get(cleanEmail);
    if (!church) return res.json({ sent: true }); // Don't reveal if account exists
    if (church.email_verified) return res.json({ sent: true, alreadyVerified: true });

    // Generate a new token if needed
    let verifyToken = church.email_verify_token;
    if (!verifyToken) {
      verifyToken = crypto.randomBytes(32).toString('hex');
      db.prepare('UPDATE churches SET email_verify_token = ?, email_verify_sent_at = ? WHERE churchId = ?')
        .run(verifyToken, new Date().toISOString(), church.churchId);
    }

    // Send verification email (non-blocking)
    const verifyUrl = `${APP_URL.replace('https://tallyconnect.app', process.env.RELAY_URL || 'https://tally-production-cde2.up.railway.app')}/api/church/verify-email?token=${verifyToken}`;
    sendOnboardingEmail({
      to: cleanEmail,
      subject: 'Verify your Tally email',
      tag: 'email-verification',
      html: `<div style="font-family: system-ui, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 0;">
        <div style="margin-bottom: 24px;">
          <span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: #22c55e; margin-right: 8px;"></span>
          <strong style="font-size: 16px; color: #111;">Tally</strong>
        </div>
        <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Verify your email</h1>
        <p style="font-size: 15px; color: #333; line-height: 1.6;">Click below to verify the email address for <strong>${church.name}</strong>:</p>
        <p style="margin: 28px 0;">
          <a href="${verifyUrl}" style="display: inline-block; padding: 12px 28px; font-size: 15px; font-weight: 700; background: #22c55e; color: #000; text-decoration: none; border-radius: 8px;">Verify Email</a>
        </p>
        <p style="font-size: 13px; color: #666;">If you didn't sign up for Tally, ignore this email.</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0 16px;" />
        <p style="font-size: 12px; color: #999;">Tally by ATEM School</p>
      </div>`,
      text: `Verify your Tally email\n\nClick this link to verify: ${verifyUrl}\n\nIf you didn't sign up for Tally, ignore this email.`,
    }).catch(() => {});

    res.json({ sent: true });
  });
};
