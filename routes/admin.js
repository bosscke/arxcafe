const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { requireAdmin } = require('../middleware/auth');
const User = require('../models/User');
const Subscription = require('../models/Subscription');
const QuizAttempt = require('../models/QuizAttempt');
const PasswordResetToken = require('../models/PasswordResetToken');
const { isEmailConfigured, sendMail } = require('../utils/mailer');

const router = express.Router();

// GET /admin - Admin dashboard
router.get('/admin', requireAdmin, async (req, res) => {
  try {
    const users = await User.find().sort({ created_at: -1 }).limit(100);
    const subscriptions = await Subscription.find().populate('user_id').sort({ created_at: -1 }).limit(100);

        const recentAttempts = await QuizAttempt.find()
            .populate('user_id')
            .sort({ created_at: -1 })
            .limit(100);

        const progressAgg = await QuizAttempt.aggregate([
            { $sort: { created_at: -1 } },
            {
                $group: {
                    _id: '$user_id',
                    attempts: { $sum: 1 },
                    last_percentage: { $first: '$percentage' },
                    last_score: { $first: '$score' },
                    last_total: { $first: '$total' },
                    last_created_at: { $first: '$created_at' },
                    best_percentage: { $max: '$percentage' }
                }
            },
            { $sort: { last_created_at: -1 } },
            { $limit: 200 }
        ]);

        const progressByUserId = new Map(progressAgg.map((r) => [String(r._id), r]));
    
    const stats = {
      totalUsers: await User.countDocuments(),
      totalSubscriptions: await Subscription.countDocuments({ status: 'active' }),
            revenue: await Subscription.countDocuments({ status: 'active' }) * 19.99,
            totalQuizAttempts: await QuizAttempt.countDocuments()
    };

        res.send(renderAdminDashboard(req.user, users, subscriptions, stats, recentAttempts, progressByUserId));
  } catch (err) {
    console.error('Admin dashboard error:', err);
    res.status(500).send('Error loading dashboard');
  }
});

// POST /admin/grant-access - Manually grant access to a user
router.post('/admin/grant-access', requireAdmin, async (req, res) => {
  try {
    const { email, duration_days } = req.body;

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Create manual subscription (no Stripe)
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + parseInt(duration_days || 30));

    await Subscription.findOneAndUpdate(
      { user_id: user._id, stripe_customer_id: 'manual_admin' },
      {
        user_id: user._id,
        stripe_customer_id: 'manual_admin',
        stripe_subscription_id: `manual_${Date.now()}`,
        status: 'active',
        current_period_end: endDate,
        updated_at: new Date()
      },
      { upsert: true }
    );

    res.json({ success: true, message: `Access granted to ${email} for ${duration_days} days` });
  } catch (err) {
    console.error('Grant access error:', err);
    res.status(500).json({ error: 'Failed to grant access' });
  }
});

// POST /admin/revoke-access - Revoke user access
router.post('/admin/revoke-access', requireAdmin, async (req, res) => {
  try {
    const { email } = req.body;

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    await Subscription.updateMany(
      { user_id: user._id },
      { status: 'canceled', updated_at: new Date() }
    );

    res.json({ success: true, message: `Access revoked for ${email}` });
  } catch (err) {
    console.error('Revoke access error:', err);
    res.status(500).json({ error: 'Failed to revoke access' });
  }
});

// POST /admin/create-admin - Create additional admin user
router.post('/admin/create-admin', requireAdmin, async (req, res) => {
  try {
    const { email, password } = req.body;

    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const password_hash = await bcrypt.hash(password, 10);

    const admin = new User({
      email: email.toLowerCase(),
      password_hash,
      role: 'admin'
    });

    await admin.save();

    res.json({ success: true, message: `Admin created: ${email}` });
  } catch (err) {
    console.error('Create admin error:', err);
    res.status(500).json({ error: 'Failed to create admin' });
  }
});

// POST /admin/reset-link - Generate a password reset link for a user (admin-only)
router.post('/admin/reset-link', requireAdmin, async (req, res) => {
    try {
        const email = String(req.body.email || '').trim().toLowerCase();
        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const rawToken = crypto.randomBytes(32).toString('base64url');
        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

        await PasswordResetToken.create({
            user_id: user._id,
            token_hash: tokenHash,
            expires_at: expiresAt
        });

        const baseUrl = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
        const resetUrl = `${baseUrl}/reset-password/confirm?token=${encodeURIComponent(rawToken)}`;

        return res.json({
            success: true,
            resetUrl,
            expiresAt: expiresAt.toISOString()
        });
    } catch (err) {
        console.error('Admin reset-link error:', err);
        return res.status(500).json({ error: 'Failed to generate reset link' });
    }
});

// POST /admin/test-email - Send a test email (admin-only)
router.post('/admin/test-email', requireAdmin, async (req, res) => {
    try {
        const to = String(req.body.to || '').trim();
        if (!to) return res.status(400).json({ error: 'Recipient email is required' });

        if (!isEmailConfigured()) {
            return res.status(400).json({ error: 'Email is not configured on this service' });
        }

        const subject = 'ArxCafe SMTP test';
        const text = 'This is a test email from ArxCafe Cloud Run.';
        const html = '<p>This is a test email from <strong>ArxCafe</strong> Cloud Run.</p>';

        const ok = await sendMail({ to, subject, text, html });
        if (!ok) return res.status(500).json({ error: 'Failed to send test email' });

        return res.json({ success: true, message: 'Test email sent (SMTP accepted).' });
    } catch (err) {
        console.error('Admin test-email error:', err);
        return res.status(500).json({ error: 'Failed to send test email' });
    }
});

// Helper: Render admin dashboard
function renderAdminDashboard(admin, users, subscriptions, stats, recentAttempts, progressByUserId) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Dashboard - ArxCafe</title>
    <link rel="stylesheet" href="/css/global.css">
    <style>
        .admin-container {
            max-width: 1200px;
            margin: 20px auto;
            padding: 12px;
        }
        .admin-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 10px;
            margin-bottom: 18px;
            flex-wrap: wrap;
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
            gap: 20px;
            margin-bottom: 18px;
        }
        .stat-card {
            background: var(--color-surface);
            padding: 18px;
            border-radius: 8px;
            border: 1px solid var(--border);
            box-shadow: var(--shadow-sm);
            text-align: center;
        }
        .stat-value {
            font-size: 36px;
            font-weight: bold;
            color: var(--color-primary);
        }
        .stat-label {
            font-size: 14px;
            color: var(--color-secondary);
            margin-top: 10px;
        }
        .section {
            background: var(--color-surface);
            padding: 18px;
            border-radius: 8px;
            border: 1px solid var(--border);
            box-shadow: var(--shadow-sm);
            margin-bottom: 30px;
        }
        .form-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
        .form-row input { flex: 1; min-width: 220px; padding: 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--color-surface); color: var(--color-text); }
        .btn { padding: 10px 14px; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; }
        .btn-primary { background: var(--color-primary); color: var(--color-bg); border: 1px solid rgba(74, 52, 46, 0.35); }
        .btn-primary:hover { filter: brightness(0.96); }
        .note { color: #6b7280; font-size: 13px; margin-top: 10px; }
        .reset-output { margin-top: 12px; word-break: break-word; }
        .reset-output a { color: var(--color-primary); }
        .error-text { color: var(--color-primary); }
        .ok-text { color: var(--color-primary); }
        .section h2 {
            margin-bottom: 20px;
        }
        .table-wrap { overflow-x: auto; }
        table {
            width: 100%;
            border-collapse: collapse;
            min-width: 520px;
        }
        th {
            background: rgba(245, 243, 241, 0.70);
            padding: 12px;
            text-align: left;
            font-weight: 600;
        }
        td {
            padding: 12px;
            border-bottom: 1px solid var(--border);
        }
        .badge {
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: 600;
        }
        .badge-active {
            background: rgba(198, 169, 146, 0.30);
            color: var(--color-primary);
        }
        .badge-canceled {
            background: rgba(74, 52, 46, 0.10);
            color: var(--color-primary);
        }
        .badge-admin {
            background: rgba(198, 169, 146, 0.22);
            color: var(--color-text);
        }
        .form-inline {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            margin-top: 20px;
        }
        .form-inline input {
            padding: 8px;
            border: 1px solid var(--border);
            border-radius: 4px;
            min-width: 160px;
            background: var(--color-surface);
            color: var(--color-text);
        }
        .btn {
            padding: 8px 16px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-weight: 600;
        }
        .btn-primary {
            background: var(--color-primary);
            color: var(--color-bg);
            border: 1px solid rgba(74, 52, 46, 0.35);
        }
        .btn-danger {
            background: rgba(74, 52, 46, 0.10);
            color: var(--color-primary);
            border: 1px solid rgba(74, 52, 46, 0.18);
        }
        .muted { color: var(--color-secondary); }
        @media (min-width: 768px) {
          .admin-container { margin: 40px auto; padding: 20px; }
          .section { padding: 30px; }
          .stat-card { padding: 30px; }
        }
    </style>
</head>
<body>
    <div class="admin-container">
        <div class="admin-header">
            <h1>Admin Dashboard</h1>
            <div>
                ${admin.email} | <a href="/logout">Logout</a>
            </div>
        </div>

        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-value">${stats.totalUsers}</div>
                <div class="stat-label">Total Users</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.totalSubscriptions}</div>
                <div class="stat-label">Active Subscriptions</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">$${stats.revenue.toFixed(2)}</div>
                <div class="stat-label">Monthly Revenue</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.totalQuizAttempts}</div>
                <div class="stat-label">Quiz Attempts</div>
            </div>
        </div>

        <div class="section">
            <h2>Password Reset (Admin)</h2>
            <div class="form-row">
                <input type="email" id="resetEmail" placeholder="user@example.com" autocomplete="off" />
                <button class="btn btn-primary" id="generateResetBtn" type="button">Generate reset link</button>
            </div>
            <div class="note">Use this if email delivery is down. Link expires in 1 hour.</div>
            <div class="reset-output" id="resetOutput"></div>
        </div>

        <div class="section">
            <h2>Email Test (Admin)</h2>
            <div class="form-row">
                <input type="email" id="testEmailTo" placeholder="recipient@example.com" autocomplete="off" />
                <button class="btn btn-primary" id="sendTestEmailBtn" type="button">Send test email</button>
            </div>
            <div class="note">Uses the configured SMTP sender for a basic delivery test.</div>
            <div class="reset-output" id="testEmailOutput"></div>
        </div>

        <div class="section">
            <h2>Grant Access</h2>
            <p>Manually grant premium access to a user (bypasses payment)</p>
            <div class="form-inline">
                <input type="email" id="grant-email" placeholder="user@example.com" style="flex: 1;">
                <input type="number" id="grant-days" placeholder="Days" value="30" style="width: 100px;">
                <button class="btn btn-primary" onclick="grantAccess()">Grant Access</button>
            </div>
        </div>

        <div class="section">
            <h2>Recent Users</h2>
            <div class="table-wrap">
            <table>
                <thead>
                    <tr>
                        <th>Email</th>
                        <th>Role</th>
                        <th>Created</th>
                        <th>Quiz Progress</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    ${users.map(u => `
                        <tr>
                            <td>${u.email}</td>
                            <td><span class="badge ${u.role === 'admin' ? 'badge-admin' : ''}">${u.role}</span></td>
                            <td>${new Date(u.created_at).toLocaleDateString()}</td>
                            <td>
                              ${(() => {
                                const p = progressByUserId.get(String(u._id));
                                if (!p) return '<span class="muted">No attempts</span>';
                                                                const lastPct = typeof p.last_percentage === 'number' ? p.last_percentage : '—';
                                                                const bestPct = typeof p.best_percentage === 'number' ? p.best_percentage : '—';
                                                                return `${p.attempts} attempt(s) • Last ${lastPct}% • Best ${bestPct}%`;
                              })()}
                            </td>
                            <td>
                                ${u.role !== 'admin' ? `<button class="btn btn-danger" onclick="revokeAccess('${u.email}')">Revoke</button>` : ''}
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
            </div>
        </div>

        <div class="section">
            <h2>Recent Quiz Attempts</h2>
            <p class="muted">Latest submissions from paid users (most recent first).</p>
            <div class="table-wrap">
            <table>
                <thead>
                    <tr>
                        <th>User</th>
                        <th>Quiz</th>
                        <th>Score</th>
                        <th>Percent</th>
                        <th>Date</th>
                    </tr>
                </thead>
                <tbody>
                    ${recentAttempts.map(a => `
                        <tr>
                            <td>${a.user_id ? a.user_id.email : 'N/A'}</td>
                            <td>${a.quiz_id}</td>
                            <td>${a.score} / ${a.total}</td>
                            <td>${a.percentage}%</td>
                            <td>${new Date(a.created_at).toLocaleString()}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
            </div>
        </div>

        <div class="section">
            <h2>Active Subscriptions</h2>
            <div class="table-wrap">
            <table>
                <thead>
                    <tr>
                        <th>User</th>
                        <th>Status</th>
                        <th>Expires</th>
                        <th>Stripe ID</th>
                    </tr>
                </thead>
                <tbody>
                    ${subscriptions.map(s => `
                        <tr>
                            <td>${s.user_id ? s.user_id.email : 'N/A'}</td>
                            <td><span class="badge ${s.status === 'active' ? 'badge-active' : 'badge-canceled'}">${s.status}</span></td>
                            <td>${new Date(s.current_period_end).toLocaleDateString()}</td>
                            <td>${s.stripe_subscription_id}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
            </div>
        </div>
    </div>

    <script>
        async function grantAccess() {
            const email = document.getElementById('grant-email').value;
            const days = document.getElementById('grant-days').value;

            if (!email) {
                alert('Please enter an email address');
                return;
            }

            try {
                const res = await fetch('/admin/grant-access', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, duration_days: days })
                });

                const data = await res.json();

                if (data.success) {
                    alert(data.message);
                    location.reload();
                } else {
                    alert('Error: ' + data.error);
                }
            } catch (err) {
                alert('An error occurred');
            }
        }

        async function revokeAccess(email) {
            if (!confirm(\`Revoke access for \${email}?\`)) return;

            try {
                const res = await fetch('/admin/revoke-access', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email })
                });

                const data = await res.json();

                if (data.success) {
                    alert(data.message);
                    location.reload();
                } else {
                    alert('Error: ' + data.error);
                }
            } catch (err) {
                alert('An error occurred');
            }
        }
        async function generateResetLink() {
            const emailEl = document.getElementById('resetEmail');
            const outEl = document.getElementById('resetOutput');
            const email = (emailEl.value || '').trim();
            outEl.textContent = '';

            if (!email) {
                outEl.innerHTML = '<div class="error-text">Email is required.</div>';
                return;
            }

            try {
                const res = await fetch('/admin/reset-link', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email })
                });

                const data = await res.json();
                if (!res.ok) {
                    outEl.innerHTML = '<div class="error-text">' + (data.error || 'Failed to generate link') + '</div>';
                    return;
                }

                const url = data.resetUrl;
                outEl.innerHTML =
                    '<div class="ok-text"><strong>Reset link generated:</strong></div>' +
                    '<div><a href="' + url + '" target="_blank" rel="noreferrer">' + url + '</a></div>' +
                    '<div class="note">Expires at: ' + data.expiresAt + '</div>';

                try {
                    await navigator.clipboard.writeText(url);
                    outEl.innerHTML += '<div class="note">Copied to clipboard.</div>';
                } catch (e) {
                    // clipboard may be blocked; ignore
                }
            } catch (err) {
                outEl.innerHTML = '<div class="error-text">Request failed.</div>';
            }
        }

        const btn = document.getElementById('generateResetBtn');
        if (btn) btn.addEventListener('click', generateResetLink);

        async function sendTestEmail() {
            const toEl = document.getElementById('testEmailTo');
            const outEl = document.getElementById('testEmailOutput');
            const to = (toEl.value || '').trim();
            outEl.textContent = '';

            if (!to) {
                outEl.innerHTML = '<div class="error-text">Recipient email is required.</div>';
                return;
            }

            try {
                const res = await fetch('/admin/test-email', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ to })
                });
                const data = await res.json();
                if (!res.ok) {
                    outEl.innerHTML = '<div class="error-text">' + (data.error || 'Failed') + '</div>';
                    return;
                }
                outEl.innerHTML = '<div class="ok-text">' + data.message + '</div>';
            } catch (err) {
                outEl.innerHTML = '<div class="error-text">Request failed.</div>';
            }
        }

        const testBtn = document.getElementById('sendTestEmailBtn');
        if (testBtn) testBtn.addEventListener('click', sendTestEmail);
    </script>

</body>
</html>
  `;
}

module.exports = router;
