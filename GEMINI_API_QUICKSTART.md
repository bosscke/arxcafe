# Quick Start: Get Your Gemini API Key

## Step 1: Visit Google AI Studio

Go to: **https://ai.google.dev/tutorials/setup**

You'll see a page like this:
- "Get started with the Gemini API"
- Several API key / project setup options

## Step 2: Click "Get API Key"

Look for the **"Get API Key"** button and click it.

## Step 3: Create a New API Key

You'll be redirected to Google Cloud Console.

If this is your first time:
- You may need to create a Google Cloud project
- Select "Create API Key in new project" or select an existing project
- Choose "API Key"

If API key is already created:
- You'll see existing keys
- You can reuse an existing key

## Step 4: Copy Your API Key

The API key will look like:
```
AIzaSyD_X_X_X_X_X_X_X_X_X_X_X_X_X_X_X_X_X_X_X
```

**Important**: Keep this key secret! Don't commit it to git.

## Step 5: Add to .env File

Create or edit `.env` in your project root:

```bash
GEMINI_API_KEY=AIzaSyD_X_X_X_X_X_X_X_X_X_X_X_X_X_X_X_X_X_X_X
AI_ASSIST_MODEL=gemini-2.5-flash
```

## Step 6: Restart Server

```bash
npm start
```

## Step 7: Test It

1. Go to `http://localhost:8080/ml-engineer-quiz.html`
2. Answer a question
3. Click "📚 Explain this answer"
4. You should see an AI explanation!

## Troubleshooting

### "Could not generate explanation" Error
- Check API key is correct in `.env`
- Verify free tier quota hasn't been exceeded
- Try visiting Google Cloud Console to confirm API is enabled

### "No GEMINI_API_KEY configured" Message
- Check `.env` file exists in project root
- Verify `GEMINI_API_KEY=...` line is present
- Restart server after creating/editing `.env`

### API Key shows "403 Forbidden" in server logs
- The API key may be restricted to specific APIs
- Go to Google Cloud Console → APIs & Services → Credentials
- Edit the API key and ensure "Generative Language API" is included

## Free Tier Limits

Google provides a free tier with:
- **15 requests per minute**
- **1.5 million requests per day**
- **No credit card required** (limited features)

Perfect for development and testing!

## Production Setup

For production, you may want to:

1. **Enable billing** in Google Cloud to increase quotas
2. **Set up API key restrictions**:
   - Go to Google Cloud Console
   - APIs & Services → Credentials
   - Edit your key
   - Restrict to "Generative Language API"
   - Restrict to your domain (optional)

3. **Monitor usage**:
   - Google Cloud Console → APIs & Services → Generative Language API
   - View requests, quota usage, errors

## Cost Examples

| Scenario | Monthly Cost |
|----------|--------------|
| 1,000 explanations (25% of users) | ~$1 |
| 10,000 explanations | ~$10 |
| 100,000 explanations | ~$100 |

**Caching reduces costs by 95%!** (Repeated questions use cache, not API)

## Next Steps

Once API key is working:

1. Verify explanations appear in quiz
2. Check MongoDB for cached results:
   ```javascript
   db.ai_explanations_v2.find().limit(1)
   ```
3. Monitor requests in `ai_explain_requests` collection
4. Continue adding quiz questions

---

**Questions?** Check [AI_EXPLANATIONS_SETUP.md](AI_EXPLANATIONS_SETUP.md) for complete documentation.
