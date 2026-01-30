const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { requireAuth } = require('../middleware/auth');
const Subscription = require('../models/Subscription');

const router = express.Router();

// GET /paywall
router.get('/paywall', requireAuth, (req, res) => {
  res.send(renderPaywallPage(req.user));
});

// POST /api/create-checkout-session
router.post('/api/create-checkout-session', requireAuth, async (req, res) => {
  try {
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
      success_url: `${req.protocol}://${req.get('host')}/checkout-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.protocol}://${req.get('host')}/paywall`,
      metadata: {
        user_id: req.user._id.toString()
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

  if (!sessionId) {
    return res.redirect('/paywall');
  }

  try {
    // Retrieve the session to confirm payment
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status === 'paid') {
      // Check if subscription already exists
      const existingSub = await Subscription.findOne({
        user_id: req.user._id,
        stripe_subscription_id: session.subscription
      });

      if (!existingSub) {
        // Subscription will be created by webhook, but show success page anyway
        res.send(renderSuccessPage(true));
      } else {
        res.send(renderSuccessPage(true));
      }
    } else {
      res.send(renderSuccessPage(false));
    }
  } catch (err) {
    console.error('Checkout success error:', err);
    res.redirect('/paywall');
  }
});

// POST /api/stripe-webhook
router.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

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
        await handleCheckoutCompleted(event.data.object);
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
async function handleCheckoutCompleted(session) {
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
function renderPaywallPage(user) {
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
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            text-align: center;
        }
        .paywall-container h1 {
            margin-bottom: 20px;
        }
        .price {
            font-size: 48px;
            font-weight: bold;
            color: #007bff;
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
            background: #007bff;
            color: white;
            border: none;
            border-radius: 4px;
            font-size: 18px;
            font-weight: 600;
            cursor: pointer;
        }
        .btn-subscribe:hover {
            background: #0056b3;
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
        
        <p style="margin-top: 20px; color: #666;">
            Logged in as ${user.email} | <a href="/logout">Logout</a>
        </p>
    </div>
    
    <script>
        const stripe = Stripe('${process.env.STRIPE_PUBLISHABLE_KEY}');
        
        document.getElementById('checkout-button').addEventListener('click', async () => {
            try {
                const response = await fetch('/api/create-checkout-session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
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

// Helper: Render success page
function renderSuccessPage(success) {
  if (success) {
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
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            text-align: center;
        }
        .success-icon {
            font-size: 64px;
            color: #28a745;
            margin-bottom: 20px;
        }
        .btn-primary {
            padding: 14px 40px;
            background: #007bff;
            color: white;
            border: none;
            border-radius: 4px;
            font-size: 16px;
            font-weight: 600;
            text-decoration: none;
            display: inline-block;
            margin-top: 20px;
        }
    </style>
</head>
<body>
    <div class="success-container">
        <div class="success-icon">✓</div>
        <h1>Payment Successful!</h1>
        <p>Thank you for subscribing. You now have full access to all premium content.</p>
        <a href="/assessment.html" class="btn-primary">Start Learning</a>
    </div>
</body>
</html>
    `;
  } else {
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
        <a href="/assessment.html">Return to Assessment</a>
    </div>
</body>
</html>
    `;
  }
}

module.exports = router;
