// AI Explain Route - 1:1 port from PHP to Node.js
const crypto = require('crypto');

// Helper functions
function jsonError(res, status, message) {
  return res.status(status).json({ ok: false, error: message });
}

function normalizeDifficulty(difficulty) {
  const d = String(difficulty || '').trim().toLowerCase();
  if (d === 'medium' || d === 'intermediate') return 'medium';
  if (d === 'hard' || d === 'advanced') return 'hard';
  if (d === 'easy' || d === 'beginner') return 'easy';
  return '';
}

function guessConfidenceFromText(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return 'partial';
  const uncertain = ['not sure','unsure','uncertain','might','maybe','probably','possibly','it seems','i think','hard to say','cannot confirm',"can't confirm"];
  return uncertain.some(w => t.includes(w)) ? 'partial' : 'complete';
}

function buildShortPrompt(questionText, userAnswer, correctAnswer, isCorrect) {
  const verdict = (isCorrect === null || typeof isCorrect === 'undefined')
    ? ''
    : (isCorrect ? 'The user answer is correct.' : 'The user answer is incorrect.');

  return (
    "You are a professional certification exam tutor.\n" +
    "Write ONE complete paragraph that fully explains why the answer is correct or incorrect.\n" +
    "Target length: 40–70 words. If unsure, write slightly longer rather than shorter.\n" +
    "Do NOT exceed 3 sentences.\n" +
    "Do NOT use emojis.\n" +
    "Do NOT ask questions.\n" +
    "The explanation must end on a complete sentence and a finished thought.\n" +
    "Return only the explanation text.\n\n" +
    `Question: ${questionText}\n` +
    `User answer: ${userAnswer}\n` +
    `Correct answer: ${correctAnswer}\n` +
    (verdict ? (verdict + "\n") : "")
  );
}

function buildLongPrompt(shortExplanation) {
  return (
    "You are a professional certification exam tutor.\n" +
    "Return only the explanation text.\n" +
    "Expand the explanation below into comprehensive learning context.\n" +
    "Rules:\n" +
    "- 120–220 words\n" +
    "- Clear beginning, middle, and conclusion\n" +
    "- Explain background, concepts, and implications\n" +
    "- Do NOT repeat sentences verbatim\n" +
    "- End with a complete concluding sentence\n\n" +
    "Base explanation:\n" +
    String(shortExplanation || '')
  );
}

function buildMetaPrompt(questionText, userAnswer, correctAnswer, isCorrect, shortExplanation, difficulty) {
  const verdict = (isCorrect === null || typeof isCorrect === 'undefined')
    ? ''
    : (isCorrect ? 'The user answer is correct.' : 'The user answer is incorrect.');

  const dn = normalizeDifficulty(difficulty);
  const difficultyLine = dn ? `Difficulty: ${dn}\n` : '';

  return (
    "You are a professional certification exam tutor.\n" +
    "You must return ONLY valid JSON with exactly these keys: confidence, expandable.\n" +
    "confidence is one of: \"complete\" or \"partial\".\n" +
    "expandable is a boolean.\n" +
    "Rules for expandable:\n" +
    "- expandable = true IF additional context exists\n" +
    "  OR confidence = partial\n" +
    "  OR difficulty >= medium\n" +
    "- expandable = false IF short_explanation is fully sufficient\n" +
    "  AND no meaningful expansion improves learning\n\n" +
    `Question: ${questionText}\n` +
    `User answer: ${userAnswer}\n` +
    `Correct answer: ${correctAnswer}\n` +
    (verdict ? (verdict + "\n") : "") +
    difficultyLine +
    "Short explanation:\n" +
    String(shortExplanation || '')
  );
}

async function geminiGenerate({ apiKey, model, payload, signal }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal
  });

  const text = await res.text().catch(() => '');
  let decoded = null;
  try { decoded = JSON.parse(text); } catch { decoded = null; }

  return { ok: res.ok, status: res.status, decoded, rawText: text };
}

function extractGeminiText(decoded) {
  try {
    const parts = decoded?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return '';
    return parts.map(p => (p && typeof p.text === 'string') ? p.text : '').join('');
  } catch {
    return '';
  }
}

function extractGeminiError(decoded) {
  const err = decoded?.error;
  if (!err || typeof err !== 'object') return {};
  return {
    code: err.code,
    status: err.status,
    message: err.message
  };
}

function sha1Hex(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}

async function handleAiExplain(req, res, mongoDb) {
  const data = req.body;
  if (!data || typeof data !== 'object') return jsonError(res, 400, 'Invalid JSON');

  const question_id = String(data.question_id || '').trim();
  const question_text = String(data.question_text || '').trim();
  const user_answer = String(data.user_answer || '').trim();
  const correct_answer = String(data.correct_answer || '').trim();
  const is_correct = (typeof data.is_correct === 'boolean') ? data.is_correct : null;
  const explanation_level = String(data.explanation_level || 'short').trim();
  const quiz_id = String(data.quiz_id || '').trim();
  const difficulty = (data.difficulty === null || typeof data.difficulty === 'undefined') ? '' : String(data.difficulty);
  const debug = Boolean(data._debug);

  if (!question_id || !question_text) return jsonError(res, 400, 'Missing question_id or question_text');
  if (explanation_level !== 'short' && explanation_level !== 'long') return jsonError(res, 400, 'Invalid explanation_level');

  // Cache key must vary by answer (answer-variant aware)
  const cache_key = sha1Hex(
    question_id
    + '|' + user_answer.trim().toLowerCase()
    + '|' + correct_answer.trim().toLowerCase()
    + '|' + (is_correct === null ? '' : (is_correct ? '1' : '0'))
  );

  const ip = (req.headers['x-forwarded-for']?.toString().split(',')[0].trim()) || req.socket.remoteAddress || '';
  const userId = req.user?.id || req.session?.userId || null;

  const logRequest = async ({ cached, provider_http_status, provider_status, provider_message }) => {
    try {
      if (!mongoDb) return;
      await mongoDb.collection('ai_explain_requests').insertOne({
        created_at: new Date(),
        ip: String(ip || ''),
        user_id: userId ? String(userId) : null,
        quiz_id: quiz_id || null,
        question_id: question_id || null,
        explanation_level,
        cached: Boolean(cached),
        provider_http_status: (typeof provider_http_status === 'number') ? provider_http_status : null,
        provider_status: provider_status ? String(provider_status).slice(0, 64) : null,
        provider_message: provider_message ? String(provider_message).slice(0, 255) : null,
      });
    } catch {
      // never break quiz UX
    }
  };

  // 1) Cache lookup
  try {
    if (mongoDb) {
      const row = await mongoDb.collection('ai_explanations_v2').findOne({ cache_key });
      if (row) {
        const short = String(row.short_text || '');
        const long = String(row.long_text || '');
        let confidence = String(row.confidence || '');
        let expandable = Boolean(row.expandable);

        if (confidence !== 'complete' && confidence !== 'partial') {
          confidence = guessConfidenceFromText(short);
        }

        if (explanation_level !== 'long' || long !== '') {
          await logRequest({ cached: true, provider_http_status: null, provider_status: '', provider_message: '' });
          return res.json({
            ok: true,
            question_id,
            model: row.model || process.env.AI_ASSIST_MODEL || 'gemini-2.5-flash',
            short_explanation: short,
            long_explanation: (explanation_level === 'long') ? long : null,
            expandable,
            confidence,
            cached: true
          });
        }
      }
    }
  } catch {
    // Cache read errors should not kill UX
  }

  const model = process.env.AI_ASSIST_MODEL || 'gemini-2.5-flash';
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    await logRequest({ cached: false, provider_http_status: null, provider_status: 'NO_API_KEY', provider_message: 'GEMINI_API_KEY is not configured' });
    return res.json({
      ok: true,
      question_id,
      model,
      short_explanation: '',
      long_explanation: null,
      expandable: false,
      confidence: 'partial',
      cached: false
    });
  }

  // 2) Generate short first
  const shortPrompt = buildShortPrompt(question_text, user_answer, correct_answer, is_correct);

  const controller = new AbortController();
  const timeoutShort = Math.min(Number(data._timeout_ms || 12000) || 12000, 15000);
  const t = setTimeout(() => controller.abort(), timeoutShort);

  let shortText = '';
  let providerStatus = '';
  let providerMessage = '';
  let providerHttpStatus = null;

  try {
    const payloadShort = {
      contents: [{ role: 'user', parts: [{ text: shortPrompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 1024 }
    };

    const r = await geminiGenerate({ apiKey, model, payload: payloadShort, signal: controller.signal });
    providerHttpStatus = r.status;

    if (!r.ok) {
      const perr = debug ? extractGeminiError(r.decoded) : {};
      providerStatus = String(perr.status || '');
      providerMessage = String(perr.message || '') || `HTTP ${r.status}`;
      await logRequest({ cached: false, provider_http_status: r.status, provider_status: providerStatus, provider_message: providerMessage });
      return res.json({
        ok: true,
        question_id,
        model,
        short_explanation: '',
        long_explanation: null,
        expandable: false,
        confidence: 'partial',
        cached: false
      });
    }

    shortText = extractGeminiText(r.decoded).trim();

    if (!shortText) {
      await logRequest({ cached: false, provider_http_status: r.status, provider_status: 'EMPTY_RESPONSE', provider_message: 'Gemini returned empty text' });
      return res.json({
        ok: true,
        question_id,
        model,
        short_explanation: '',
        long_explanation: null,
        expandable: false,
        confidence: 'partial',
        cached: false
      });
    }
  } catch (e) {
    const msg = (e && typeof e.message === 'string') ? e.message : 'AI request failed';
    await logRequest({ cached: false, provider_http_status: providerHttpStatus, provider_status: 'FETCH_ERROR', provider_message: msg });
    return res.json({
      ok: true,
      question_id,
      model,
      short_explanation: '',
      long_explanation: null,
      expandable: false,
      confidence: 'partial',
      cached: false
    });
  } finally {
    clearTimeout(t);
  }

  // 3) Meta classify (best-effort)
  let confidence = 'complete';
  let expandable = true;

  try {
    const metaPrompt = buildMetaPrompt(question_text, user_answer, correct_answer, is_correct, shortText, difficulty);
    const payloadMeta = {
      contents: [{ role: 'user', parts: [{ text: metaPrompt }] }],
      generationConfig: { temperature: 0.0, maxOutputTokens: 80 }
    };

    const r2 = await geminiGenerate({ apiKey, model, payload: payloadMeta });
    if (r2.ok) {
      const metaText = extractGeminiText(r2.decoded).trim();
      const mj = JSON.parse(metaText);
      if (mj && (mj.confidence === 'complete' || mj.confidence === 'partial')) confidence = mj.confidence;
      if (typeof mj.expandable === 'boolean') expandable = mj.expandable;
    }
  } catch {
    // ignore
  }

  if (confidence !== 'complete' && confidence !== 'partial') confidence = guessConfidenceFromText(shortText);

  // Enforce deterministic rules
  const dNorm = normalizeDifficulty(difficulty);
  if (dNorm === 'medium' || dNorm === 'hard') expandable = true;
  if (confidence === 'partial') expandable = true;

  // 4) Long generation (only if requested)
  let longText = '';
  if (explanation_level === 'long') {
    try {
      const longPrompt = buildLongPrompt(shortText);
      const payloadLong = {
        contents: [{ role: 'user', parts: [{ text: longPrompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 420 }
      };

      const r3 = await geminiGenerate({ apiKey, model, payload: payloadLong });
      if (r3.ok) longText = extractGeminiText(r3.decoded).trim();
    } catch {
      // ignore
    }
  }

  // 5) Upsert cache
  try {
    if (mongoDb) {
      await mongoDb.collection('ai_explanations_v2').updateOne(
        { cache_key },
        {
          $setOnInsert: { created_at: new Date() },
          $set: {
            cache_key,
            question_id,
            model,
            expandable,
            confidence,
            ...(quiz_id ? { quiz_id } : {}),
            ...(shortText ? { short_text: shortText } : {}),
            ...(longText ? { long_text: longText } : {})
          }
        },
        { upsert: true }
      );
    }
  } catch {
    // ignore
  }

  await logRequest({ cached: false, provider_http_status: 200, provider_status: '', provider_message: '' });

  return res.json({
    ok: true,
    question_id,
    model,
    short_explanation: shortText,
    long_explanation: (explanation_level === 'long') ? longText : null,
    expandable,
    confidence,
    cached: false
  });
}

module.exports = { handleAiExplain };
