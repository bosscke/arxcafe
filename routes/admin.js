const express = require('express');
const bcrypt = require('bcrypt');
const { requireAdmin } = require('../middleware/auth');
const User = require('../models/User');
const Subscription = require('../models/Subscription');

const router = express.Router();

// GET /admin - Admin dashboard
router.get('/admin', requireAdmin, async (req, res) => {
  try {
    const users = await User.find().sort({ created_at: -1 }).limit(100);
    const subscriptions = await Subscription.find().populate('user_id').sort({ created_at: -1 }).limit(100);
    
    const stats = {
      totalUsers: await User.countDocuments(),
      totalSubscriptions: await Subscription.countDocuments({ status: 'active' }),
      revenue: await Subscription.countDocuments({ status: 'active' }) * 19.99
    };

    res.send(renderAdminDashboard(req.user, users, subscriptions, stats));
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

// Helper: Render admin dashboard
function renderAdminDashboard(admin, users, subscriptions, stats) {
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
            margin: 40px auto;
            padding: 20px;
        }
        .admin-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 40px;
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 20px;
            margin-bottom: 40px;
        }
        .stat-card {
            background: white;
            padding: 30px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            text-align: center;
        }
        .stat-value {
            font-size: 36px;
            font-weight: bold;
            color: #007bff;
        }
        .stat-label {
            font-size: 14px;
            color: #666;
            margin-top: 10px;
        }
        .section {
            background: white;
            padding: 30px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            margin-bottom: 30px;
        }
        .section h2 {
            margin-bottom: 20px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
        }
        th {
            background: #f8f9fa;
            padding: 12px;
            text-align: left;
            font-weight: 600;
        }
        td {
            padding: 12px;
            border-bottom: 1px solid #eee;
        }
        .badge {
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: 600;
        }
        .badge-active {
            background: #d4edda;
            color: #155724;
        }
        .badge-canceled {
            background: #f8d7da;
            color: #721c24;
        }
        .badge-admin {
            background: #fff3cd;
            color: #856404;
        }
        .form-inline {
            display: flex;
            gap: 10px;
            margin-top: 20px;
        }
        .form-inline input {
            padding: 8px;
            border: 1px solid #ddd;
            border-radius: 4px;
        }
        .btn {
            padding: 8px 16px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-weight: 600;
        }
        .btn-primary {
            background: #007bff;
            color: white;
        }
        .btn-danger {
            background: #dc3545;
            color: white;
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
            <table>
                <thead>
                    <tr>
                        <th>Email</th>
                        <th>Role</th>
                        <th>Created</th>
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
                                ${u.role !== 'admin' ? `<button class="btn btn-danger" onclick="revokeAccess('${u.email}')">Revoke</button>` : ''}
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>

        <div class="section">
            <h2>Active Subscriptions</h2>
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
    </script>
</body>
</html>
  `;
}

module.exports = router;
