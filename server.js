// Load environment variables from .env file
require('dotenv').config();

process.on('unhandledRejection', (reason) => {
    console.error('[Process] Unhandled rejection:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('[Process] Uncaught exception:', err);
});

const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo').MongoStore;
const passport = require('./config/passport');
const { MongoClient } = require('mongodb');
const googleTrends = require('google-trends-api');
const { handleAiExplain } = require('./routes/aiExplain');

// Import routes
const authRoutes = require('./routes/auth');
const paymentRoutes = require('./routes/payment');
const adminRoutes = require('./routes/admin');
const quizRoutes = require('./routes/quiz');
const { requirePaid, requireAuth, hasActiveSubscription } = require('./middleware/auth');
const QuizAttempt = require('./models/QuizAttempt');
const User = require('./models/User');

// Initialize Express app
const app = express();

let appConfigured = false;
let appConfiguredSkipDb = null;

// Cloud Run/Ingress: trust the first proxy so secure cookies work behind HTTPS
if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
}

////////////////////////////////////////////
///// Server ARXCAFE

const trendKeywords = [
    'AWS Certified Solutions Architect – Associate',
    'Microsoft Azure Fundamentals (AZ-900)',
    'Google Professional Cloud Architect',
    'Certified Kubernetes Administrator (CKA)',
    'CompTIA Security+'
];

const fallbackTrends = trendKeywords.map(name => ({ name, score: 0 }));
let trendsCache = { updated: 0, items: fallbackTrends };

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const LOOKBACK_DAYS = 30;

const averageFromTimeline = (json) => {
    try {
        const parsed = JSON.parse(json);
        const points = parsed?.default?.timelineData || [];
        if (!points.length) return 0;
        const sum = points.reduce((s, p) => s + (p.value?.[0] || 0), 0);
        return sum / points.length;
    } catch (e) {
        return 0;
    }
};

const refreshTrends = async () => {
    const startTime = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const results = await Promise.all(trendKeywords.map(async (keyword) => {
        const res = await googleTrends.interestOverTime({ keyword, startTime });
        return { name: keyword, score: averageFromTimeline(res) };
    }));
    const sorted = results.sort((a, b) => b.score - a.score).slice(0, 5);
    trendsCache = { updated: Date.now(), items: sorted };
    return trendsCache;
};

const getTrends = async () => {
    if (Date.now() - trendsCache.updated > CACHE_TTL_MS) {
        try {
            await refreshTrends();
        } catch (err) {
            // keep cached data on failure
        }
    }
    return trendsCache;
};

const serveStaticFile = (filePath, res) => {
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, {'Content-Type': 'text/plain'});
            res.end('Not found');
            return;
        }
        const ext = path.extname(filePath);
        const mimeTypes = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.gif': 'image/gif',
            '.svg': 'image/svg+xml',
            '.css': 'text/css',
            '.js': 'application/javascript'
        };
        const contentType = mimeTypes[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' });
        res.end(data);
    });
};

// MongoDB connection (switches between dev and production)
const mongoUri = process.env.NODE_ENV === 'production' 
    ? process.env.MONGO_PROD_URI 
    : (process.env.MONGO_DEV_URI || 'mongodb://127.0.0.1:27017/arxcafe');

function configureApp(options = {}) {
    const { skipDb = false } = options;

    if (appConfigured) {
        if (appConfiguredSkipDb !== skipDb) {
            console.warn('[App] configureApp called again with different skipDb; ignoring subsequent call');
        }
        return app;
    }

    appConfigured = true;
    appConfiguredSkipDb = skipDb;

    // Express middleware configuration
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // Session configuration
    const sessionOptions = {
        secret: process.env.SESSION_SECRET || 'arxcafe-secret-key-change-in-production',
        resave: false,
        saveUninitialized: false,
        cookie: {
            maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production'
        }
    };

    if (skipDb) {
        // Tooling/tests: avoid opening Mongo connections at import time.
        sessionOptions.store = new session.MemoryStore();
    } else {
        const sessionMongoClientPromise = MongoClient.connect(mongoUri, {
            serverSelectionTimeoutMS: 15000,
            connectTimeoutMS: 15000,
        });

        // Ensure connection failures never become an unhandled rejection that crashes the process.
        sessionMongoClientPromise.catch((err) => {
            console.error('[SessionStore] MongoClient connect failed:', err?.message || err);
        });

        const sessionStore = MongoStore.create({
            clientPromise: sessionMongoClientPromise,
            touchAfter: 24 * 3600 // lazy session update
        });

        sessionStore.on('error', (err) => {
            console.error('[SessionStore] MongoStore error:', err?.message || err);
        });

        sessionOptions.store = sessionStore;
    }

    app.use(session(sessionOptions));

    // Passport authentication
    app.use(passport.initialize());
    app.use(passport.session());

    // Make user available in all responses
    app.use((req, res, next) => {
        res.locals.user = req.user || null;
        next();
    });

    // Phase 4: basic acquisition attribution (UTM + referrer capture)
    // Stored in session to help analyze funnels without adding client SDKs.
    app.use((req, res, next) => {
        try {
            if (!req.session) return next();

            const utmKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
            const utm = {};
            for (const k of utmKeys) {
                const v = req.query?.[k];
                if (typeof v === 'string' && v.trim()) utm[k] = v.trim();
            }

            const ref = (req.query?.ref && typeof req.query.ref === 'string') ? req.query.ref.trim() : '';
            const referer = (req.get('referer') || '').trim();

            if (Object.keys(utm).length) {
                if (!req.session.utm_first) req.session.utm_first = utm;
                req.session.utm_last = utm;
            }
            if (ref) {
                if (!req.session.ref_first) req.session.ref_first = ref;
                req.session.ref_last = ref;
            }
            if (referer) {
                if (!req.session.referer_first) req.session.referer_first = referer;
                req.session.referer_last = referer;
            }
        } catch (e) {
            // ignore
        }
        next();
    });

    // Phase 4: funnel event logging (server-side)
    app.locals.trackEvent = async (req, name, props = {}) => {
        try {
            if (skipDb) return;

            const db = await ensureMongoDb(1500);
            if (!db) return;

            const doc = {
                name: String(name || '').slice(0, 80),
                at: new Date(),
                path: req?.originalUrl || req?.url || null,
                method: req?.method || null,
                user_id: req?.user?._id ? String(req.user._id) : null,
                authed: typeof req?.isAuthenticated === 'function' ? !!req.isAuthenticated() : false,
                ua: req?.headers?.['user-agent'] || null,
                utm_first: req?.session?.utm_first || null,
                utm_last: req?.session?.utm_last || null,
                ref_first: req?.session?.ref_first || null,
                ref_last: req?.session?.ref_last || null,
                referer_first: req?.session?.referer_first || null,
                referer_last: req?.session?.referer_last || null,
                props: props && typeof props === 'object' ? props : { value: props }
            };

            await db.collection('funnel_events').insertOne(doc);
        } catch (e) {
            // best-effort; never break the request
        }
    };

    // Mount auth routes
    app.use('/', authRoutes);
    app.use('/', paymentRoutes);
    app.use('/', adminRoutes);
    app.use('/', quizRoutes);

    // Who-am-I endpoint for client-side UI toggles (e.g., admin link visibility)
    app.get('/api/me', (req, res) => {
        const authed = typeof req.isAuthenticated === 'function' && req.isAuthenticated();
        if (!authed) {
            return res.json({ authenticated: false });
        }
        return res.json({
            authenticated: true,
            email: req.user?.email || null,
            role: req.user?.role || null,
            onboardingCompleted: !!req.user?.onboarding_completed_at,
            onboardingCompletedAt: req.user?.onboarding_completed_at || null
        });
    });

    // Mark onboarding complete (auth only)
    app.post('/api/onboarding/complete', requireAuth, async (req, res) => {
        try {
            if (skipDb) {
                return res.json({ ok: true, completedAt: null });
            }

            const userId = req.user?._id;
            if (!userId) return res.status(401).json({ ok: false, error: 'Not authenticated' });

            const now = new Date();
            await User.updateOne(
                { _id: userId, onboarding_completed_at: null },
                { $set: { onboarding_completed_at: now } }
            );

            // best-effort funnel signal
            try {
                void req.app.locals.trackEvent?.(req, 'onboarding_complete', { completedAt: now.toISOString() });
            } catch (e) {
                // ignore
            }

            return res.json({ ok: true, completedAt: now });
        } catch (err) {
            console.error('[Onboarding] Complete error:', err);
            return res.status(500).json({ ok: false, error: 'Failed to mark onboarding complete' });
        }
    });

    // Access endpoint for client-side paywall/locked UI
    app.get('/api/access', async (req, res) => {
        const authed = typeof req.isAuthenticated === 'function' && req.isAuthenticated();
        if (!authed) {
            return res.json({ authenticated: false, paid: false, role: null });
        }

        const role = req.user?.role || null;
        if (role === 'admin') {
            return res.json({ authenticated: true, paid: true, role });
        }

        if (skipDb) {
            return res.json({ authenticated: true, paid: false, role });
        }

        const paid = await hasActiveSubscription(req.user?._id);
        return res.json({ authenticated: true, paid: !!paid, role });
    });

    // Progress endpoint for the dashboard
    app.get('/api/quiz/progress', requireAuth, async (req, res) => {
        try {
            if (skipDb) {
                return res.json({ ok: true, attempts: 0, bestPercentage: null, lastPercentage: null, lastAt: null });
            }

            const userId = req.user?._id;
            if (!userId) return res.status(401).json({ ok: false, error: 'Not authenticated' });

            const [count, best, last] = await Promise.all([
                QuizAttempt.countDocuments({ user_id: userId }),
                QuizAttempt.findOne({ user_id: userId }).sort({ percentage: -1, created_at: -1 }).select({ percentage: 1, created_at: 1 }).lean(),
                QuizAttempt.findOne({ user_id: userId }).sort({ created_at: -1 }).select({ percentage: 1, created_at: 1 }).lean(),
            ]);

            return res.json({
                ok: true,
                attempts: count,
                bestPercentage: best?.percentage ?? null,
                lastPercentage: last?.percentage ?? null,
                lastAt: last?.created_at ?? null,
            });
        } catch (err) {
            console.error('[QuizProgress] Error:', err);
            return res.status(500).json({ ok: false, error: 'Failed to load progress' });
        }
    });

    // Streak endpoint (retention)
    app.get('/api/quiz/streak', requireAuth, async (req, res) => {
        try {
            if (skipDb) {
                return res.json({ ok: true, currentStreak: 0, longestStreak: 0, lastAttemptAt: null });
            }

            const userId = req.user?._id;
            if (!userId) return res.status(401).json({ ok: false, error: 'Not authenticated' });

            const since = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
            const attempts = await QuizAttempt.find({ user_id: userId, created_at: { $gte: since } })
                .sort({ created_at: -1 })
                .limit(500)
                .select({ created_at: 1 })
                .lean();

            const lastAttemptAt = attempts[0]?.created_at ?? null;

            const daySet = new Set(
                attempts
                    .map((a) => a?.created_at)
                    .filter(Boolean)
                    .map((d) => new Date(d).toISOString().slice(0, 10))
            );

            const toUtcMidnight = (d) => {
                const x = new Date(d);
                x.setUTCHours(0, 0, 0, 0);
                return x;
            };

            const dayKey = (d) => toUtcMidnight(d).toISOString().slice(0, 10);

            let cursor = toUtcMidnight(new Date());
            if (!daySet.has(dayKey(cursor))) {
                cursor.setUTCDate(cursor.getUTCDate() - 1);
                if (!daySet.has(dayKey(cursor))) {
                    return res.json({ ok: true, currentStreak: 0, longestStreak: 0, lastAttemptAt });
                }
            }

            let currentStreak = 0;
            while (daySet.has(dayKey(cursor))) {
                currentStreak += 1;
                cursor.setUTCDate(cursor.getUTCDate() - 1);
            }

            const sortedDays = Array.from(daySet).sort();
            let longestStreak = 0;
            let run = 0;
            let prev = null;
            for (const d of sortedDays) {
                const dt = new Date(d + 'T00:00:00Z');
                if (prev) {
                    const diffDays = Math.round((dt.getTime() - prev.getTime()) / (24 * 60 * 60 * 1000));
                    run = diffDays === 1 ? run + 1 : 1;
                } else {
                    run = 1;
                }
                longestStreak = Math.max(longestStreak, run);
                prev = dt;
            }

            return res.json({ ok: true, currentStreak, longestStreak, lastAttemptAt });
        } catch (err) {
            console.error('[QuizStreak] Error:', err);
            return res.status(500).json({ ok: false, error: 'Failed to load streak' });
        }
    });

    // AI Explain endpoint - Express route
    app.post('/api/ai/explain', async (req, res) => {
        try {
            console.log('[AI Explain] Request received:', req.body.question_id);
            console.log('[AI Explain] GEMINI_API_KEY exists:', !!process.env.GEMINI_API_KEY);
            await handleAiExplain(req, res, mongoDb);
        } catch (err) {
            console.error('[AI Explain] Error:', err.message);
            console.error('[AI Explain] Stack:', err.stack);
            res.status(400).json({ ok: false, error: 'Error: ' + err.message });
        }
    });

    // Protect assessment and quiz routes
    // Assessment dashboard is visible for authenticated users; it teases locked content.
    app.get(['/assesment', '/assesment.html', '/assessment', '/assessment.html'], requireAuth, (req, res) => {
        return res.sendFile(path.join(__dirname, 'assesment.html'));
    });

    // Quiz should work for any logged-in user; keep paid-only gating for analytics.
    app.get(['/ml-engineer-quiz', '/ml-engineer-quiz.html'], requireAuth, (req, res) => {
        return res.sendFile(path.join(__dirname, 'ml-engineer-quiz.html'));
    });

    // IT Learning Pyramid quiz (auth only)
    app.get(['/it-learning-pyramid', '/it-learning-pyramid.html'], requireAuth, (req, res) => {
        return res.sendFile(path.join(__dirname, 'it-learning-pyramid.html'));
    });

    // Phase 4: paid-only analytics page
    app.use('/analytics.html', requirePaid);
    app.get('/analytics.html', requirePaid, (req, res) => {
        res.sendFile(path.join(__dirname, 'analytics.html'));
    });

    // Profile page (auth only)
    app.use('/profile.html', requireAuth);
    app.get('/profile', requireAuth, (req, res) => res.redirect('/profile.html'));
    app.get('/profile.html', requireAuth, (req, res) => {
        res.sendFile(path.join(__dirname, 'profile.html'));
    });

    const sanitizeRedirectPath = (value, fallback) => {
        const p = String(value || '').trim();
        if (!p) return fallback;
        // Only allow internal paths
        if (!p.startsWith('/') || p.startsWith('//') || p.includes('\\')) return fallback;
        return p;
    };

    // Phase 4: onboarding funnel
    app.get('/start', (req, res) => {
        const authed = typeof req.isAuthenticated === 'function' && req.isAuthenticated();
        const defaultTarget = authed && req.user?.onboarding_completed_at ? '/profile.html' : '/onboarding.html';
        const target = sanitizeRedirectPath(req.query.redirect, defaultTarget);
        try {
            void req.app.locals.trackEvent?.(req, 'start_hit', { authed, target });
        } catch (e) {
            // ignore
        }
        if (authed) return res.redirect(target);
        return res.redirect('/signup?redirect=' + encodeURIComponent(target));
    });

    // Onboarding page (auth only)
    app.use('/onboarding.html', requireAuth);
    app.get('/onboarding.html', requireAuth, (req, res) => {
        res.sendFile(path.join(__dirname, 'onboarding.html'));
    });

    // ML Engineering (concept-graph pages)
    const sendMlPage = (relativePath) => (req, res) => {
        res.set('Cache-Control', 'no-store');
        return res.sendFile(path.join(__dirname, relativePath));
    };

    app.get(['/ml-engineering', '/ml-engineering/', '/ml-engineering/index', '/ml-engineering/index.html'], sendMlPage('ml-engineering/index.html'));
    app.get(['/ml-engineering/layer-0', '/ml-engineering/layer-0/', '/ml-engineering/layer-0/index', '/ml-engineering/layer-0/index.html'], sendMlPage('ml-engineering/layer-0/index.html'));
    app.get([
        '/ml-engineering/layer-0/part-1-learning',
        '/ml-engineering/layer-0/part-1-learning/',
        '/ml-engineering/layer-0/part-1-learning/index',
        '/ml-engineering/layer-0/part-1-learning/index.html'
    ], sendMlPage('ml-engineering/layer-0/part-1-learning/index.html'));

    app.get([
        '/ml-engineering/layer-0/part-1-learning/expected-loss-minimization',
        '/ml-engineering/layer-0/part-1-learning/expected-loss-minimization.html'
    ], sendMlPage('ml-engineering/layer-0/part-1-learning/expected-loss-minimization.html'));
    app.get([
        '/ml-engineering/layer-0/part-1-learning/empirical-risk',
        '/ml-engineering/layer-0/part-1-learning/empirical-risk.html'
    ], sendMlPage('ml-engineering/layer-0/part-1-learning/empirical-risk.html'));
    app.get([
        '/ml-engineering/layer-0/part-1-learning/generalization-gap',
        '/ml-engineering/layer-0/part-1-learning/generalization-gap.html'
    ], sendMlPage('ml-engineering/layer-0/part-1-learning/generalization-gap.html'));

    app.get([
        '/ml-engineering/layer-0/part-1-learning/distribution-gap',
        '/ml-engineering/layer-0/part-1-learning/distribution-gap.html'
    ], sendMlPage('ml-engineering/layer-0/part-1-learning/distribution-gap.html'));

    app.get([
        '/ml-engineering/layer-0/part-1-learning/training-is-optimization',
        '/ml-engineering/layer-0/part-1-learning/training-is-optimization.html'
    ], sendMlPage('ml-engineering/layer-0/part-1-learning/training-is-optimization.html'));

    app.get([
        '/ml-engineering/layer-0/part-1-learning/scalars-vectors-feature-spaces',
        '/ml-engineering/layer-0/part-1-learning/scalars-vectors-feature-spaces.html'
    ], sendMlPage('ml-engineering/layer-0/part-1-learning/scalars-vectors-feature-spaces.html'));

    // Layer 1 (placeholder)
    app.get([
        '/ml-engineering/layer-1',
        '/ml-engineering/layer-1/',
        '/ml-engineering/layer-1/index',
        '/ml-engineering/layer-1/index.html'
    ], sendMlPage('ml-engineering/layer-1/index.html'));

    // Layer 0 · Part 2 — Linear Algebra
    app.get([
        '/ml-engineering/layer-0/part-2-linear-algebra',
        '/ml-engineering/layer-0/part-2-linear-algebra/',
        '/ml-engineering/layer-0/part-2-linear-algebra/index',
        '/ml-engineering/layer-0/part-2-linear-algebra/index.html'
    ], sendMlPage('ml-engineering/layer-0/part-2-linear-algebra/index.html'));

    app.get([
        '/ml-engineering/layer-0/part-2-linear-algebra/scalars-vectors-feature-spaces',
        '/ml-engineering/layer-0/part-2-linear-algebra/scalars-vectors-feature-spaces.html'
    ], sendMlPage('ml-engineering/layer-0/part-2-linear-algebra/scalars-vectors-feature-spaces.html'));
    app.get([
        '/ml-engineering/layer-0/part-2-linear-algebra/datasets-as-matrices',
        '/ml-engineering/layer-0/part-2-linear-algebra/datasets-as-matrices.html'
    ], sendMlPage('ml-engineering/layer-0/part-2-linear-algebra/datasets-as-matrices.html'));
    app.get([
        '/ml-engineering/layer-0/part-2-linear-algebra/dot-products-similarity',
        '/ml-engineering/layer-0/part-2-linear-algebra/dot-products-similarity.html'
    ], sendMlPage('ml-engineering/layer-0/part-2-linear-algebra/dot-products-similarity.html'));
    app.get([
        '/ml-engineering/layer-0/part-2-linear-algebra/norms-distances',
        '/ml-engineering/layer-0/part-2-linear-algebra/norms-distances.html'
    ], sendMlPage('ml-engineering/layer-0/part-2-linear-algebra/norms-distances.html'));
    app.get([
        '/ml-engineering/layer-0/part-2-linear-algebra/linear-transformations',
        '/ml-engineering/layer-0/part-2-linear-algebra/linear-transformations.html'
    ], sendMlPage('ml-engineering/layer-0/part-2-linear-algebra/linear-transformations.html'));
    app.get([
        '/ml-engineering/layer-0/part-2-linear-algebra/eigenvalues-pca',
        '/ml-engineering/layer-0/part-2-linear-algebra/eigenvalues-pca.html'
    ], sendMlPage('ml-engineering/layer-0/part-2-linear-algebra/eigenvalues-pca.html'));

    // Layer 0 · Part 3 — Probability
    app.get([
        '/ml-engineering/layer-0/part-3-probability',
        '/ml-engineering/layer-0/part-3-probability/',
        '/ml-engineering/layer-0/part-3-probability/index',
        '/ml-engineering/layer-0/part-3-probability/index.html'
    ], sendMlPage('ml-engineering/layer-0/part-3-probability/index.html'));
    app.get([
        '/ml-engineering/layer-0/part-3-probability/random-variables-distributions',
        '/ml-engineering/layer-0/part-3-probability/random-variables-distributions.html'
    ], sendMlPage('ml-engineering/layer-0/part-3-probability/random-variables-distributions.html'));
    app.get([
        '/ml-engineering/layer-0/part-3-probability/expectation-variance',
        '/ml-engineering/layer-0/part-3-probability/expectation-variance.html'
    ], sendMlPage('ml-engineering/layer-0/part-3-probability/expectation-variance.html'));
    app.get([
        '/ml-engineering/layer-0/part-3-probability/conditional-probability-bayes',
        '/ml-engineering/layer-0/part-3-probability/conditional-probability-bayes.html'
    ], sendMlPage('ml-engineering/layer-0/part-3-probability/conditional-probability-bayes.html'));
    app.get([
        '/ml-engineering/layer-0/part-3-probability/independence-correlation',
        '/ml-engineering/layer-0/part-3-probability/independence-correlation.html'
    ], sendMlPage('ml-engineering/layer-0/part-3-probability/independence-correlation.html'));
    app.get([
        '/ml-engineering/layer-0/part-3-probability/sampling-lln-clt',
        '/ml-engineering/layer-0/part-3-probability/sampling-lln-clt.html'
    ], sendMlPage('ml-engineering/layer-0/part-3-probability/sampling-lln-clt.html'));

    // Layer 0 · Part 4 — Statistics
    app.get([
        '/ml-engineering/layer-0/part-4-statistics',
        '/ml-engineering/layer-0/part-4-statistics/',
        '/ml-engineering/layer-0/part-4-statistics/index',
        '/ml-engineering/layer-0/part-4-statistics/index.html'
    ], sendMlPage('ml-engineering/layer-0/part-4-statistics/index.html'));
    app.get([
        '/ml-engineering/layer-0/part-4-statistics/estimators-bias-variance',
        '/ml-engineering/layer-0/part-4-statistics/estimators-bias-variance.html'
    ], sendMlPage('ml-engineering/layer-0/part-4-statistics/estimators-bias-variance.html'));
    app.get([
        '/ml-engineering/layer-0/part-4-statistics/confidence-intervals',
        '/ml-engineering/layer-0/part-4-statistics/confidence-intervals.html'
    ], sendMlPage('ml-engineering/layer-0/part-4-statistics/confidence-intervals.html'));
    app.get([
        '/ml-engineering/layer-0/part-4-statistics/hypothesis-testing',
        '/ml-engineering/layer-0/part-4-statistics/hypothesis-testing.html'
    ], sendMlPage('ml-engineering/layer-0/part-4-statistics/hypothesis-testing.html'));
    app.get([
        '/ml-engineering/layer-0/part-4-statistics/p-values-power',
        '/ml-engineering/layer-0/part-4-statistics/p-values-power.html'
    ], sendMlPage('ml-engineering/layer-0/part-4-statistics/p-values-power.html'));
    app.get([
        '/ml-engineering/layer-0/part-4-statistics/overfitting-as-multiple-comparisons',
        '/ml-engineering/layer-0/part-4-statistics/overfitting-as-multiple-comparisons.html'
    ], sendMlPage('ml-engineering/layer-0/part-4-statistics/overfitting-as-multiple-comparisons.html'));

    // Layer 0 · Part 5 — Optimization
    app.get([
        '/ml-engineering/layer-0/part-5-optimization',
        '/ml-engineering/layer-0/part-5-optimization/',
        '/ml-engineering/layer-0/part-5-optimization/index',
        '/ml-engineering/layer-0/part-5-optimization/index.html'
    ], sendMlPage('ml-engineering/layer-0/part-5-optimization/index.html'));
    app.get([
        '/ml-engineering/layer-0/part-5-optimization/gradients-and-partial-derivatives',
        '/ml-engineering/layer-0/part-5-optimization/gradients-and-partial-derivatives.html'
    ], sendMlPage('ml-engineering/layer-0/part-5-optimization/gradients-and-partial-derivatives.html'));
    app.get([
        '/ml-engineering/layer-0/part-5-optimization/gradient-descent',
        '/ml-engineering/layer-0/part-5-optimization/gradient-descent.html'
    ], sendMlPage('ml-engineering/layer-0/part-5-optimization/gradient-descent.html'));
    app.get([
        '/ml-engineering/layer-0/part-5-optimization/learning-rate',
        '/ml-engineering/layer-0/part-5-optimization/learning-rate.html'
    ], sendMlPage('ml-engineering/layer-0/part-5-optimization/learning-rate.html'));
    app.get([
        '/ml-engineering/layer-0/part-5-optimization/convexity-local-minima',
        '/ml-engineering/layer-0/part-5-optimization/convexity-local-minima.html'
    ], sendMlPage('ml-engineering/layer-0/part-5-optimization/convexity-local-minima.html'));
    app.get([
        '/ml-engineering/layer-0/part-5-optimization/regularization-as-optimization',
        '/ml-engineering/layer-0/part-5-optimization/regularization-as-optimization.html'
    ], sendMlPage('ml-engineering/layer-0/part-5-optimization/regularization-as-optimization.html'));

    // Layer 0 · Part 6 — Metrics
    app.get([
        '/ml-engineering/layer-0/part-6-metrics',
        '/ml-engineering/layer-0/part-6-metrics/',
        '/ml-engineering/layer-0/part-6-metrics/index',
        '/ml-engineering/layer-0/part-6-metrics/index.html'
    ], sendMlPage('ml-engineering/layer-0/part-6-metrics/index.html'));
    app.get([
        '/ml-engineering/layer-0/part-6-metrics/confusion-matrix',
        '/ml-engineering/layer-0/part-6-metrics/confusion-matrix.html'
    ], sendMlPage('ml-engineering/layer-0/part-6-metrics/confusion-matrix.html'));
    app.get([
        '/ml-engineering/layer-0/part-6-metrics/precision-recall-f1',
        '/ml-engineering/layer-0/part-6-metrics/precision-recall-f1.html'
    ], sendMlPage('ml-engineering/layer-0/part-6-metrics/precision-recall-f1.html'));
    app.get([
        '/ml-engineering/layer-0/part-6-metrics/roc-auc',
        '/ml-engineering/layer-0/part-6-metrics/roc-auc.html'
    ], sendMlPage('ml-engineering/layer-0/part-6-metrics/roc-auc.html'));
    app.get([
        '/ml-engineering/layer-0/part-6-metrics/calibration',
        '/ml-engineering/layer-0/part-6-metrics/calibration.html'
    ], sendMlPage('ml-engineering/layer-0/part-6-metrics/calibration.html'));
    app.get([
        '/ml-engineering/layer-0/part-6-metrics/thresholds-costs',
        '/ml-engineering/layer-0/part-6-metrics/thresholds-costs.html'
    ], sendMlPage('ml-engineering/layer-0/part-6-metrics/thresholds-costs.html'));

    // Legacy request handler (will be converted to Express routes)
    app.use((req, res, next) => {
        const pathName = req.url.split('?')[0];

        if (pathName === '/trends.json') {
            getTrends()
                .then((data) => {
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' });
                    res.end(JSON.stringify({ items: data.items }));
                })
                .catch(() => {
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' });
                    res.end(JSON.stringify({ items: trendsCache.items }));
                });
            return;
        }

        // Simple JSON search endpoint for ML topics (legacy)
        if (pathName === '/ml-topics.json') {
            (async () => {
                try {
                    if (!mongoDb) {
                        res.writeHead(503, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ items: [], error: 'ML topics search is not available (no database connection).' }));
                        return;
                    }

                    const url = new URL(req.url, 'http://localhost');
                    const q = (url.searchParams.get('q') || '').trim();

                    const coll = mongoDb.collection(ML_TOPICS_COLLECTION);
                    const filter = q
                        ? { text: { $regex: q, $options: 'i' } }
                        : {};

                    const docs = await coll
                        .find(filter)
                        .sort({ sectionOrder: 1, order: 1 })
                        .limit(50)
                        .toArray();

                    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' });
                    res.end(JSON.stringify({ items: docs }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ items: [], error: err.message }));
                }
            })();
            return;
        }

        // Continue into the existing legacy handler chain
        return next();
    });

    return app;
}

let mongoClient;
let mongoDb;

let mongoClientConnecting = false;

const backoffDelayMs = (attempt) => {
    const base = 2000;
    const max = 60000;
    const delay = base * Math.pow(2, Math.min(attempt, 5));
    return Math.min(delay, max);
};

async function connectMongo(attempt = 0) {
    if (mongoClientConnecting) return;
    mongoClientConnecting = true;
    try {
        mongoClient = new MongoClient(mongoUri, {
            serverSelectionTimeoutMS: 15000,
            connectTimeoutMS: 15000,
        });
        await mongoClient.connect();
        mongoDb = mongoClient.db();
        console.log('[MongoDB] Connected to database:', mongoDb.databaseName);
        console.log('[MongoDB] Environment:', process.env.NODE_ENV || 'development');
    } catch (err) {
        console.error('[MongoDB] Failed to connect:', err?.message || err);
        const delay = backoffDelayMs(attempt);
        console.error(`[MongoDB] Retrying in ${delay}ms...`);
        setTimeout(() => {
            connectMongo(attempt + 1);
        }, delay);
    } finally {
        mongoClientConnecting = false;
    }
}

async function ensureMongoDb(timeoutMs = 2000) {
    if (mongoDb) return mongoDb;

    // Kick off a connection attempt if one isn't already in progress.
    if (!mongoClientConnecting) {
        // fire-and-forget; connectMongo manages its own retry loop
        connectMongo();
    }

    const startedAt = Date.now();
    while (!mongoDb && (Date.now() - startedAt) < timeoutMs) {
        await new Promise((r) => setTimeout(r, 100));
    }

    return mongoDb || null;
}

app.use((req, res, next) => {
    const pathName = req.url.split('?')[0];

    // Let Express routers handle dynamic routes (/api/*, auth, admin, payments, etc).
    // The legacy handler should mainly serve static files and legacy HTML pages.
    const passThroughPrefixes = [
        '/api/',
        '/admin',
        '/assessment',
        '/assesment',
        '/analytics',
        '/ml-engineering',
        '/ml-engineer-quiz',
        '/it-learning-pyramid',
        '/profile',
        '/onboarding',
        '/start',
        '/login',
        '/logout',
        '/signup',
        '/paywall',
        '/checkout-success',
        '/stripe',
        '/webhook',
        '/forgot',
        '/reset',
    ];
    if (passThroughPrefixes.some((p) => pathName === p || pathName.startsWith(p))) {
        return next();
    }


    if (pathName === '/trends.json') {
        getTrends()
            .then((data) => {
                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' });
                res.end(JSON.stringify({ items: data.items }));
            })
            .catch(() => {
                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' });
                res.end(JSON.stringify({ items: trendsCache.items }));
            });
        return;
    }

    // Simple JSON search endpoint for ML topics (legacy)
    if (pathName === '/ml-topics.json') {
        (async () => {
            try {
                if (!mongoDb) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ items: [], error: 'ML topics search is not available (no database connection).' }));
                    return;
                }

                const url = new URL(req.url, 'http://localhost');
                const q = (url.searchParams.get('q') || '').trim();

                const coll = mongoDb.collection(ML_TOPICS_COLLECTION);
                const filter = q
                    ? { text: { $regex: q, $options: 'i' } }
                    : {};

                const docs = await coll
                    .find(filter)
                    .sort({ sectionOrder: 1, order: 1 })
                    .limit(50)
                    .toArray();

                const items = docs.map(doc => ({
                    section: doc.section,
                    text: doc.text,
                }));

                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                res.end(JSON.stringify({ items }));
            } catch (err) {
                console.error('[ML search] Failed:', err.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ items: [], error: 'Internal server error.' }));
            }
        })();
        return;
    }

    // JSON search endpoint for knowledge base topics (HTML documents)
    if (pathName === '/topics.json') {
        (async () => {
            try {
                if (!mongoDb) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ items: [], error: 'Knowledge base search is not available (no database connection).' }));
                    return;
                }

                const url = new URL(req.url, 'http://localhost');
                const q = (url.searchParams.get('q') || '').trim();

                if (!q || q.length < 2) {
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                    res.end(JSON.stringify({ items: [] }));
                    return;
                }

                const coll = mongoDb.collection(TOPICS_COLLECTION);
                const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(escaped, 'i');

                const docs = await coll
                    .find({
                        $or: [
                            { title: regex },
                            { keywords: regex },
                            { content_html: regex }
                        ]
                    })
                    .project({ title: 1, category: 1, difficulty: 1, tags: 1 })
                    .limit(20)
                    .toArray();

                const items = docs.map(doc => ({
                    id: doc._id,
                    title: doc.title,
                    category: doc.category || null,
                    difficulty: doc.difficulty || null,
                    tags: Array.isArray(doc.tags) ? doc.tags : []
                }));

                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                res.end(JSON.stringify({ items }));
            } catch (err) {
                console.error('[Topics search] Failed:', err.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ items: [], error: 'Internal server error.' }));
            }
        })();
        return;
    }

    // Knowledge base topic pages (HTML)
    if (pathName === '/topics/when-to-use-ml-vs-non-ml.html') {
        fs.readFile(path.join(__dirname, 'topics/when-to-use-ml-vs-non-ml.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error loading topic');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
            res.end(data);
        });
        return;
    }

    // ML Engineer Quiz endpoint
    if (pathName === '/ml-quiz-questions.json') {
        (async () => {
            try {
                const readyDb = await ensureMongoDb(2500);
                if (!readyDb) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ questions: [], error: 'Database not connected' }));
                    return;
                }

                const url = new URL(req.url, 'http://localhost');
                const phase = url.searchParams.get('phase') || 'all';
                const domain = url.searchParams.get('domain') || 'all';

                const coll = readyDb.collection('ml_engineer_questions');
                const filter = {};
                if (phase !== 'all') filter.phase = parseInt(phase);
                if (domain !== 'all') filter.domain = domain;

                const questions = await coll
                    .find(filter)
                    .sort({ _id: 1 })
                    .toArray();

                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
                res.end(JSON.stringify({ questions: questions }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ questions: [], error: err.message }));
            }
        })();
        return;
    }

    // Serve static files (hero.jpg, CSS, JS) and handle leading '/'
    if (pathName.match(/\.(jpg|jpeg|png|gif|svg|css|js)$/)) {
        const staticPath = pathName.replace(/^\/+/, '');
        const filePath = path.join(__dirname, staticPath);
        serveStaticFile(filePath, res);
        return;
    }

    if(pathName==='/'||pathName==='/index' ){
        fs.readFile(path.join(__dirname, 'index.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/api' || pathName === '/api.html') {
        fs.readFile(path.join(__dirname, 'api.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/assesment' || pathName === '/assesment.html' || pathName === '/assessment' || pathName === '/assessment.html') {
        fs.readFile(path.join(__dirname, 'assesment.html'), 'utf8', (err, data) => {
                if (err) {
                    res.writeHead(500, {'Content-Type': 'text/plain'});
                    res.end('Error loading page');
                    return;
                }
                let html = data;
                const isAdmin = req.user && req.user.role === 'admin';
                if (isAdmin) {
                    // Make the admin link visible for admins even if client-side JS fails.
                    html = html.replace('id="admin-link" style="display:none;', 'id="admin-link" style="display:block;');
                }
                res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
                res.end(html);
        });
    } else if (pathName === '/ml-engineer-quiz' || pathName === '/ml-engineer-quiz.html') {
        fs.readFile(path.join(__dirname, 'ml-engineer-quiz.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/lamp' || pathName === '/lamp.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/lamp.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/lemp' || pathName === '/lemp.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/lemp.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/wamp' || pathName === '/wamp.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/wamp.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/mamp' || pathName === '/mamp.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/mamp.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
        } else if (pathName === '/xampp' || pathName === '/xampp.html') {
            fs.readFile(path.join(__dirname, 'stacks/web-application/xampp.html'), 'utf8', (err, data) => {
                if (err) {
                    res.writeHead(500, {'Content-Type': 'text/plain'});
                    res.end('Error loading page');
                    return;
                }
                res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
                res.end(data);
            });
    } else if (pathName === '/mean' || pathName === '/mean.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/mean.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/mern' || pathName === '/mern.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/mern.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/mevn' || pathName === '/mevn.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/mevn.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/menn' || pathName === '/menn.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/menn.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/pern' || pathName === '/pern.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/pern.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/t3' || pathName === '/t3.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/t3.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/django' || pathName === '/django.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/django.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/flask' || pathName === '/flask.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/flask.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/fastapi' || pathName === '/fastapi.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/fastapi.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/pydata' || pathName === '/pydata.html') {
        fs.readFile(path.join(__dirname, 'stacks/data-science/pydata.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/spring' || pathName === '/spring.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/spring.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/jhipster' || pathName === '/jhipster.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/jhipster.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/javaee' || pathName === '/javaee.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/javaee.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/dotnet' || pathName === '/dotnet.html') {
        fs.readFile(path.join(__dirname, 'stacks/desktop/dotnet.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });    } else if (pathName === '/swift' || pathName === '/swift.html') {
        fs.readFile(path.join(__dirname, 'stacks/mobile/swift.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });    } else if (pathName === '/wisa' || pathName === '/wisa.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/wisa.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/azure' || pathName === '/azure.html') {
        fs.readFile(path.join(__dirname, 'stacks/cloud/azure.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });    } else if (pathName === '/swift' || pathName === '/swift.html') {
        fs.readFile(path.join(__dirname, 'stacks/mobile/swift.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });    } else if (pathName === '/rails' || pathName === '/rails.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/rails.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/rvm' || pathName === '/rvm.html') {
        fs.readFile(path.join(__dirname, 'stacks/web-application/rvm.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });    } else if (pathName === '/edge' || pathName === '/edge.html') {
        fs.readFile(path.join(__dirname, 'stacks/minimal/edge.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });    } else if (pathName === '/static' || pathName === '/static.html') {
        fs.readFile(path.join(__dirname, 'stacks/jamstack/static.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/headless' || pathName === '/headless.html') {
        fs.readFile(path.join(__dirname, 'stacks/jamstack/headless.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/jamstack' || pathName === '/jamstack.html') {
        fs.readFile(path.join(__dirname, 'stacks/jamstack/jamstack.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/symfony' || pathName === '/symfony.html') {
        fs.readFile(path.join(__dirname, 'stacks/php-frameworks/symfony.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/laravel' || pathName === '/laravel.html') {
        fs.readFile(path.join(__dirname, 'stacks/php-frameworks/laravel.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/kubernetes' || pathName === '/kubernetes.html') {
        fs.readFile(path.join(__dirname, 'stacks/cloud-native/kubernetes.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/elk' || pathName === '/elk.html') {
        fs.readFile(path.join(__dirname, 'stacks/cloud-native/elk.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });    } else if (pathName === '/bun' || pathName === '/bun.html') {
        fs.readFile(path.join(__dirname, 'stacks/minimal/bun.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });    } else if (pathName === '/efk' || pathName === '/efk.html') {
        fs.readFile(path.join(__dirname, 'stacks/cloud-native/efk.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/prometheus' || pathName === '/prometheus.html') {
        fs.readFile(path.join(__dirname, 'stacks/cloud-native/prometheus.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/hadoop' || pathName === '/hadoop.html') {
        fs.readFile(path.join(__dirname, 'stacks/data/hadoop.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/spark' || pathName === '/spark.html') {
        fs.readFile(path.join(__dirname, 'stacks/data/spark.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });    } else if (pathName === '/node' || pathName === '/node.html') {
        fs.readFile(path.join(__dirname, 'stacks/minimal/node.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });    } else if (pathName === '/kafka' || pathName === '/kafka.html') {
        fs.readFile(path.join(__dirname, 'stacks/data/kafka.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/react-native' || pathName === '/react-native.html') {
        fs.readFile(path.join(__dirname, 'stacks/mobile/react-native.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/flutter' || pathName === '/flutter.html') {
        fs.readFile(path.join(__dirname, 'stacks/mobile/flutter.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/concepts/client-server' || pathName === '/concepts/client-server.html') {
        fs.readFile(path.join(__dirname, 'concepts/client-server.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/concepts/http-vs-https' || pathName === '/concepts/http-vs-https.html') {
        fs.readFile(path.join(__dirname, 'concepts/http-vs-https.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/concepts/request-response' || pathName === '/concepts/request-response.html') {
        fs.readFile(path.join(__dirname, 'concepts/request-response.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/concepts/http-methods' || pathName === '/concepts/http-methods.html') {
        fs.readFile(path.join(__dirname, 'concepts/http-methods.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/concepts/http-status-codes' || pathName === '/concepts/http-status-codes.html') {
        fs.readFile(path.join(__dirname, 'concepts/http-status-codes.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/concepts/headers-and-body' || pathName === '/concepts/headers-and-body.html') {
        fs.readFile(path.join(__dirname, 'concepts/headers-and-body.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/concepts/domain-name-system' || pathName === '/concepts/domain-name-system.html') {
        fs.readFile(path.join(__dirname, 'concepts/domain-name-system.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/concepts/ip-address-public-vs-private' || pathName === '/concepts/ip-address-public-vs-private.html') {
        fs.readFile(path.join(__dirname, 'concepts/ip-address-public-vs-private.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/concepts/stateless-communication' || pathName === '/concepts/stateless-communication.html') {
        fs.readFile(path.join(__dirname, 'concepts/stateless-communication.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/concepts/dns-resolution' || pathName === '/concepts/dns-resolution.html') {
        fs.readFile(path.join(__dirname, 'concepts/dns-resolution.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/concepts/ports-80-443' || pathName === '/concepts/ports-80-443.html') {
        fs.readFile(path.join(__dirname, 'concepts/ports-80-443.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/concepts/tcp-vs-udp' || pathName === '/concepts/tcp-vs-udp.html') {
        fs.readFile(path.join(__dirname, 'concepts/tcp-vs-udp.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/concepts-intermediate/tls-handshake' || pathName === '/concepts-intermediate/tls-handshake.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/tls-handshake.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/concepts-intermediate/digital-certificates' || pathName === '/concepts-intermediate/digital-certificates.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/digital-certificates.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if (pathName === '/concepts-intermediate/public-key-vs-private-key' || pathName === '/concepts-intermediate/public-key-vs-private-key.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/public-key-vs-private-key.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/encryption-in-transit' || pathName === '/concepts-intermediate/encryption-in-transit.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/encryption-in-transit.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/authentication-vs-authorization' || pathName === '/concepts-intermediate/authentication-vs-authorization.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/authentication-vs-authorization.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/tokens-session-jwt-api-key' || pathName === '/concepts-intermediate/tokens-session-jwt-api-key.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/tokens-session-jwt-api-key.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/application-architecture' || pathName === '/concepts-intermediate/application-architecture.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/application-architecture.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/monolith' || pathName === '/concepts-intermediate/monolith.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/monolith.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/microservices' || pathName === '/concepts-intermediate/microservices.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/microservices.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/modular-monolith' || pathName === '/concepts-intermediate/modular-monolith.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/modular-monolith.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/api-gateway' || pathName === '/concepts-intermediate/api-gateway.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/api-gateway.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/synchronous-vs-asynchronous' || pathName === '/concepts-intermediate/synchronous-vs-asynchronous.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/synchronous-vs-asynchronous.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/rest-apis' || pathName === '/concepts-intermediate/rest-apis.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/rest-apis.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/json' || pathName === '/concepts-intermediate/json.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/json.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/api-versioning' || pathName === '/concepts-intermediate/api-versioning.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/api-versioning.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/pagination' || pathName === '/concepts-intermediate/pagination.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/pagination.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/rate-limiting' || pathName === '/concepts-intermediate/rate-limiting.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/rate-limiting.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/webhooks' || pathName === '/concepts-intermediate/webhooks.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/webhooks.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/databases-relational' || pathName === '/concepts-intermediate/databases-relational.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/databases-relational.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/databases-nosql' || pathName === '/concepts-intermediate/databases-nosql.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/databases-nosql.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/read-vs-write-operations' || pathName === '/concepts-intermediate/read-vs-write-operations.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/read-vs-write-operations.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/indexing' || pathName === '/concepts-intermediate/indexing.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/indexing.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/caching' || pathName === '/concepts-intermediate/caching.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/caching.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-intermediate/backups' || pathName === '/concepts-intermediate/backups.html') {
        fs.readFile(path.join(__dirname, 'concepts-intermediate/backups.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/vertical-scaling' || pathName === '/concepts-advance/vertical-scaling.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/vertical-scaling.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/horizontal-scaling' || pathName === '/concepts-advance/horizontal-scaling.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/horizontal-scaling.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/load-balancer' || pathName === '/concepts-advance/load-balancer.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/load-balancer.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/cdn' || pathName === '/concepts-advance/cdn.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/cdn.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/latency' || pathName === '/concepts-advance/latency.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/latency.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/throughput' || pathName === '/concepts-advance/throughput.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/throughput.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/health-checks' || pathName === '/concepts-advance/health-checks.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/health-checks.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/failover' || pathName === '/concepts-advance/failover.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/failover.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/replication' || pathName === '/concepts-advance/replication.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/replication.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/high-availability' || pathName === '/concepts-advance/high-availability.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/high-availability.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/disaster-recovery' || pathName === '/concepts-advance/disaster-recovery.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/disaster-recovery.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/logging' || pathName === '/concepts-advance/logging.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/logging.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/metrics' || pathName === '/concepts-advance/metrics.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/metrics.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/monitoring' || pathName === '/concepts-advance/monitoring.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/monitoring.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/alerts' || pathName === '/concepts-advance/alerts.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/alerts.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/distributed-tracing' || pathName === '/concepts-advance/distributed-tracing.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/distributed-tracing.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/cicd-pipeline' || pathName === '/concepts-advance/cicd-pipeline.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/cicd-pipeline.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/build-test-deploy' || pathName === '/concepts-advance/build-test-deploy.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/build-test-deploy.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/environments' || pathName === '/concepts-advance/environments.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/environments.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/secrets-management' || pathName === '/concepts-advance/secrets-management.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/secrets-management.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/rollback' || pathName === '/concepts-advance/rollback.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/rollback.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/virtual-machines' || pathName === '/concepts-advance/virtual-machines.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/virtual-machines.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/containers' || pathName === '/concepts-advance/containers.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/containers.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/docker' || pathName === '/concepts-advance/docker.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/docker.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/managed-services' || pathName === '/concepts-advance/managed-services.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/managed-services.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/concepts-advance/regions-availability-zones' || pathName === '/concepts-advance/regions-availability-zones.html') {
        fs.readFile(path.join(__dirname, 'concepts-advance/regions-availability-zones.html'), 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, {'Content-Type': 'text/plain'});
                res.end('Error loading page');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html', 'Cache-Control': 'no-store'});
            res.end(data);
        });
    } else if(pathName === '/sitexam') {
        res.end('sit the exam in arxcafe!');
    } else {
        res.writeHead(404);
        res.end('page not found');
    }
});

const startServer = () => {
    configureApp({ skipDb: false });

    // Create HTTP server with Express app
    const server = http.createServer(app);

    // Connect to MongoDB with Mongoose (for auth/subscriptions)
    const connectMongoose = (attempt = 0) => {
        mongoose.connect(mongoUri, {
            serverSelectionTimeoutMS: 15000,
            connectTimeoutMS: 15000,
        }).then(() => {
            console.log('[Mongoose] Connected to MongoDB for authentication');
        }).catch(err => {
            console.error('[Mongoose] Connection error:', err.message);
            const delay = backoffDelayMs(attempt);
            console.error(`[Mongoose] Retrying in ${delay}ms...`);
            setTimeout(() => connectMongoose(attempt + 1), delay);
        });
    };

    connectMongoose();

    // Start connecting the shared MongoClient ASAP (do not block startup).
    connectMongo();

    // WebSocket server for "currently online" counter
    const wss = new WebSocket.Server({ server, path: '/ws' });
    let activeConnections = 0;

    const broadcastActiveCount = () => {
        const payload = JSON.stringify({ active: activeConnections });
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(payload);
            }
        });
    };

    wss.on('connection', (ws) => {
        activeConnections += 1;
        broadcastActiveCount();

        ws.on('close', () => {
            activeConnections = Math.max(0, activeConnections - 1);
            broadcastActiveCount();
        });
    });

    const PORT = process.env.PORT || 8080;

    // Start HTTP server
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`The arxcafe server started on port ${PORT}`);
        console.log(`Server running at http://localhost:${PORT}`);
    });

    return { server, wss };
};

module.exports = { app, configureApp, startServer };

if (require.main === module) {
    startServer();
}