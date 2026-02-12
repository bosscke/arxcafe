const express = require('express');
const QuizAttempt = require('../models/QuizAttempt');
const { requirePaid, requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/quiz/history - recent attempts for the signed-in user
router.get('/api/quiz/history', requireAuth, async (req, res) => {
  try {
    const quizId = String(req.query.quiz_id || '').trim();
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.floor(limitRaw))) : 10;

    const query = { user_id: req.user._id };
    if (quizId) query.quiz_id = quizId;

    const attempts = await QuizAttempt.find(query)
      .sort({ created_at: -1 })
      .limit(limit)
      .select({ quiz_id: 1, phase: 1, score: 1, total: 1, percentage: 1, domain_stats: 1, created_at: 1 })
      .lean();

    return res.json({ ok: true, attempts });
  } catch (err) {
    console.error('[QuizHistory] Error:', err);
    return res.status(500).json({ ok: false, error: 'Failed to load history' });
  }
});

// POST /api/quiz/attempt - store a completed quiz attempt for progress tracking
router.post('/api/quiz/attempt', requireAuth, async (req, res) => {
  try {
    const quiz_id = String(req.body.quiz_id || '').trim();
    const phaseRaw = req.body.phase;
    const phase = phaseRaw === null || typeof phaseRaw === 'undefined' || phaseRaw === '' ? null : Number(phaseRaw);

    const score = Number(req.body.score);
    const total = Number(req.body.total);
    const percentage = Number(req.body.percentage);

    if (!quiz_id) {
      return res.status(400).json({ ok: false, error: 'quiz_id is required' });
    }

    if (!Number.isFinite(score) || !Number.isFinite(total) || total <= 0 || score < 0) {
      return res.status(400).json({ ok: false, error: 'Invalid score/total' });
    }

    const pct = Number.isFinite(percentage) ? percentage : Math.round((score / total) * 100);

    const domain_stats = Array.isArray(req.body.domain_stats)
      ? req.body.domain_stats
          .map((d) => ({
            domain: String(d.domain || '').trim(),
            correct: Number(d.correct),
            total: Number(d.total)
          }))
          .filter((d) => d.domain && Number.isFinite(d.correct) && Number.isFinite(d.total) && d.total >= 0 && d.correct >= 0)
      : [];

    const attempt = await QuizAttempt.create({
      user_id: req.user._id,
      quiz_id,
      phase: Number.isFinite(phase) ? phase : null,
      score,
      total,
      percentage: pct,
      domain_stats
    });

    try {
      void req.app.locals.trackEvent?.(req, 'quiz_attempt_saved', { quiz_id, phase: Number.isFinite(phase) ? phase : null, percentage: pct });
    } catch (e) {
      // ignore
    }

    res.json({ ok: true, id: attempt._id });
  } catch (err) {
    console.error('[QuizAttempt] Save error:', err);
    res.status(500).json({ ok: false, error: 'Failed to save attempt' });
  }
});

module.exports = router;
