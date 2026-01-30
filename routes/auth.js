const express = require('express');
const bcrypt = require('bcrypt');
const passport = require('../config/passport');
const User = require('../models/User');

const router = express.Router();

// GET /signup
router.get('/signup', (req, res) => {
  if (req.isAuthenticated()) {
    return res.redirect('/assessment.html');
  }
  res.send(renderSignupPage(req.query.error));
});

// POST /signup
router.post('/signup', async (req, res) => {
  try {
    const { email, password, password_confirm } = req.body;

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
      res.redirect('/assessment.html');
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
  res.send(renderLoginPage(req.query.error));
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
      const redirect = req.query.redirect || '/assessment.html';
      res.redirect(redirect);
    });
  })(req, res, next);
});

// GET /logout
router.get('/logout', (req, res) => {
  req.logout((err) => {
    if (err) {
      console.error('Logout error:', err);
    }
    res.redirect('/');
  });
});

// GET /reset-password
router.get('/reset-password', (req, res) => {
  res.send(renderResetPasswordPage());
});

// POST /reset-password
router.post('/reset-password', async (req, res) => {
  // TODO: Implement email-based password reset with tokens
  res.send('Password reset functionality coming soon. Please contact support.');
});

// Helper: Render signup page
function renderSignupPage(error) {
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
            margin: 80px auto;
            padding: 40px;
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .auth-container h1 {
            margin-bottom: 30px;
            text-align: center;
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
            border: 1px solid #ddd;
            border-radius: 4px;
            font-size: 16px;
        }
        .btn-primary {
            width: 100%;
            padding: 14px;
            background: #007bff;
            color: white;
            border: none;
            border-radius: 4px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
        }
        .btn-primary:hover {
            background: #0056b3;
        }
        .error-message {
            background: #f8d7da;
            color: #721c24;
            padding: 12px;
            border-radius: 4px;
            margin-bottom: 20px;
        }
        .auth-links {
            text-align: center;
            margin-top: 20px;
        }
        .auth-links a {
            color: #007bff;
            text-decoration: none;
        }
    </style>
</head>
<body>
    <div class="auth-container">
        <h1>Create Account</h1>
        ${error ? `<div class="error-message">${error}</div>` : ''}
        <form method="POST" action="/signup">
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
            Already have an account? <a href="/login">Log in</a>
        </div>
    </div>
</body>
</html>
  `;
}

// Helper: Render login page
function renderLoginPage(error) {
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
            margin: 80px auto;
            padding: 40px;
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .auth-container h1 {
            margin-bottom: 30px;
            text-align: center;
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
            border: 1px solid #ddd;
            border-radius: 4px;
            font-size: 16px;
        }
        .btn-primary {
            width: 100%;
            padding: 14px;
            background: #007bff;
            color: white;
            border: none;
            border-radius: 4px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
        }
        .btn-primary:hover {
            background: #0056b3;
        }
        .error-message {
            background: #f8d7da;
            color: #721c24;
            padding: 12px;
            border-radius: 4px;
            margin-bottom: 20px;
        }
        .auth-links {
            text-align: center;
            margin-top: 20px;
        }
        .auth-links a {
            color: #007bff;
            text-decoration: none;
        }
    </style>
</head>
<body>
    <div class="auth-container">
        <h1>Log In</h1>
        ${error ? `<div class="error-message">${error}</div>` : ''}
        <form method="POST" action="/login">
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
            Don't have an account? <a href="/signup">Sign up</a>
        </div>
    </div>
</body>
</html>
  `;
}

// Helper: Render reset password page
function renderResetPasswordPage() {
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
            margin: 80px auto;
            padding: 40px;
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .auth-container h1 {
            margin-bottom: 30px;
            text-align: center;
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
            border: 1px solid #ddd;
            border-radius: 4px;
            font-size: 16px;
        }
        .btn-primary {
            width: 100%;
            padding: 14px;
            background: #007bff;
            color: white;
            border: none;
            border-radius: 4px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
        }
        .btn-primary:hover {
            background: #0056b3;
        }
        .auth-links {
            text-align: center;
            margin-top: 20px;
        }
        .auth-links a {
            color: #007bff;
            text-decoration: none;
        }
    </style>
</head>
<body>
    <div class="auth-container">
        <h1>Reset Password</h1>
        <p style="text-align: center; margin-bottom: 20px;">Enter your email to receive reset instructions.</p>
        <form method="POST" action="/reset-password">
            <div class="form-group">
                <label for="email">Email</label>
                <input type="email" id="email" name="email" required>
            </div>
            <button type="submit" class="btn-primary">Send Reset Link</button>
        </form>
        <div class="auth-links">
            <a href="/login">Back to login</a>
        </div>
    </div>
</body>
</html>
  `;
}

module.exports = router;
