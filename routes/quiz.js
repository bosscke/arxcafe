const express = require('express');
const mongoose = require('mongoose');
const QuizAttempt = require('../models/QuizAttempt');
const QuizProgress = require('../models/QuizProgress');
const { requirePaid, requireAuth } = require('../middleware/auth');

const router = express.Router();

function isDbConnected() {
  return mongoose?.connection?.readyState === 1;
}

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

// GET /api/quiz/progress/state?quiz_id=it-learning-pyramid
// Returns per-user progress state used for client-side completion tracking.
router.get('/api/quiz/progress/state', requireAuth, async (req, res) => {
  try {
    const quiz_id = String(req.query.quiz_id || '').trim();
    if (!quiz_id) return res.status(400).json({ ok: false, error: 'quiz_id is required' });

    // Only allow known quiz IDs for now (tighten surface area).
    if (quiz_id !== 'it-learning-pyramid') {
      return res.status(400).json({ ok: false, error: 'Unsupported quiz_id' });
    }

    const userId = req.user?._id;
    if (!userId) return res.status(401).json({ ok: false, error: 'Not authenticated' });

    if (!isDbConnected()) {
      return res.json({ ok: true, quiz_id, progress: {}, skipped: true });
    }

    const doc = await QuizProgress.findOne({ user_id: userId, quiz_id })
      .select({ progress: 1, updated_at: 1 })
      .lean();

    return res.json({
      ok: true,
      quiz_id,
      progress: doc?.progress && typeof doc.progress === 'object' ? doc.progress : {},
      updatedAt: doc?.updated_at ?? null
    });
  } catch (err) {
    console.error('[QuizProgressState] Error:', err);
    return res.status(500).json({ ok: false, error: 'Failed to load progress state' });
  }
});

// POST /api/quiz/progress/mark-batch
// Body: { quiz_id: 'it-learning-pyramid', progressKey: 'networking-d1', batchIndex: 1, batchEndIndex: 20 }
router.post('/api/quiz/progress/mark-batch', requireAuth, async (req, res) => {
  try {
    const quiz_id = String(req.body.quiz_id || '').trim();
    const progressKey = String(req.body.progressKey || '').trim();
    const batchIndex = Math.floor(Number(req.body.batchIndex));
    const batchEndIndex = Math.floor(Number(req.body.batchEndIndex));

    if (!quiz_id) return res.status(400).json({ ok: false, error: 'quiz_id is required' });
    if (quiz_id !== 'it-learning-pyramid') {
      return res.status(400).json({ ok: false, error: 'Unsupported quiz_id' });
    }

    if (!progressKey) return res.status(400).json({ ok: false, error: 'progressKey is required' });
    if (!/^networking-d[1-5]$/.test(progressKey)) {
      return res.status(400).json({ ok: false, error: 'Invalid progressKey' });
    }

    if (!Number.isFinite(batchIndex) || batchIndex < 1 || batchIndex > 1000) {
      return res.status(400).json({ ok: false, error: 'Invalid batchIndex' });
    }

    const nextIndex = Number.isFinite(batchEndIndex) && batchEndIndex > 0 ? batchEndIndex : 0;

    const userId = req.user?._id;
    if (!userId) return res.status(401).json({ ok: false, error: 'Not authenticated' });

    if (!isDbConnected()) {
      return res.json({ ok: true, quiz_id, progressKey, batchIndex, skipped: true });
    }

    const nowIso = new Date().toISOString();
    let doc = await QuizProgress.findOne({ user_id: userId, quiz_id });
    if (!doc) doc = new QuizProgress({ user_id: userId, quiz_id, progress: {} });

    const progress = doc.progress && typeof doc.progress === 'object' ? doc.progress : {};
    const entry = progress[progressKey] && typeof progress[progressKey] === 'object' ? progress[progressKey] : {};
    const existing = Array.isArray(entry.completedBatches) ? entry.completedBatches : [];

    const merged = Array.from(
      new Set(
        existing
          .map((x) => Math.floor(Number(x)))
          .filter((x) => Number.isFinite(x) && x >= 1)
          .concat([batchIndex])
      )
    ).sort((a, b) => a - b);

    const prevNext = Math.floor(Number(entry.nextIndex) || 0);
    const mergedNext = Math.max(0, prevNext, nextIndex);

    progress[progressKey] = {
      ...entry,
      completedBatches: merged.slice(0, 2000),
      nextIndex: mergedNext,
      at: nowIso
    };

    doc.progress = progress;
    doc.markModified('progress');
    await doc.save();

    return res.json({ ok: true, quiz_id, progressKey, savedAt: nowIso });
  } catch (err) {
    console.error('[QuizMarkBatch] Error:', err);
    return res.status(500).json({ ok: false, error: 'Failed to save progress' });
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
