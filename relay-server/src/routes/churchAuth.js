/**
 * Church app authentication routes: onboard, login, profile, reset password,
 * lead capture, and problem finder reports.
 *
 * @param {import('express').Express} app
 * @param {object} ctx - Shared server context
 */
module.exports = function setupChurchAuthRoutes(app, ctx) {
  const { hasOpenSocket } = require('../runtimeSockets');
  const { db, churches, requireAdmin, requireChurchAppAuth, requireChurchWriteAccess, rateLimit,
          queryClient,
          billing, hashPassword, verifyPassword, normalizeBillingInterval,
          issueChurchAppToken, checkChurchPaidAccess, generateRegistrationCode,
          sendOnboardingEmail, lifecycleEmails, broadcastToSSE,
          jwt, JWT_SECRET, CHURCH_APP_TOKEN_TTL, REQUIRE_ACTIVE_BILLING,
          TRIAL_PERIOD_DAYS, uuidv4, safeErrorMessage, log } = ctx;

  const hasQueryClient = queryClient && typeof queryClient.queryOne === 'function';
  const qOne = (sql, params = []) => (
    hasQueryClient ? queryClient.queryOne(sql, params) : db.prepare(sql).get(...params) || null
  );
  const qAll = (sql, params = []) => (
    hasQueryClient ? queryClient.query(sql, params) : db.prepare(sql).all(...params)
  );
  const qRun = (sql, params = []) => (
    hasQueryClient ? queryClient.run(sql, params) : db.prepare(sql).run(...params)
  );
  const normalizeChurchRow = (row) => {
    if (!row) return null;
    if (row.churchid !== undefined && row.churchId === undefined) {
      row.churchId = row.churchid;
    }
    return row;
  };

  // ─── ONBOARD (self-service signup) ───────────────────────────────────────────

  app.post('/api/church/app/onboard', rateLimit(10, 60 * 60 * 1000), async (req, res) => {
    const { name, email, password, tier, successUrl, cancelUrl, tosAcceptedAt, referralCode, locale } = req.body || {};
    const cleanLocale = locale && /^[a-z]{2}(-[A-Z]{2})?$/.test(String(locale)) ? String(locale) : null;
    const cleanName = String(name || '').trim();
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanReferralCode = String(referralCode || '').trim().toUpperCase();
    const planTier = String(tier || 'connect').toLowerCase();
    const planInterval = normalizeBillingInterval(
      req.body?.billingInterval ?? req.body?.billingCycle,
      planTier,
      planTier === 'event' ? 'one_time' : 'monthly',
    );

    if (!cleanName) return res.status(400).json({ error: 'name required' });
    if (!cleanEmail) return res.status(400).json({ error: 'email required' });
    if (!password || String(password).length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }
    if (!['connect', 'plus', 'pro', 'managed', 'event'].includes(planTier)) {
      return res.status(400).json({ error: 'invalid tier' });
    }
    if (!planInterval) {
      return res.status(400).json({ error: 'invalid billingInterval' });
    }

    const existingByName = await qOne('SELECT * FROM churches WHERE name = ?', [cleanName]);
    if (existingByName) {
      const isPending = existingByName.billing_status === 'pending' || existingByName.billing_status === 'inactive';
      if (!isPending) return res.status(409).json({ error: `A church named "${cleanName}" already exists` });
    }

    const existingByEmail = await qOne('SELECT churchId, billing_status, billing_trial_ends FROM churches WHERE portal_email = ?', [cleanEmail]);
    if (existingByEmail) {
      const isPending = existingByEmail.billing_status === 'pending' || existingByEmail.billing_status === 'inactive';
      if (!isPending) return res.status(409).json({ error: 'An account with this email already exists' });
      // Prevent trial abuse: if a previous account had a trial, don't grant another one
      if (existingByEmail.billing_trial_ends) {
        return res.status(409).json({ error: 'A trial has already been used with this email. Please complete checkout to continue.' });
      }
      const oldChurchId = existingByEmail.churchId;
      churches.delete(oldChurchId);
      await qRun('DELETE FROM billing_customers WHERE church_id = ?', [oldChurchId]);
      await qRun('DELETE FROM churches WHERE churchId = ?', [oldChurchId]);
      log(`[Onboarding] Cleaned up abandoned signup for ${cleanEmail} (old churchId: ${oldChurchId})`);
    }

    if (existingByName) {
      const oldChurchId = existingByName.churchId;
      churches.delete(oldChurchId);
      await qRun('DELETE FROM billing_customers WHERE church_id = ?', [oldChurchId]);
      await qRun('DELETE FROM churches WHERE churchId = ?', [oldChurchId]);
      log(`[Onboarding] Cleaned up abandoned signup for "${cleanName}" (old churchId: ${oldChurchId})`);
    }

    const churchId = uuidv4();
    const connectionToken = jwt.sign({ churchId, name: cleanName }, JWT_SECRET, { expiresIn: '365d' });
    const registeredAt = new Date().toISOString();
    const registrationCode = await generateRegistrationCode();

    const onboardStatus = billing.isEnabled() ? 'pending' : 'trialing';
    const trialEndsAt = new Date(Date.now() + TRIAL_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString();

    await qRun('INSERT INTO churches (churchId, name, email, token, registeredAt) VALUES (?, ?, ?, ?, ?)', [
      churchId, cleanName, cleanEmail, connectionToken, registeredAt,
    ]);
    await qRun('UPDATE churches SET registration_code = ? WHERE churchId = ?', [registrationCode, churchId]);

    const newReferralCode = (await generateRegistrationCode()).toUpperCase();
    const crypto = require('crypto');
    const emailVerifyToken = crypto.randomBytes(32).toString('hex');

    await qRun(`
      UPDATE churches
      SET portal_email = ?, portal_password_hash = ?, billing_tier = ?, billing_status = ?, billing_trial_ends = ?, billing_interval = ?, tos_accepted_at = ?, referral_code = ?,
          email_verify_token = ?, email_verify_sent_at = ?, locale = ?
      WHERE churchId = ?
    `, [cleanEmail, hashPassword(password), planTier, onboardStatus, trialEndsAt, planInterval, tosAcceptedAt || null, newReferralCode, emailVerifyToken, new Date().toISOString(), cleanLocale, churchId]);

    // Track referral
    let referrerId = null;
    let referralWarning = null;
    if (cleanReferralCode) {
      const referrer = await qOne('SELECT churchId, name FROM churches WHERE referral_code = ? AND churchId != ?', [cleanReferralCode, churchId]);
      if (referrer) {
        referrerId = referrer.churchId;
        await qRun('UPDATE churches SET referred_by = ? WHERE churchId = ?', [referrer.churchId, churchId]);
        try {
          // Prevent duplicate referral records for the same referred church
          const existing = await qOne('SELECT id FROM referrals WHERE referred_id = ? LIMIT 1', [churchId]);
          if (!existing) {
            await qRun(`
              INSERT INTO referrals (id, referrer_id, referred_id, referred_name, status, created_at)
              VALUES (?, ?, ?, ?, 'pending', ?)
            `, [crypto.randomUUID(), referrer.churchId, churchId, cleanName, registeredAt]);
            log(`[Referral] ${cleanName} referred by ${referrer.name} (code: ${cleanReferralCode})`);
          }
        } catch (e) { log(`[Referral] Failed to record: ${e.message}`); }
      } else {
        referralWarning = 'Referral code not found. Your account was created without a referral.';
        log(`[Referral] Invalid code "${cleanReferralCode}" submitted by ${cleanName}`);
      }
    }

    churches.set(churchId, {
      churchId, name: cleanName, email: cleanEmail, token: connectionToken,
      ws: null, status: {},
      lastSeen: null, lastHeartbeat: null, registeredAt, disconnectedAt: null,
      _offlineAlertSent: false, church_type: 'recurring',
      event_expires_at: null, event_label: null, reseller_id: null, registrationCode,
    });

    let checkoutUrl = null;
    let checkoutSessionId = null;
    let checkoutError = null;

    if (billing.isEnabled()) {
      try {
        const checkout = await billing.createCheckout({
          tier: planTier, billingInterval: planInterval, churchId, email: cleanEmail,
          successUrl, cancelUrl, isEvent: planTier === 'event',
        });
        checkoutUrl = checkout.url || null;
        checkoutSessionId = checkout.sessionId || null;
      } catch (e) {
        checkoutError = e.message;
        log(`[Onboarding] Checkout setup failed for ${churchId}: ${e.message}`);
      }
    }

    // Send email verification (non-blocking)
    const relayBase = process.env.RELAY_URL || 'https://api.tallyconnect.app';
    if (process.env.NODE_ENV === 'production' && !relayBase.startsWith('https://')) {
      log('[Onboarding] CRITICAL: RELAY_URL must start with https:// in production. Skipping verification email.');
    }
    const verifyUrl = `${relayBase}/api/church/verify-email?token=${emailVerifyToken}`;
    sendOnboardingEmail({
      to: cleanEmail,
      subject: 'Confirm your email to activate your trial',
      tag: 'email-verification',
      html: `<div style="font-family: system-ui, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 0;">
        <div style="margin-bottom: 24px;">
          <span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: #22c55e; margin-right: 8px;"></span>
          <strong style="font-size: 16px; color: #111;">Tally</strong>
        </div>
        <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Confirm your email to activate your trial</h1>
        <p style="font-size: 15px; color: #333; line-height: 1.6;">Click below to verify the email address for <strong>${cleanName}</strong>. Once confirmed, your 30-day trial will be fully active and you can access the portal.</p>
        <p style="margin: 28px 0;">
          <a href="${verifyUrl}" style="display: inline-block; padding: 12px 28px; font-size: 15px; font-weight: 700; background: #22c55e; color: #000; text-decoration: none; border-radius: 8px;">Confirm Email &amp; Activate Trial</a>
        </p>
        <p style="font-size: 13px; color: #666;">If you didn't sign up for Tally, you can safely ignore this email.</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0 16px;" />
        <p style="font-size: 12px; color: #999;">Tally &mdash; tallyconnect.app</p>
      </div>`,
      text: `Confirm your email to activate your trial\n\nClick this link to verify your email and activate your 30-day trial: ${verifyUrl}\n\nIf you didn't sign up for Tally, you can safely ignore this email.`,
    }).catch(e => log(`[Onboarding] Verification email failed for ${cleanEmail}: ${e.message}`));

    if (lifecycleEmails) {
      const regChurch = { churchId, name: cleanName, portal_email: cleanEmail };
      lifecycleEmails.sendRegistrationConfirmation(regChurch).catch(e => log(`[Onboarding] Registration confirmation email failed for ${cleanEmail}: ${e.message}`));
    }

    const appToken = issueChurchAppToken(churchId, cleanName);
    const access = checkChurchPaidAccess(churchId);

    res.status(201).json({
      created: true, churchId, name: cleanName, email: cleanEmail, registrationCode,
      token: appToken, tokenExpiresIn: CHURCH_APP_TOKEN_TTL,
      billing: {
        required: REQUIRE_ACTIVE_BILLING && billing.isEnabled(),
        status: access.status, tier: planTier, billingInterval: planInterval, trialEndsAt,
      },
      checkoutUrl, checkoutSessionId, checkoutError,
      ...(referralWarning ? { referralWarning } : {}),
    });
  });

  // ─── REFERRAL CODE LOOKUP (public, rate-limited) ────────────────────────────

  app.get('/api/referral/:code', rateLimit(20, 60_000), async (req, res) => {
    const code = String(req.params.code || '').trim().toUpperCase();
    if (!code || code.length < 4) return res.status(400).json({ error: 'Invalid code' });
    const church = await qOne('SELECT name FROM churches WHERE referral_code = ?', [code]);
    if (!church) return res.json({ valid: false });
    res.json({ valid: true, referrerName: church.name });
  });

  // ─── LEAD CAPTURE ────────────────────────────────────────────────────────────

  app.post('/api/leads/capture', rateLimit(5, 60_000), async (req, res) => {
    const { email, name, churchName, source } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    const lead = lifecycleEmails.captureLead({ email: cleanEmail, name, source, churchName });
    if (!lead) return res.status(500).json({ error: 'Failed to capture lead' });
    lifecycleEmails.sendLeadWelcome(lead).catch(e => log(`[Leads] Welcome email failed for ${cleanEmail}: ${e.message}`));
    log(`[Leads] Captured lead: ${cleanEmail} (source: ${source || 'website'})`);
    res.json({ ok: true, message: 'Thanks! Check your email.' });
  });

  // ─── APP LOGIN ───────────────────────────────────────────────────────────────

  app.post('/api/church/app/login', rateLimit(5, 15 * 60 * 1000), async (req, res) => {
    const { email, password } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail || !password) {
      return res.status(400).json({ error: 'email and password required' });
    }

    const church = normalizeChurchRow(await qOne('SELECT * FROM churches WHERE portal_email = ?', [cleanEmail]));
    if (!church || !church.portal_password_hash || !verifyPassword(password, church.portal_password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const access = checkChurchPaidAccess(church.churchId);
    if (!access.allowed) {
      return res.status(402).json({
        error: access.message,
        billing: { status: access.status, tier: access.tier, billingInterval: access.billingInterval },
      });
    }

    const token = issueChurchAppToken(church.churchId, church.name);
    res.json({
      token, tokenType: 'Bearer', tokenExpiresIn: CHURCH_APP_TOKEN_TTL,
      church: { churchId: church.churchId, name: church.name, email: church.portal_email || church.email || '' },
      billing: { status: access.status, tier: access.tier, billingInterval: access.billingInterval, bypassed: !!access.bypassed },
    });
  });

  // ─── READONLY TOKEN (for staff / office managers who need view-only access) ──

  // POST /api/church/app/readonly-token — issues a read-only JWT for church staff
  // Requires full portal credentials; the resulting token rejects all write endpoints.
  app.post('/api/church/app/readonly-token', rateLimit(5, 15 * 60 * 1000), async (req, res) => {
    const { email, password } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail || !password) {
      return res.status(400).json({ error: 'email and password required' });
    }
    const church = await qOne('SELECT * FROM churches WHERE portal_email = ?', [cleanEmail]);
    if (!church || !church.portal_password_hash || !verifyPassword(password, church.portal_password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = issueChurchAppToken(church.churchId, church.name, { readonly: true });
    res.json({
      token, tokenType: 'Bearer', tokenExpiresIn: CHURCH_APP_TOKEN_TTL, readonly: true,
      church: { churchId: church.churchId, name: church.name },
    });
  });

  // ─── CHURCH APP PROFILE ──────────────────────────────────────────────────────

  app.get('/api/church/app/me', requireChurchAppAuth, async (req, res) => {
    const c = req.church;
    const runtime = churches.get(c.churchId);
    let tds = [];
    try {
      tds = await qAll('SELECT * FROM church_tds WHERE church_id = ? AND active = 1 ORDER BY registered_at ASC', [c.churchId]);
    } catch (e) { console.warn('[churchAuth] church_tds query failed (schema may vary):', e.message); }
    const { portal_password_hash, token, ...safe } = c;
    let notifications = {};
    try { notifications = JSON.parse(c.notifications || '{}'); } catch (e) { console.warn('[churchAuth] Failed to parse notifications JSON:', e.message); }
    res.json({
      ...safe, notifications, tds,
      connected: hasOpenSocket(runtime),
      status: runtime?.status || {},
      lastSeen: runtime?.lastSeen || null,
    });
  });

  // GET /api/church/app/rooms — list available rooms for the desktop app
  app.get('/api/church/app/rooms', requireChurchAppAuth, async (req, res) => {
    try {
      const churchId = req.church.churchId;
      const rooms = await qAll('SELECT id, campus_id, name, description FROM rooms WHERE campus_id = ? AND deleted_at IS NULL ORDER BY name ASC', [churchId]);
      const currentRoomId = (await qOne('SELECT room_id FROM churches WHERE churchId = ?', [churchId]))?.room_id || null;
      res.json({ rooms, currentRoomId });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // POST /api/church/app/room-assign — assign this desktop to a room
  app.post('/api/church/app/room-assign', requireChurchAppAuth, requireChurchWriteAccess, async (req, res) => {
    try {
      const churchId = req.church.churchId;
      const roomId = req.body?.roomId || null;
      if (roomId) {
        const room = await qOne('SELECT id, name FROM rooms WHERE id = ? AND campus_id = ? AND deleted_at IS NULL', [roomId, churchId]);
        if (!room) return res.status(404).json({ error: 'Room not found or not accessible by this church' });
        await qRun('UPDATE churches SET room_id = ?, room_name = ? WHERE churchId = ?', [roomId, room.name, churchId]);
        res.json({ ok: true, roomId, roomName: room.name });
      } else {
        await qRun('UPDATE churches SET room_id = NULL, room_name = NULL WHERE churchId = ?', [churchId]);
        res.json({ ok: true, roomId: null, roomName: null });
      }
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // POST /api/church/app/rooms — create a new room from the desktop app
  app.post('/api/church/app/rooms', requireChurchAppAuth, requireChurchWriteAccess, async (req, res) => {
    try {
      const churchId = req.church.churchId;
      const tier = String(req.church.billing_tier || 'connect').toLowerCase();
      const tierRoomLimits = { connect: 1, plus: 3, pro: 5, managed: 999, event: 1 };
      const maxRooms = tierRoomLimits[tier] || 1;
      const currentCount = (await qOne('SELECT COUNT(*) AS cnt FROM rooms WHERE campus_id = ? AND deleted_at IS NULL', [churchId]))?.cnt || 0;
      if (currentCount >= maxRooms) {
        return res.status(403).json({
          error: `Your ${tier.toUpperCase()} plan allows ${maxRooms} room${maxRooms === 1 ? '' : 's'}. Upgrade for more.`,
        });
      }
      const name = String(req.body?.name || '').trim();
      const description = String(req.body?.description || '').trim();
      if (!name) return res.status(400).json({ error: 'Room name is required' });
      if (description.length > 500) return res.status(400).json({ error: 'Room description must be 500 characters or less' });

      const id = uuidv4();
      const created_at = new Date().toISOString();
      await qRun('INSERT INTO rooms (id, campus_id, church_id, name, description, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
        id, churchId, churchId, name, description, created_at,
      ]);
      res.status(201).json({ id, campusId: churchId, name, description, createdAt: created_at });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // POST /api/pf/report — Problem Finder analysis results
  app.post('/api/pf/report', requireChurchAppAuth, requireChurchWriteAccess, async (req, res) => {
    try {
      const churchId = req.church.churchId;
      const b = req.body || {};
      const id = b.runId || uuidv4();
      const status = String(b.status || 'NO_GO').toUpperCase();
      if (status !== 'GO' && status !== 'NO_GO') {
        return res.status(400).json({ error: 'status must be GO or NO_GO' });
      }

      const issueCount = parseInt(b.issueCount, 10) || 0;
      const autoFixedCount = parseInt(b.autoFixedCount, 10) || 0;
      const coverageScore = parseFloat(b.coverageScore) || 0;
      const blockerCount = parseInt(b.blockerCount, 10) || 0;
      const triggerType = String(b.triggerType || 'manual').slice(0, 50);

      const issuesJson = JSON.stringify(Array.isArray(b.issues) ? b.issues : []);
      const blockersJson = JSON.stringify(Array.isArray(b.blockers) ? b.blockers : []);
      const autoFixedJson = JSON.stringify(Array.isArray(b.autoFixed) ? b.autoFixed : []);
      const needsAttentionJson = JSON.stringify(Array.isArray(b.needsAttention) ? b.needsAttention : []);
      const topActionsJson = JSON.stringify(Array.isArray(b.topActions) ? b.topActions : []);
      const createdAt = b.createdAt || new Date().toISOString();

      await qRun(`
        INSERT OR REPLACE INTO problem_finder_reports
          (id, church_id, trigger_type, status, issue_count, auto_fixed_count, coverage_score,
           blocker_count, issues_json, blockers_json, auto_fixed_json, needs_attention_json,
           top_actions_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [id, churchId, triggerType, status, issueCount, autoFixedCount, coverageScore,
        blockerCount, issuesJson, blockersJson, autoFixedJson, needsAttentionJson,
        topActionsJson, createdAt]);

      broadcastToSSE({
        type: 'pf_report', churchId, status, issueCount, blockerCount, autoFixedCount, timestamp: createdAt,
      });

      log(`[PF] Report saved for ${req.church.name}: ${status} (${issueCount} issues, ${blockerCount} blockers)`);
      res.status(201).json({ id, status: 'saved' });
    } catch (e) {
      log(`[PF] Report save error: ${e.message}`);
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // PUT /api/church/app/me — update profile
  app.put('/api/church/app/me', requireChurchAppAuth, requireChurchWriteAccess, async (req, res) => {
    const { email, phone, location, notes, notifications, telegramChatId, engineerProfile, newPassword, currentPassword, password, locale } = req.body;
    const churchId = req.church.churchId;

    const newPw = newPassword || password;
    if (newPw) {
      if (!currentPassword) {
        return res.status(400).json({ error: 'Current password is required to set a new password' });
      }
      if (!req.church.portal_password_hash || !verifyPassword(currentPassword, req.church.portal_password_hash)) {
        return res.status(400).json({ error: 'Current password is incorrect' });
      }
      if (newPw.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
      await qRun('UPDATE churches SET portal_password_hash = ? WHERE churchId = ?', [hashPassword(newPw), churchId]);
    }

    const ALLOWED_PROFILE_COLUMNS = ['portal_email', 'phone', 'location', 'notes', 'telegram_chat_id', 'notifications', 'engineer_profile', 'audio_via_atem', 'locale'];
    const { audioViaAtem } = req.body;
    const patch = {};
    if (email !== undefined) {
      const cleanNewEmail = email.trim().toLowerCase();
      const existingEmail = await qOne('SELECT churchId FROM churches WHERE portal_email = ? AND churchId != ?', [cleanNewEmail, churchId]);
      if (existingEmail) {
        return res.status(409).json({ error: 'This email is already in use by another account' });
      }
      patch.portal_email = cleanNewEmail;
    }
    if (phone          !== undefined) patch.phone            = phone;
    if (location       !== undefined) patch.location         = location;
    if (notes          !== undefined) patch.notes            = notes;
    if (telegramChatId !== undefined) patch.telegram_chat_id = telegramChatId;
    if (notifications  !== undefined) patch.notifications    = JSON.stringify(notifications);
    if (engineerProfile !== undefined) patch.engineer_profile = JSON.stringify(engineerProfile);
    if (audioViaAtem   !== undefined) patch.audio_via_atem   = audioViaAtem ? 1 : 0;
    if (locale !== undefined) {
      // Validate locale format (e.g. "en", "es", "en-US")
      const cleanLocale = locale && /^[a-z]{2}(-[A-Z]{2})?$/.test(String(locale)) ? String(locale) : null;
      patch.locale = cleanLocale;
    }

    const safePatch = {};
    for (const [col, val] of Object.entries(patch)) {
      if (ALLOWED_PROFILE_COLUMNS.includes(col)) safePatch[col] = val;
    }

    if (Object.keys(safePatch).length) {
      const sets = Object.keys(safePatch).map(k => `${k} = ?`).join(', ');
      await qRun(`UPDATE churches SET ${sets} WHERE churchId = ?`, [...Object.values(safePatch), churchId]);
      if (safePatch.audio_via_atem !== undefined) {
        const runtime = churches.get(churchId);
        if (runtime) {
          runtime.audio_via_atem = safePatch.audio_via_atem;
          runtime._audioViaAtemManualOverride = true;
        }
      }
    }
    res.json({ ok: true });
  });

  // POST /api/church/app/reset-password
  app.post('/api/church/app/reset-password', requireAdmin, async (req, res) => {
    const { email, password } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail || !password) {
      return res.status(400).json({ error: 'email and password required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const church = await qOne('SELECT churchId FROM churches WHERE portal_email = ?', [cleanEmail]);
    if (!church) {
      return res.status(404).json({ error: 'No account found with that email' });
    }

    await qRun('UPDATE churches SET portal_password_hash = ? WHERE churchId = ?', [hashPassword(password), church.churchId]);

    log(`[ResetPassword] Password updated for ${cleanEmail} (church ${church.churchId})`);
    res.json({ ok: true });
  });
};
