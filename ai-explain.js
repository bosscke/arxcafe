// AI explanation endpoint for Gemini 2.5
// Provides short (<= ~60 words) and optional long explanations for quiz answers
// MongoDB-based caching with answer-variant awareness

const crypto = require('crypto');

// Helper: Generate cache key based on question, user answer, and correctness
function generateCacheKey(questionId, userAnswer, correctAnswer, isCorrect) {
    const components = [
        questionId,
        (userAnswer || '').toLowerCase().trim(),
        (correctAnswer || '').toLowerCase().trim(),
        isCorrect === null ? '' : (isCorrect ? '1' : '0')
    ].join('|');
    
    return crypto.createHash('sha1').update(components).digest('hex');
}

// Helper: Get client IP
function getClientIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0].trim() 
        || req.socket?.remoteAddress 
        || '';
}

// Helper: Normalize difficulty level
function normalizeDifficulty(difficulty) {
    const d = (difficulty || '').toLowerCase().trim();
    if (d === 'medium' || d === 'intermediate') return 'medium';
    if (d === 'hard' || d === 'advanced') return 'hard';
    if (d === 'easy' || d === 'beginner') return 'easy';
    return '';
}

// Helper: Guess confidence from text
function guessConfidenceFromText(text) {
    const t = (text || '').toLowerCase();
    if (t === '') return 'partial';
    
    const uncertain = [
        'not sure', 'unsure', 'uncertain', 'might', 'maybe', 'probably', 'possibly',
        'it seems', 'i think', 'hard to say', 'cannot confirm', "can't confirm"
    ];
    
    for (const word of uncertain) {
        if (t.includes(word)) return 'partial';
    }
    return 'complete';
}

// Build short explanation prompt (40-70 words, 1-3 sentences)
function buildShortPrompt(questionText, userAnswer, correctAnswer, isCorrect) {
    const verdict = isCorrect === null 
        ? '' 
        : (isCorrect ? 'The user answer is correct.' : 'The user answer is incorrect.');

    return `You are an educational tutor specializing in professional certification exams.
Write ONE complete paragraph that fully explains why the answer is correct or incorrect.
Target length: 40–70 words. If unsure, write slightly longer rather than shorter.
Do NOT exceed 3 sentences.
Do NOT use emojis.
Do NOT ask questions.
The explanation must end on a complete sentence and a finished thought.
Return only the explanation text.

Question: ${questionText}
User answer: ${userAnswer}
Correct answer: ${correctAnswer}
${verdict ? verdict + '\n' : ''}`;
}

// Build long explanation prompt (120-220 words with context)
function buildLongPrompt(shortExplanation) {
    return `You are an educational tutor specializing in professional certification exams.
Return only the explanation text.
Expand the explanation below into comprehensive learning context.
Rules:
- 120–220 words
- Clear beginning, middle, and conclusion
- Explain background, concepts, and implications
- Do NOT repeat sentences verbatim from the short explanation
- End with a complete concluding sentence

Base explanation:
${shortExplanation}`;
}

// Build metadata prompt (confidence + expandable classification)
function buildMetaPrompt(questionText, userAnswer, correctAnswer, isCorrect, shortExplanation, difficulty) {
    const verdict = isCorrect === null 
        ? '' 
        : (isCorrect ? 'The user answer is correct.' : 'The user answer is incorrect.');
    const difficultyNorm = normalizeDifficulty(difficulty);
    const difficultyLine = difficultyNorm ? `Difficulty: ${difficultyNorm}\n` : '';

    return `You are an educational tutor.
You must return ONLY valid JSON with exactly these keys: confidence, expandable.
confidence is one of: "complete" or "partial".
expandable is a boolean.
Rules for expandable:
- expandable = true IF additional context exists
  OR confidence = partial
  OR difficulty >= medium
- expandable = false IF short_explanation is fully sufficient
  AND no meaningful expansion improves learning

Question: ${questionText}
User answer: ${userAnswer}
Correct answer: ${correctAnswer}
${verdict ? verdict + '\n' : ''}${difficultyLine}Short explanation:
${shortExplanation}`;
}

// Call Gemini API
async function callGeminiApi(endpoint, payload, apiKey) {
    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const text = await response.text();
        const data = response.ok ? JSON.parse(text) : null;
        
        return {
            success: response.ok,
            status: response.status,
            data: data,
            error: !response.ok ? text : null
        };
    } catch (err) {
        return {
            success: false,
            status: null,
            data: null,
            error: err.message
        };
    }
}

// Extract text from Gemini response
function extractGeminiText(decoded) {
    if (!decoded || !decoded.candidates || !decoded.candidates[0]) return '';
    const parts = decoded.candidates[0].content?.parts || [];
    return parts.map(p => p.text || '').join('');
}

// Extract finish reason
function extractFinishReason(decoded) {
    return decoded?.candidates?.[0]?.finishReason || '';
}

// Log AI explanation request
async function logAiExplainRequest(db, ip, userId, quizId, questionId, explanationLevel, cached, providerStatus, providerMessage) {
    try {
        if (!db) return;
        const collection = db.collection('ai_explain_requests');
        
        await collection.insertOne({
            createdAt: new Date(),
            ip: ip,
            userId: userId || null,
            quizId: quizId,
            questionId: questionId,
            explanationLevel: explanationLevel,
            cached: cached,
            providerStatus: providerStatus,
            providerMessage: providerMessage
        });
    } catch (err) {
        // Silently fail - never break quiz UX
    }
}

// Main AI explain handler
async function handleAiExplain(req, res, mongoDb) {
    const ip = getClientIp(req);
    
    // Parse request body
    let data = {};
    try {
        const raw = await new Promise((resolve, reject) => {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => resolve(body));
            req.on('error', reject);
        });
        data = raw ? JSON.parse(raw) : {};
    } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
        return;
    }

    const questionId = (data.question_id || '').trim();
    const questionText = (data.question_text || '').trim();
    const userAnswer = (data.user_answer || '').trim();
    const correctAnswer = (data.correct_answer || '').trim();
    const isCorrect = data.is_correct !== undefined ? Boolean(data.is_correct) : null;
    const explanationLevel = (data.explanation_level || 'short').trim();
    const quizId = (data.quiz_id || '').trim();
    const difficulty = (data.difficulty || '').trim();
    const debug = Boolean(data._debug);

    // Validation
    if (!questionId || !questionText) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Missing question_id or question_text' }));
        return;
    }

    if (explanationLevel !== 'short' && explanationLevel !== 'long') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid explanation_level' }));
        return;
    }

    // Generate cache key
    const cacheKey = generateCacheKey(questionId, userAnswer, correctAnswer, isCorrect);

    // Try cache first (ai_explanations_v2 - answer-variant aware)
    if (mongoDb) {
        try {
            const cacheCollection = mongoDb.collection('ai_explanations_v2');
            const cached = await cacheCollection.findOne({ cacheKey: cacheKey });
            
            if (cached) {
                const confidence = cached.confidence || guessConfidenceFromText(cached.shortText);
                const expandable = cached.expandable || false;
                
                if (explanationLevel !== 'long' || cached.longText) {
                    await logAiExplainRequest(mongoDb, ip, null, quizId, questionId, explanationLevel, true, '', '');
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        ok: true,
                        question_id: questionId,
                        model: cached.model,
                        short_explanation: cached.shortText || '',
                        long_explanation: explanationLevel === 'long' ? (cached.longText || null) : null,
                        expandable: expandable,
                        confidence: confidence,
                        cached: true
                    }));
                    return;
                }
            }
        } catch (err) {
            // Continue if cache lookup fails
        }
    }

    // Get API key and model
    const apiKey = process.env.GEMINI_API_KEY;
    const model = process.env.AI_ASSIST_MODEL || 'gemini-2.5-flash';

    if (!apiKey) {
        await logAiExplainRequest(mongoDb, ip, null, quizId, questionId, explanationLevel, false, 'NO_API_KEY', 'GEMINI_API_KEY not configured');
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ok: true,
            question_id: questionId,
            model: model,
            short_explanation: '',
            long_explanation: null,
            expandable: false,
            confidence: 'partial',
            cached: false
        }));
        return;
    }

    // Call Gemini for short explanation
    const shortPrompt = buildShortPrompt(questionText, userAnswer, correctAnswer, isCorrect);
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const payloadShort = {
        contents: [{
            role: 'user',
            parts: [{ text: shortPrompt }]
        }],
        generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 1024
        }
    };

    const respShort = await callGeminiApi(endpoint, payloadShort, apiKey);

    if (!respShort.success) {
        await logAiExplainRequest(mongoDb, ip, null, quizId, questionId, explanationLevel, false, 'API_ERROR', respShort.error || 'HTTP ' + respShort.status);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ok: true,
            question_id: questionId,
            model: model,
            short_explanation: '',
            long_explanation: null,
            expandable: false,
            confidence: 'partial',
            cached: false,
            ai_error: respShort.error || 'HTTP ' + respShort.status
        }));
        return;
    }

    const shortText = extractGeminiText(respShort.data).trim();
    const finishReasonShort = debug ? extractFinishReason(respShort.data) : '';

    if (!shortText) {
        await logAiExplainRequest(mongoDb, ip, null, quizId, questionId, explanationLevel, false, 'EMPTY_RESPONSE', 'Gemini returned empty text');
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ok: true,
            question_id: questionId,
            model: model,
            short_explanation: '',
            long_explanation: null,
            expandable: false,
            confidence: 'partial',
            cached: false,
            ai_finish_reason: finishReasonShort
        }));
        return;
    }

    // Determine confidence + expandable
    let confidence = 'complete';
    let expandable = true;

    try {
        const metaPrompt = buildMetaPrompt(questionText, userAnswer, correctAnswer, isCorrect, shortText, difficulty);
        const payloadMeta = {
            contents: [{
                role: 'user',
                parts: [{ text: metaPrompt }]
            }],
            generationConfig: {
                temperature: 0.0,
                maxOutputTokens: 80
            }
        };

        const respMeta = await callGeminiApi(endpoint, payloadMeta, apiKey);
        if (respMeta.success) {
            const metaText = extractGeminiText(respMeta.data).trim();
            try {
                const metaJson = JSON.parse(metaText);
                if (metaJson.confidence === 'complete' || metaJson.confidence === 'partial') {
                    confidence = metaJson.confidence;
                }
                if (typeof metaJson.expandable === 'boolean') {
                    expandable = metaJson.expandable;
                }
            } catch (e) {
                // Use defaults if JSON parsing fails
            }
        }
    } catch (err) {
        // Continue with defaults
    }

    if (confidence !== 'complete' && confidence !== 'partial') {
        confidence = guessConfidenceFromText(shortText);
    }

    // Enforce difficulty rule
    const diffNorm = normalizeDifficulty(difficulty);
    if (diffNorm === 'medium' || diffNorm === 'hard') {
        expandable = true;
    }
    if (confidence === 'partial') {
        expandable = true;
    }

    // Generate long explanation if requested
    let longText = '';
    if (explanationLevel === 'long') {
        const longPrompt = buildLongPrompt(shortText);
        const payloadLong = {
            contents: [{
                role: 'user',
                parts: [{ text: longPrompt }]
            }],
            generationConfig: {
                temperature: 0.3,
                maxOutputTokens: 420
            }
        };

        const respLong = await callGeminiApi(endpoint, payloadLong, apiKey);
        if (respLong.success) {
            longText = extractGeminiText(respLong.data).trim();
        }
    }

    // Cache the result
    if (mongoDb) {
        try {
            const cacheCollection = mongoDb.collection('ai_explanations_v2');
            await cacheCollection.updateOne(
                { cacheKey: cacheKey },
                {
                    $set: {
                        cacheKey: cacheKey,
                        questionId: questionId,
                        quizId: quizId,
                        shortText: shortText,
                        longText: longText || '',
                        model: model,
                        createdAt: new Date(),
                        expandable: expandable,
                        confidence: confidence
                    }
                },
                { upsert: true }
            );
        } catch (err) {
            // Silently fail cache update
        }
    }

    await logAiExplainRequest(mongoDb, ip, null, quizId, questionId, explanationLevel, false, '', '');

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        ok: true,
        question_id: questionId,
        model: model,
        short_explanation: shortText,
        long_explanation: explanationLevel === 'long' ? longText : null,
        expandable: expandable,
        confidence: confidence,
        cached: false,
        ai_finish_reason: debug ? finishReasonShort : null
    }));
}

module.exports = { handleAiExplain };
