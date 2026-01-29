# Gemini 2.5 AI Explanations Setup Guide

## Overview

The quiz now integrates Google Gemini 2.5 API to provide AI-powered explanations for quiz answers. When users answer a question, they can click "📚 Explain this answer" to get detailed explanations powered by the Gemini model.

## Architecture

### Endpoint: `/ai-explain.json` (POST)

**Request Schema:**
```json
{
  "question_id": "q-1",
  "question_text": "What is Machine Learning?",
  "user_answer": "A",
  "correct_answer": "C",
  "is_correct": false,
  "explanation_level": "short|long",
  "quiz_id": "ml-engineer-exam",
  "difficulty": "medium"
}
```

**Response Schema:**
```json
{
  "ok": true,
  "question_id": "q-1",
  "model": "gemini-2.5-flash",
  "short_explanation": "Machine Learning is a subset of artificial intelligence...",
  "long_explanation": null,
  "expandable": true,
  "confidence": "complete|partial",
  "cached": true|false
}
```

### Features

1. **Smart Caching**
   - `ai_explanations_v2` MongoDB collection stores explanations
   - Cache key varies by question, user answer, and correctness
   - Different wrong answers get different explanations
   - Reduces API calls and costs

2. **Two-Tier Explanations**
   - **Short** (40-70 words, 1-3 sentences): Immediate feedback
   - **Long** (120-220 words): Comprehensive context on demand
   - Users see "📖 Read more" button when long version available

3. **Confidence & Expandability Scoring**
   - `confidence`: "complete" or "partial" (how confident the AI is)
   - `expandable`: boolean (whether more context would help)
   - Automatically generates for each explanation

4. **Request Logging**
   - `ai_explain_requests` MongoDB collection tracks all requests
   - Logs IP, user_id, quiz_id, question_id, response status
   - Used for analytics and debugging

5. **Error Handling**
   - Gracefully falls back to stored explanations if API fails
   - Non-blocking: quiz UX unaffected if AI service unavailable
   - Returns ok: true even with empty explanations (no errors for user)

## Setup Instructions

### 1. Get a Gemini API Key

1. Visit [Google AI Studio](https://ai.google.dev/tutorials/setup)
2. Click "Get API Key" 
3. Create new API key in Google Cloud Console
4. Copy the key

### 2. Configure Environment Variables

Create or update `.env` file in the root directory:

```bash
GEMINI_API_KEY=your_api_key_here
AI_ASSIST_MODEL=gemini-2.5-flash
```

The script supports environment variable loading:
- Direct `GEMINI_API_KEY` env variable
- `.env` file in project root or parent directories
- Gracefully skips AI if API key not configured

### 3. MongoDB Collections

The system automatically creates two collections:

**ai_explanations_v2** (Answer-variant aware caching)
```javascript
{
  cacheKey: "sha1_hash",
  questionId: "q-1",
  quizId: "ml-engineer-exam",
  shortText: "Machine Learning enables...",
  longText: "Machine Learning is a subset...",
  model: "gemini-2.5-flash",
  createdAt: ISODate("2026-01-29T..."),
  expandable: true,
  confidence: "complete"
}
```

**ai_explain_requests** (Request logging)
```javascript
{
  createdAt: ISODate("2026-01-29T..."),
  ip: "192.168.1.1",
  userId: null,
  quizId: "ml-engineer-exam",
  questionId: "q-1",
  explanationLevel: "short",
  cached: true,
  providerStatus: "",
  providerMessage: ""
}
```

### 4. Test the Integration

```bash
# Start server
npm start

# Navigate to quiz
http://localhost:8080/ml-engineer-quiz.html

# Answer a question and click "📚 Explain this answer"
```

Expected behavior:
1. Button shows "⏳ Loading explanation..." 
2. Blue panel appears with loading text
3. After 2-3 seconds, AI explanation appears
4. "📖 Read more" button shows (if expandable=true)
5. Model attribution shows at bottom

## Prompt Engineering

### Short Explanation Prompt
- Target: 40-70 words, 1-3 sentences
- Instructed to explain why answer is correct/incorrect
- Context: User answer vs correct answer
- Temperature: 0.2 (focused, deterministic)

### Long Explanation Prompt
- Target: 120-220 words with structure
- Expands from short explanation
- Explains background, concepts, implications
- Temperature: 0.3 (slightly more creative)

### Meta Prompt (Confidence Classification)
- Returns JSON with confidence + expandable
- Evaluates uncertainty language in short explanation
- Considers question difficulty
- Temperature: 0.0 (deterministic)

## Cost Optimization

### Input/Output Tokens
- Short prompt: ~100-200 tokens input, ~100 tokens output
- Long prompt: ~300 tokens input, ~200 tokens output
- Meta prompt: ~200 tokens input, ~20 tokens output

### Estimated Usage
With 1000 quizzes × 50 questions × 30% explanation requests:
- ~15,000 short explanation calls
- ~5,000 long explanation calls (expandable)
- ~15,000 meta classification calls

**Caching Impact**: First request generates, subsequent identical answers use cache (99%+ hit rate for repeated questions).

### API Pricing
- Gemini 2.5 Flash: $0.075 per 1M input tokens, $0.30 per 1M output tokens
- Estimated monthly cost: ~$50-100 for typical usage
- Caching reduces this significantly

## Troubleshooting

### "Could not generate explanation" Error
1. Check `GEMINI_API_KEY` in `.env`
2. Verify API key is active in Google Cloud Console
3. Check rate limits (free tier has quota limits)
4. Review server logs for `[MongoDB]` connection status

### Empty Explanation Returned
1. Verify MongoDB connection (check server logs)
2. Check `ai_explanations_v2` collection exists
3. Ensure question has `question_text` (required)

### Cached Explanation Not Appearing
1. Check `ai_explanations_v2` MongoDB collection
2. Verify cache key is correct: sha1(questionId|userAnswer|correctAnswer|isCorrect)
3. Try with `_debug: true` in request for detailed logging

### Performance Issues
1. Enable caching query index on `cacheKey` field:
   ```javascript
   db.ai_explanations_v2.createIndex({ cacheKey: 1 })
   ```
2. Monitor `ai_explain_requests` for patterns
3. Consider clearing old logs periodically

## Production Deployment

### Steps
1. Set up MongoDB Atlas cluster in GCP
2. Update `MONGO_PROD_URI` in Cloud Run environment
3. Set `GEMINI_API_KEY` in Cloud Run secrets
4. Deploy: `gcloud builds submit && gcloud run deploy`

### Environment Variables in Cloud Run
```bash
gcloud run deploy arxcafe \
  --set-env-vars=GEMINI_API_KEY=xxx \
  --set-env-vars=AI_ASSIST_MODEL=gemini-2.5-flash \
  --set-env-vars=NODE_ENV=production
```

### Monitoring
- Check `ai_explain_requests` collection for usage patterns
- Monitor API quota in Google Cloud Console
- Track explanation quality via cached confidence scores
- Review MongoDB collection sizes periodically

## Future Enhancements

- [ ] Streaming responses for long explanations
- [ ] Multiple language support
- [ ] Difficulty-based explanation depth
- [ ] User feedback on explanation quality
- [ ] A/B testing different explanation styles
- [ ] Integration with monitoring dashboards
