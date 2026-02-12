const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const passport = require('../config/passport');
const User = require('../models/User');
const PasswordResetToken = require('../models/PasswordResetToken');
const Subscription = require('../models/Subscription');
const { requireAuth } = require('../middleware/auth');
const { isEmailConfigured, sendMail } = require('../utils/mailer');

const router = express.Router();

// Simple in-memory rate limiter for sensitive actions.
// Keyed per user + IP to slow down brute force attempts.
const sensitiveActionBuckets = new Map();
function rateLimitSensitiveAction({ key, limit, windowMs }) {
  const now = Date.now();
  const windowStart = now - windowMs;
  const existing = sensitiveActionBuckets.get(key);
  const hits = (existing?.hits || []).filter((t) => t > windowStart);
  hits.push(now);
  sensitiveActionBuckets.set(key, { hits, last: now });
  return hits.length <= limit;
}

// GET /signup
router.get('/signup', (req, res) => {
  if (req.isAuthenticated()) {
    return res.redirect('/assessment.html');
  }
  try {
    const redirect = sanitizeRedirectPath(req.query.redirect, '/onboarding.html');
    void req.app.locals.trackEvent?.(req, 'signup_view', { redirect });
  } catch (e) {
    // ignore
  }
  res.send(renderSignupPage(req.query.error, req.query.redirect));
});

// POST /signup
router.post('/signup', async (req, res) => {
  try {
    const { email, password, password_confirm } = req.body;
    const redirect = sanitizeRedirectPath(req.body.redirect || req.query.redirect, '/onboarding.html');

    // Validation
    if (!email || !password || !password_confirm) {
      return res.redirect('/signup?error=All fields are required');
    }

    if (password !== password_confirm) {
      return res.redirect('/signup?error=Passwords do not match');
    }

    if (password.length < 8) {
      return res.redirect('/signup?error=Password must be at least 8 characters');
    }

    // Check if user exists
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.redirect('/signup?error=Email already registered');
    }

    // Hash password
    const password_hash = await bcrypt.hash(password, 10);

    // Create user
    const user = new User({
      email: email.toLowerCase(),
      password_hash,
      role: 'user'
    });

    await user.save();

    // Log in the new user
    req.login(user, (err) => {
      if (err) {
        console.error('Login error after signup:', err);
        return res.redirect('/login');
      }
      try {
        void req.app.locals.trackEvent?.(req, 'signup_success', { redirect });
      } catch (e) {
        // ignore
      }
      res.redirect(redirect);
    });

  } catch (err) {
    console.error('Signup error:', err);
    res.redirect('/signup?error=An error occurred. Please try again.');
  }
});

// GET /login
router.get('/login', (req, res) => {
  if (req.isAuthenticated()) {
    return res.redirect('/assessment.html');
  }
  try {
    const redirect = sanitizeRedirectPath(req.query.redirect, '/assessment.html');
    void req.app.locals.trackEvent?.(req, 'login_view', { redirect });
  } catch (e) {
    // ignore
  }
  res.send(renderLoginPage(req.query.error, req.query.success, req.query.redirect));
});

// POST /login
router.post('/login', (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) {
      console.error('Login error:', err);
      return res.redirect('/login?error=An error occurred');
    }

    if (!user) {
      return res.redirect('/login?error=' + encodeURIComponent(info.message || 'Login failed'));
    }

    req.login(user, (err) => {
      if (err) {
        console.error('Session error:', err);
        return res.redirect('/login?error=An error occurred');
      }

      // Redirect to intended page or assessment
      const redirect = sanitizeRedirectPath(req.body.redirect || req.query.redirect, '/assessment.html');
      try {
        void req.app.locals.trackEvent?.(req, 'login_success', { redirect });
      } catch (e) {
        // ignore
      }
      res.redirect(redirect);
    });
  })(req, res, next);
});

function sanitizeRedirectPath(value, fallback) {
  const p = String(value || '').trim();
  if (!p) return fallback;
  // Only allow internal relative paths
  if (!p.startsWith('/') || p.startsWith('//') || p.includes('\\')) return fallback;
  return p;
}

// GET /logout
router.get('/logout', (req, res) => {
  req.logout((err) => {
    if (err) {
      console.error('Logout error:', err);
    }
    res.redirect('/');
  });
});

// GET /api/account/status
router.get('/api/account/status', requireAuth, async (req, res) => {
  try {
    const role = req.user?.role || 'user';
    if (role === 'admin') {
      return res.json({
        ok: true,
        email: req.user?.email || null,
        role,
        paid: true,
        subscription: null,
      });
    }

    const sub = await Subscription.findOne({ user_id: req.user._id })
      .sort({ current_period_end: -1, updated_at: -1, created_at: -1 })
      .select({ status: 1, current_period_end: 1, stripe_subscription_id: 1 })
      .lean();

    const hasAccess = !!(
      sub?.current_period_end &&
      new Date(sub.current_period_end).getTime() > Date.now() &&
      !['incomplete', 'incomplete_expired'].includes(String(sub.status || '').toLowerCase())
    );

    return res.json({
      ok: true,
      email: req.user?.email || null,
      role,
      paid: hasAccess,
      subscription: sub ? {
        status: sub.status,
        currentPeriodEnd: sub.current_period_end,
        stripeSubscriptionId: sub.stripe_subscription_id,
      } : null,
    });
  } catch (err) {
    console.error('[AccountStatus] Error:', err);
    return res.status(500).json({ ok: false, error: 'Failed to load account status' });
  }
});

// POST /api/account/password
router.post('/api/account/password', requireAuth, async (req, res) => {
  try {
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const limiterKey = `pw:${req.user._id.toString()}:${ip}`;
    const allowed = rateLimitSensitiveAction({ key: limiterKey, limit: 5, windowMs: 15 * 60 * 1000 });
    if (!allowed) {
      return res.status(429).json({ ok: false, error: 'Too many attempts. Please wait a few minutes and try again.' });
    }

    const currentPassword = String(req.body.currentPassword || '');
    const newPassword = String(req.body.newPassword || '');
    const confirmPassword = String(req.body.confirmPassword || '');

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ ok: false, error: 'All fields are required.' });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ ok: false, error: 'Passwords do not match.' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters.' });
    }

    const user = await User.findById(req.user._id).select({ password_hash: 1 }).lean();
    if (!user?.password_hash) {
      return res.status(400).json({ ok: false, error: 'Account password cannot be changed.' });
    }

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) {
      return res.status(400).json({ ok: false, error: 'Current password is incorrect.' });
    }

    const nextHash = await bcrypt.hash(newPassword, 10);
    await User.updateOne({ _id: req.user._id }, { $set: { password_hash: nextHash } });

    // Invalidate existing reset tokens for this user (optional hardening)
    await PasswordResetToken.updateMany(
      { user_id: req.user._id, used_at: null },
      { $set: { used_at: new Date() } }
    );

    // Force re-login after password change (invalidate the current session)
    await new Promise((resolve, reject) => {
      req.logout((err) => (err ? reject(err) : resolve()));
    });
    if (req.session) {
      req.session.destroy(() => {
        res.json({ ok: true, loggedOut: true });
      });
      return;
    }

    return res.json({ ok: true, loggedOut: true });
  } catch (err) {
    console.error('[ChangePassword] Error:', err);
    return res.status(500).json({ ok: false, error: 'Failed to change password' });
  }
});

// GET /reset-password
router.get('/reset-password', (req, res) => {
  const sent = String(req.query.sent || '') === '1';
  const error = req.query.error;
  const debugLink = req.session?.reset_debug_link || null;
  if (req.session && req.session.reset_debug_link) {
    delete req.session.reset_debug_link;
  }
  res.send(renderResetPasswordPage({ sent, error, debugLink }));
});

// POST /reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email) {
      return res.redirect('/reset-password?error=' + encodeURIComponent('Please enter your email.'));
    }

    // Always respond the same way to avoid account enumeration.
    const genericSuccessRedirect = '/reset-password?sent=1';

    const user = await User.findOne({ email });
    if (!user) {
      return res.redirect(genericSuccessRedirect);
    }

    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await PasswordResetToken.create({
      user_id: user._id,
      token_hash: tokenHash,
      expires_at: expiresAt
    });

    const baseUrl = getBaseUrl(req);
    const resetUrl = `${baseUrl}/reset-password/confirm?token=${encodeURIComponent(rawToken)}`;

    const didSend = await (async () => {
      try {
        const subject = 'Reset your ArxCafe password';
        const text = `Someone requested a password reset for your ArxCafe account.\n\nReset link (valid for 1 hour):\n${resetUrl}\n\nIf you didn't request this, you can ignore this email.`;
        const html = `
          <p>Someone requested a password reset for your ArxCafe account.</p>
          <p><a href="${resetUrl}">Reset your password</a> (valid for 1 hour)</p>
          <p>If you didn't request this, you can ignore this email.</p>
        `;

        return await sendMail({ to: email, subject, text, html });
      } catch (err) {
        console.error('[ResetPassword] Email send failed:', err?.message || err);
        return false;
      }
    })();

    if (!didSend) {
      console.warn('[ResetPassword] SMTP not configured (or send failed).');
      if (process.env.NODE_ENV !== 'production' && req.session) {
        req.session.reset_debug_link = resetUrl;
      }
    }

    return res.redirect(genericSuccessRedirect);
  } catch (err) {
    console.error('Reset password error:', err);
    return res.redirect('/reset-password?error=' + encodeURIComponent('Could not start password reset. Please try again.'));
  }
});

// GET /reset-password/confirm
router.get('/reset-password/confirm', async (req, res) => {
  const token = String(req.query.token || '').trim();
  res.send(renderResetPasswordConfirmPage({ token, error: req.query.error }));
});

// POST /reset-password/confirm
router.post('/reset-password/confirm', async (req, res) => {
  try {
    const token = String(req.body.token || '').trim();
    const password = String(req.body.password || '');
    const password_confirm = String(req.body.password_confirm || '');

    if (!token) {
      return res.redirect('/reset-password/confirm?error=' + encodeURIComponent('Invalid reset link.'));
    }

    if (!password || !password_confirm) {
      return res.redirect('/reset-password/confirm?token=' + encodeURIComponent(token) + '&error=' + encodeURIComponent('All fields are required.'));
    }

    if (password !== password_confirm) {
      return res.redirect('/reset-password/confirm?token=' + encodeURIComponent(token) + '&error=' + encodeURIComponent('Passwords do not match.'));
    }

    if (password.length < 8) {
      return res.redirect('/reset-password/confirm?token=' + encodeURIComponent(token) + '&error=' + encodeURIComponent('Password must be at least 8 characters.'));
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const record = await PasswordResetToken.findOne({
      token_hash: tokenHash,
      used_at: null,
      expires_at: { $gt: new Date() }
    });

    if (!record) {
      return res.redirect('/reset-password/confirm?error=' + encodeURIComponent('This reset link is invalid or expired.'));
    }

    const user = await User.findById(record.user_id);
    if (!user) {
      return res.redirect('/reset-password/confirm?error=' + encodeURIComponent('This reset link is invalid or expired.'));
    }

    user.password_hash = await bcrypt.hash(password, 10);
    await user.save();

    const now = new Date();
    await PasswordResetToken.updateMany({ user_id: user._id, used_at: null }, { $set: { used_at: now } });

    return res.redirect('/login?success=' + encodeURIComponent('Password updated. Please log in.'));
  } catch (err) {
    console.error('Reset password confirm error:', err);
    return res.redirect('/reset-password/confirm?error=' + encodeURIComponent('Could not reset password. Please try again.'));
  }
});

function getBaseUrl(req) {
  const configured = String(process.env.PUBLIC_BASE_URL || '').trim();
  if (configured) return configured.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

// Helper: Render signup page
function renderSignupPage(error, redirect) {
  const redirectPath = sanitizeRedirectPath(redirect, '/onboarding.html');
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Sign Up - ArxCafe</title>
    <link rel="stylesheet" href="/css/global.css">
    <style>
        .auth-container {
            max-width: 400px;
        margin: 20px auto;
        padding: 22px;
        background: var(--color-surface);
            border-radius: 8px;
        box-shadow: var(--shadow-sm);
        }
        .auth-container h1 {
            margin-bottom: 30px;
            text-align: center;
      color: var(--color-primary);
        }
        .form-group {
            margin-bottom: 20px;
        }
        .form-group label {
            display: block;
            margin-bottom: 8px;
            font-weight: 500;
        }
        .form-group input {
            width: 100%;
            padding: 12px;
          border: 1px solid var(--border);
            border-radius: 4px;
            font-size: 16px;
        }
        .btn-primary {
            width: 100%;
            padding: 14px;
          border: 1px solid rgba(74, 52, 46, 0.35);
          background: linear-gradient(135deg, rgba(198, 169, 146, 0.95), rgba(74, 52, 46, 0.95));
            color: white;
            border-radius: 4px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
        }
        .btn-primary:hover {
          filter: brightness(0.96);
        }
        .error-message {
          background: rgba(74, 52, 46, 0.10);
          color: var(--color-primary);
          border: 1px solid rgba(74, 52, 46, 0.18);
            padding: 12px;
            border-radius: 4px;
            margin-bottom: 20px;
        }
        .auth-links {
            text-align: center;
            margin-top: 20px;
        }
        .auth-links a {
          color: var(--color-primary);
            text-decoration: none;
        }
        .auth-subtitle { color: var(--color-secondary); text-align:center; margin: 0 0 18px; }
        @media (min-width: 768px) {
          .auth-container { margin: 80px auto; padding: 40px; }
        }
    </style>
</head>
<body>
    <div class="auth-container">
        <h1>Create Account</h1>
        <p class="auth-subtitle">Start practicing and track your quiz scores.</p>
        ${error ? `<div class="error-message">${error}</div>` : ''}
    <form method="POST" action="/signup">
      <input type="hidden" name="redirect" value="${redirectPath}">
            <div class="form-group">
                <label for="email">Email</label>
                <input type="email" id="email" name="email" required>
            </div>
            <div class="form-group">
                <label for="password">Password</label>
                <input type="password" id="password" name="password" required minlength="8">
            </div>
            <div class="form-group">
                <label for="password_confirm">Confirm Password</label>
                <input type="password" id="password_confirm" name="password_confirm" required>
            </div>
            <button type="submit" class="btn-primary">Sign Up</button>
        </form>
        <div class="auth-links">
          Already have an account? <a href="/login?redirect=${encodeURIComponent(redirectPath)}">Log in</a>
        </div>
    </div>
</body>
</html>
    `;
    }

// Helper: Render login page
function renderLoginPage(error, success, redirect) {
  const redirectPath = sanitizeRedirectPath(redirect, '/assessment.html');
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Log In - ArxCafe</title>
    <link rel="stylesheet" href="/css/global.css">
    <style>
        .auth-container {
            max-width: 400px;
        margin: 20px auto;
        padding: 22px;
          background: var(--color-surface);
            border-radius: 8px;
          box-shadow: var(--shadow-sm);
        }
        .auth-container h1 {
            margin-bottom: 30px;
            text-align: center;
        color: var(--color-primary);
        }
        .form-group {
            margin-bottom: 20px;
        }
        .form-group label {
            display: block;
            margin-bottom: 8px;
            font-weight: 500;
        }
        .form-group input {
            width: 100%;
            padding: 12px;
            border: 1px solid var(--border);
            border-radius: 4px;
            font-size: 16px;
        }
        .btn-primary {
            width: 100%;
            padding: 14px;
            border: 1px solid rgba(74, 52, 46, 0.35);
            background: linear-gradient(135deg, rgba(198, 169, 146, 0.95), rgba(74, 52, 46, 0.95));
            color: white;
            border-radius: 4px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
        }
        .btn-primary:hover {
            filter: brightness(0.96);
        }
        .error-message {
            background: rgba(74, 52, 46, 0.10);
            color: var(--color-primary);
            border: 1px solid rgba(74, 52, 46, 0.18);
            padding: 12px;
            border-radius: 4px;
            margin-bottom: 20px;
        }
        .success-message {
          background: rgba(198, 169, 146, 0.30);
          color: var(--color-primary);
          border: 1px solid rgba(198, 169, 146, 0.50);
          padding: 12px;
          border-radius: 4px;
          margin-bottom: 20px;
        }
        .auth-links {
            text-align: center;
            margin-top: 20px;
        }
        .auth-links a {
          color: var(--color-primary);
            text-decoration: none;
        }
        @media (min-width: 768px) {
          .auth-container { margin: 80px auto; padding: 40px; }
        }
    </style>
</head>
<body>
    <div class="auth-container">
        <h1>Log In</h1>
        ${success ? `<div class="success-message">${success}</div>` : ''}
        ${error ? `<div class="error-message">${error}</div>` : ''}
        <form method="POST" action="/login">
          <input type="hidden" name="redirect" value="${redirectPath}">
            <div class="form-group">
                <label for="email">Email</label>
                <input type="email" id="email" name="email" required>
            </div>
            <div class="form-group">
                <label for="password">Password</label>
                <input type="password" id="password" name="password" required>
            </div>
            <button type="submit" class="btn-primary">Log In</button>
        </form>
        <div class="auth-links">
            <a href="/reset-password">Forgot password?</a><br>
          Don't have an account? <a href="/signup?redirect=${encodeURIComponent(redirectPath)}">Sign up</a>
        </div>
    </div>
</body>
</html>
  `;
}

// Helper: Render reset password page
function renderResetPasswordPage({ sent, error, debugLink }) {
  const emailConfigured = isEmailConfigured();
  const smtpWarning = (!emailConfigured && process.env.NODE_ENV === 'production')
    ? 'Password reset email is not enabled on this service yet. Please contact support.'
    : '';
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Reset Password - ArxCafe</title>
    <link rel="stylesheet" href="/css/global.css">
    <style>
        .auth-container {
            max-width: 400px;
        margin: 20px auto;
        padding: 22px;
          background: var(--color-surface);
            border-radius: 8px;
          box-shadow: var(--shadow-sm);
        }
        .auth-container h1 {
            margin-bottom: 30px;
            text-align: center;
        color: var(--color-primary);
        }
        .form-group {
            margin-bottom: 20px;
        }
        .form-group label {
            display: block;
            margin-bottom: 8px;
            font-weight: 500;
        }
        .form-group input {
            width: 100%;
            padding: 12px;
          border: 1px solid var(--border);
            border-radius: 4px;
            font-size: 16px;
        }
        .btn-primary {
            width: 100%;
            padding: 14px;
          border: 1px solid rgba(74, 52, 46, 0.35);
          background: linear-gradient(135deg, rgba(198, 169, 146, 0.95), rgba(74, 52, 46, 0.95));
            color: white;
            border-radius: 4px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
        }
        .btn-primary:hover {
          filter: brightness(0.96);
        }
        .auth-links {
            text-align: center;
            margin-top: 20px;
        }
        .auth-links a {
          color: var(--color-primary);
            text-decoration: none;
        }
        .error-message { background: rgba(74, 52, 46, 0.10); color: var(--color-primary); border: 1px solid rgba(74, 52, 46, 0.18); padding: 12px; border-radius: 4px; margin-bottom: 16px; }
        .success-message { background: rgba(198, 169, 146, 0.30); color: var(--color-primary); border: 1px solid rgba(198, 169, 146, 0.50); padding: 12px; border-radius: 4px; margin-bottom: 16px; }
        .dev-link { background: rgba(198, 169, 146, 0.18); color: var(--color-text); border: 1px solid rgba(198, 169, 146, 0.35); padding: 12px; border-radius: 4px; margin-top: 12px; word-break: break-word; }
        .muted { color: var(--color-secondary); font-size: 13px; margin-top: 12px; }
        @media (min-width: 768px) {
          .auth-container { margin: 80px auto; padding: 40px; }
        }
    </style>
</head>
<body>
    <div class="auth-container">
        <h1>Reset Password</h1>
        ${error ? `<div class="error-message">${error}</div>` : ''}
        ${smtpWarning ? `<div class="error-message">${smtpWarning}</div>` : ''}
        ${sent ? `<div class="success-message">If that email exists, we sent a reset link.</div>` : ''}
        <p style="text-align: center; margin-bottom: 20px; color: var(--color-secondary);">Enter your email to receive a reset link (valid for 1 hour).</p>
        <form method="POST" action="/reset-password">
            <div class="form-group">
                <label for="email">Email</label>
                <input type="email" id="email" name="email" required>
            </div>
            <button type="submit" class="btn-primary">Send Reset Link</button>
        </form>
          <div class="muted">If you don't see the email in a few minutes, check Spam/Junk. If it still doesn't arrive, contact support.</div>
        ${(!emailConfigured && debugLink) ? `<div class="dev-link"><strong>Dev:</strong> SMTP not configured. Use this link:<br><a href="${debugLink}">${debugLink}</a></div>` : ''}
        <div class="auth-links">
            <a href="/login">Back to login</a>
        </div>
    </div>
</body>
</html>
  `;
}

    function renderResetPasswordConfirmPage({ token, error }) {
      return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Choose New Password - ArxCafe</title>
      <link rel="stylesheet" href="/css/global.css">
      <style>
        .auth-container {
          max-width: 400px;
          margin: 20px auto;
          padding: 22px;
          background: var(--color-surface);
          border-radius: 8px;
          box-shadow: var(--shadow-sm);
        }
        .auth-container h1 {
          margin-bottom: 16px;
          text-align: center;
          color: var(--color-primary);
        }
        .form-group { margin-bottom: 20px; }
        .form-group label { display:block; margin-bottom: 8px; font-weight: 500; }
        .form-group input { width:100%; padding: 12px; border: 1px solid var(--border); border-radius: 4px; font-size: 16px; }
        .btn-primary { width: 100%; padding: 14px; border: 1px solid rgba(74, 52, 46, 0.35); background: linear-gradient(135deg, rgba(198, 169, 146, 0.95), rgba(74, 52, 46, 0.95)); color: white; border-radius: 4px; font-size: 16px; font-weight: 600; cursor: pointer; }
        .btn-primary:hover { filter: brightness(0.96); }
        .error-message { background: rgba(74, 52, 46, 0.10); color: var(--color-primary); border: 1px solid rgba(74, 52, 46, 0.18); padding: 12px; border-radius: 4px; margin-bottom: 16px; }
        .auth-links { text-align:center; margin-top: 18px; }
        .auth-links a { color: var(--color-primary); text-decoration:none; }
        @media (min-width: 768px) { .auth-container { margin: 80px auto; padding: 40px; } }
      </style>
    </head>
    <body>
      <div class="auth-container">
        <h1>Choose a New Password</h1>
        ${error ? `<div class="error-message">${error}</div>` : ''}
        <form method="POST" action="/reset-password/confirm">
          <input type="hidden" name="token" value="${escapeHtml(token || '')}">
          <div class="form-group">
            <label for="password">New Password</label>
            <input type="password" id="password" name="password" required minlength="8">
          </div>
          <div class="form-group">
            <label for="password_confirm">Confirm New Password</label>
            <input type="password" id="password_confirm" name="password_confirm" required minlength="8">
          </div>
          <button type="submit" class="btn-primary">Update Password</button>
        </form>
        <div class="auth-links">
          <a href="/login">Back to login</a>
        </div>
      </div>
    </body>
    </html>
      `;
    }

    function escapeHtml(text) {
      const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
      return String(text).replace(/[&<>"']/g, (m) => map[m]);
    }

module.exports = router;
