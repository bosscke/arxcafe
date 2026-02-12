const express = require('express');
const stripeFactory = require('stripe');
const { requireAuth } = require('../middleware/auth');
const Subscription = require('../models/Subscription');

const router = express.Router();

let stripeClient = null;
function getStripeClient() {
  const apiKey = process.env.STRIPE_SECRET_KEY;
  if (!apiKey) return null;
  if (!stripeClient) stripeClient = stripeFactory(apiKey);
  return stripeClient;
}

function stripeNotConfigured(res) {
  res.status(503).json({ ok: false, error: 'Stripe is not configured on this service.' });
}

function getBaseUrl(req) {
  const xfProto = req.headers['x-forwarded-proto'];
  const proto = (Array.isArray(xfProto) ? xfProto[0] : xfProto) || req.protocol || 'http';
  return `${proto}://${req.get('host')}`;
}

function sanitizeInternalPath(value, fallback) {
  const p = String(value || '').trim();
  if (!p) return fallback;
  if (!p.startsWith('/') || p.startsWith('//') || p.includes('\\')) return fallback;
  return p;
}

// POST /api/billing/portal - create a Stripe customer portal session
router.post('/api/billing/portal', requireAuth, async (req, res) => {
  try {
    const stripe = getStripeClient();
    if (!stripe) return stripeNotConfigured(res);

    const sub = await Subscription.findOne({ user_id: req.user._id })
      .select({ stripe_customer_id: 1 })
      .lean();

    if (!sub?.stripe_customer_id) {
      return res.status(404).json({ ok: false, error: 'No subscription customer found for this account.' });
    }

    const returnUrl = `${getBaseUrl(req)}/profile.html`;
    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: returnUrl,
    });

    return res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error('[BillingPortal] Error:', err);
    return res.status(500).json({ ok: false, error: 'Failed to open billing portal' });
  }
});

// GET /paywall
router.get('/paywall', requireAuth, (req, res) => {
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
  if (!getStripeClient() || !publishableKey || publishableKey === 'your_stripe_publishable_key_here') {
    res.status(503).send(renderStripeDisabledPage());
    return;
  }
  const next = sanitizeInternalPath(req.query.next, '/analytics.html');
  try {
    void req.app.locals.trackEvent?.(req, 'paywall_view', { next });
  } catch (e) {
    // ignore
  }
  res.send(renderPaywallPage(req.user, next));
});

// POST /api/create-checkout-session
router.post('/api/create-checkout-session', requireAuth, async (req, res) => {
  try {
    const stripe = getStripeClient();
    if (!stripe || !process.env.STRIPE_PRICE_ID) return stripeNotConfigured(res);

    const next = sanitizeInternalPath(req.body?.next, '/analytics.html');
    try {
      void req.app.locals.trackEvent?.(req, 'checkout_session_create', { next });
    } catch (e) {
      // ignore
    }

    const session = await stripe.checkout.sessions.create({
      customer_email: req.user.email,
      payment_method_types: ['card'],
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID, // Set in .env
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: `${getBaseUrl(req)}/checkout-success?session_id={CHECKOUT_SESSION_ID}&next=${encodeURIComponent(next)}`,
      cancel_url: `${getBaseUrl(req)}/paywall?next=${encodeURIComponent(next)}`,
      metadata: {
        user_id: req.user._id.toString(),
        next
      }
    });

    res.json({ sessionId: session.id });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// GET /checkout-success
router.get('/checkout-success', requireAuth, async (req, res) => {
  const sessionId = req.query.session_id;
  const next = sanitizeInternalPath(req.query.next, '/analytics.html');

  if (!sessionId) {
    return res.redirect('/paywall?next=' + encodeURIComponent(next));
  }

  try {
    const stripe = getStripeClient();
    if (!stripe) {
      res.status(503).send(renderStripeDisabledPage());
      return;
    }

    // Retrieve the session to confirm payment
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status === 'paid') {
      try {
        void req.app.locals.trackEvent?.(req, 'checkout_success_paid', { next, sessionId });
      } catch (e) {
        // ignore
      }

      // Check if subscription already exists
      const existingSub = await Subscription.findOne({
        user_id: req.user._id,
        stripe_subscription_id: session.subscription
      });

      // Subscription will be created by webhook, but show success page anyway
      res.send(renderSuccessPage(true, next));
    } else {
      try {
        void req.app.locals.trackEvent?.(req, 'checkout_success_pending', { next, sessionId, payment_status: session.payment_status });
      } catch (e) {
        // ignore
      }
      res.send(renderSuccessPage(false, next));
    }
  } catch (err) {
    console.error('Checkout success error:', err);
    res.redirect('/paywall?next=' + encodeURIComponent(next));
  }
});

// POST /api/stripe-webhook
router.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const stripe = getStripeClient();
  if (!stripe) return stripeNotConfigured(res);

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) return stripeNotConfigured(res);

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(stripe, event.data.object);
        break;

      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Webhook handler: Checkout completed
async function handleCheckoutCompleted(stripe, session) {
  const userId = session.metadata.user_id;
  const subscriptionId = session.subscription;

  if (!userId || !subscriptionId) {
    console.error('Missing user_id or subscription in checkout session');
    return;
  }

  // Get subscription details from Stripe
  const stripeSubscription = await stripe.subscriptions.retrieve(subscriptionId);

  // Create or update subscription in database
  await Subscription.findOneAndUpdate(
    { stripe_subscription_id: subscriptionId },
    {
      user_id: userId,
      stripe_customer_id: stripeSubscription.customer,
      stripe_subscription_id: subscriptionId,
      status: stripeSubscription.status,
      current_period_end: new Date(stripeSubscription.current_period_end * 1000),
      updated_at: new Date()
    },
    { upsert: true, new: true }
  );

  console.log(`Subscription created for user ${userId}`);
}

// Webhook handler: Subscription updated
async function handleSubscriptionUpdated(subscription) {
  await Subscription.findOneAndUpdate(
    { stripe_subscription_id: subscription.id },
    {
      status: subscription.status,
      current_period_end: new Date(subscription.current_period_end * 1000),
      updated_at: new Date()
    }
  );

  console.log(`Subscription updated: ${subscription.id}`);
}

// Webhook handler: Subscription deleted
async function handleSubscriptionDeleted(subscription) {
  await Subscription.findOneAndUpdate(
    { stripe_subscription_id: subscription.id },
    {
      status: 'canceled',
      updated_at: new Date()
    }
  );

  console.log(`Subscription canceled: ${subscription.id}`);
}

// Helper: Render paywall page
function renderPaywallPage(user, next) {
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Upgrade to Premium - ArxCafe</title>
    <link rel="stylesheet" href="/css/global.css">
    <script src="https://js.stripe.com/v3/"></script>
    <style>
        .paywall-container {
            max-width: 600px;
            margin: 80px auto;
            padding: 40px;
        background: var(--color-surface);
            border-radius: 8px;
        box-shadow: var(--shadow-sm);
            text-align: center;
        }
        .paywall-container h1 {
            margin-bottom: 20px;
        color: var(--color-primary);
        }
        .price {
            font-size: 48px;
            font-weight: bold;
        color: var(--color-primary);
            margin: 30px 0;
        }
        .features {
            text-align: left;
            margin: 30px 0;
        }
        .features li {
            margin-bottom: 15px;
            font-size: 18px;
        }
        .btn-subscribe {
            padding: 16px 40px;
        border: 1px solid rgba(74, 52, 46, 0.35);
        background: linear-gradient(135deg, rgba(198, 169, 146, 0.95), rgba(74, 52, 46, 0.95));
            color: white;
            border-radius: 4px;
            font-size: 18px;
            font-weight: 600;
            cursor: pointer;
        }
        .btn-subscribe:hover {
        filter: brightness(0.96);
        }
    </style>
</head>
<body>
    <div class="paywall-container">
        <h1>Unlock Full Access</h1>
        <p>Get unlimited access to all professional certification quizzes with AI-powered explanations.</p>
        
        <div class="price">$19.99<span style="font-size: 20px;">/month</span></div>
        
        <ul class="features">
            <li>✅ Unlimited ML Engineer practice quizzes</li>
            <li>✅ AI-powered explanations for every question</li>
            <li>✅ Track your progress and scores</li>
            <li>✅ New content added regularly</li>
            <li>✅ Cancel anytime</li>
        </ul>
        
        <button id="checkout-button" class="btn-subscribe">Subscribe Now</button>
        
        <p style="margin-top: 20px; color: var(--color-secondary);">
            Logged in as ${user.email} | <a href="/logout">Logout</a>
        </p>
    </div>
    
    <script>
        const stripe = Stripe('${process.env.STRIPE_PUBLISHABLE_KEY}');
      const nextPath = ${JSON.stringify(next || '/analytics.html')};
        
        document.getElementById('checkout-button').addEventListener('click', async () => {
            try {
                const response = await fetch('/api/create-checkout-session', {
                    method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ next: nextPath })
                });
                
                const { sessionId } = await response.json();
                
                const { error } = await stripe.redirectToCheckout({ sessionId });
                
                if (error) {
                    alert('Payment failed: ' + error.message);
                }
            } catch (err) {
                alert('An error occurred. Please try again.');
            }
        });
    </script>
</body>
</html>
  `;
}

  function renderStripeDisabledPage() {
    return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Payments Unavailable - ArxCafe</title>
    <link rel="stylesheet" href="/css/global.css">
    <style>
      .container{max-width:760px;margin:80px auto;padding:24px;background:var(--color-surface);border-radius:8px;box-shadow:var(--shadow-sm);border:1px solid var(--border)}
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Payments are not configured</h1>
      <p>This environment does not have Stripe keys configured yet.</p>
      <p>If you expected payments to work, set <code>STRIPE_SECRET_KEY</code>, <code>STRIPE_PUBLISHABLE_KEY</code>, <code>STRIPE_PRICE_ID</code>, and <code>STRIPE_WEBHOOK_SECRET</code> in Cloud Run.</p>
      <p><a href="/">Back to home</a></p>
    </div>
  </body>
  </html>
  `;
  }

// Helper: Render success page
function renderSuccessPage(success, next) {
  if (success) {
    const nextSafe = sanitizeInternalPath(next, '/analytics.html');
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Payment Successful - ArxCafe</title>
    <link rel="stylesheet" href="/css/global.css">
    <style>
        .success-container {
            max-width: 600px;
            margin: 80px auto;
            padding: 40px;
        background: var(--color-surface);
            border-radius: 8px;
        box-shadow: var(--shadow-sm);
            text-align: center;
        }
        .success-icon {
            font-size: 64px;
        color: var(--color-primary);
            margin-bottom: 20px;
        }
        .btn-primary {
            padding: 14px 40px;
        border: 1px solid rgba(74, 52, 46, 0.35);
        background: linear-gradient(135deg, rgba(198, 169, 146, 0.95), rgba(74, 52, 46, 0.95));
            color: white;
            border-radius: 4px;
            font-size: 16px;
            font-weight: 600;
            text-decoration: none;
            display: inline-block;
            margin-top: 20px;
        }
      .btn-primary:hover { filter: brightness(0.96); }
    </style>
</head>
<body>
    <div class="success-container">
        <div class="success-icon">✓</div>
        <h1>Payment Successful!</h1>
        <p>Thank you for subscribing. You now have full access to all premium content.</p>
      <a href="${nextSafe}" class="btn-primary">Continue</a>
      <div style="margin-top: 10px;"><a href="/profile.html">Go to Profile</a></div>
    </div>
</body>
</html>
    `;
  } else {
    const nextSafe = sanitizeInternalPath(next, '/analytics.html');
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Payment Pending - ArxCafe</title>
    <link rel="stylesheet" href="/css/global.css">
</head>
<body>
    <div style="max-width: 600px; margin: 80px auto; padding: 40px; text-align: center;">
        <h1>Payment Pending</h1>
        <p>Your payment is being processed. Please check back in a few minutes.</p>
      <a href="${nextSafe}">Continue</a>
    </div>
</body>
</html>
    `;
  }
}

module.exports = router;
