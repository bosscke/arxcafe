const Subscription = require('../models/Subscription');

// Middleware: Check if user is authenticated
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
}

// Middleware: Check if user has paid subscription
async function requirePaid(req, res, next) {
  if (!req.isAuthenticated()) {
    return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
  }

  // Admin always has access
  if (req.user.role === 'admin') {
    return next();
  }

  try {
    const subscription = await Subscription.findOne({
      user_id: req.user._id,
      status: { $in: ['active', 'trialing'] },
      current_period_end: { $gt: new Date() }
    });

    if (subscription) {
      return next();
    }

    // No active subscription - redirect to paywall and preserve intent
    res.redirect('/paywall?next=' + encodeURIComponent(req.originalUrl));
  } catch (err) {
    console.error('Error checking subscription:', err);
    res.redirect('/paywall?next=' + encodeURIComponent(req.originalUrl));
  }
}

// Middleware: Check if user is admin
function requireAdmin(req, res, next) {
  if (req.isAuthenticated() && req.user.role === 'admin') {
    return next();
  }
  res.status(403).send('Access denied. Admin privileges required.');
}

// Helper: Check if user has active subscription (for use in templates)
async function hasActiveSubscription(userId) {
  try {
    const subscription = await Subscription.findOne({
      user_id: userId,
      status: { $in: ['active', 'trialing'] },
      current_period_end: { $gt: new Date() }
    });
    return !!subscription;
  } catch (err) {
    return false;
  }
}

module.exports = {
  requireAuth,
  requirePaid,
  requireAdmin,
  hasActiveSubscription
};
