/**
 * AI Quiz Assist - Frontend UI + Control Flow
 * Manages AI explanation bubble, toggle, and Continue vs auto-advance logic
 */

(function() {
  'use strict';

  const STORAGE_KEY = 'cl_ai_quiz_enabled';
  const DEFAULT_ENABLED = true;

  // Get current toggle state
  function isAiEnabled() {
    try {
      const val = localStorage.getItem(STORAGE_KEY);
      if (val === null) return DEFAULT_ENABLED;
      return val === 'true';
    } catch {
      return DEFAULT_ENABLED;
    }
  }

  // Set toggle state
  function setAiEnabled(enabled) {
    try {
      localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
    } catch {
      // ignore
    }
  }

  // SHA-1 hash using crypto.subtle (modern browsers)
  async function sha1Hex(str) {
    try {
      const encoder = new TextEncoder();
      const data = encoder.encode(str);
      const hashBuffer = await crypto.subtle.digest('SHA-1', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch {
      // Fallback to FNV-1a
      return 'fnv1a_' + fnv1aHex(str);
    }
  }

  // Fallback hash: FNV-1a
  function fnv1aHex(str) {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  // Create AI assist UI dynamically
  function createAiAssistUI() {
    const container = document.createElement('div');
    container.className = 'ai-assist';
    container.style.cssText = 'background: var(--color-surface); border: 1px solid var(--border); border-radius: 10px; padding: 20px; margin-top: 20px; display: none; box-shadow: var(--shadow-sm);';

    // Header row
    const header = document.createElement('div');
    header.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;';

    const title = document.createElement('div');
    title.className = 'ai-assist-title';
    title.textContent = 'AI explanation';
    title.style.cssText = 'font-weight: 800; color: var(--color-primary);';

    const toggle = document.createElement('button');
    toggle.className = 'ai-assist-toggle';
    toggle.textContent = isAiEnabled() ? 'AI: On' : 'AI: Off';
    toggle.style.cssText = 'background: rgba(198, 169, 146, 0.22); border: 1px solid rgba(74, 52, 46, 0.25); color: var(--color-primary); padding: 6px 12px; border-radius: 10px; cursor: pointer; font-size: 13px; font-weight: 800;';

    header.appendChild(title);
    header.appendChild(toggle);

    // Body
    const shortDiv = document.createElement('div');
    shortDiv.className = 'ai-assist-short';
    shortDiv.style.cssText = 'font-size: 14px; line-height: 1.6; color: var(--color-text); margin-bottom: 12px;';

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'ai-assist-actions';
    actionsDiv.style.cssText = 'display: none;';

    const continueBtn = document.createElement('button');
    continueBtn.className = 'ai-assist-continue';
    continueBtn.textContent = 'Continue';
    continueBtn.style.cssText = 'background: linear-gradient(135deg, rgba(198, 169, 146, 0.95), rgba(74, 52, 46, 0.95)); border: 1px solid rgba(74, 52, 46, 0.35); color: #fff; padding: 10px 20px; border-radius: 12px; cursor: pointer; font-size: 14px; font-weight: 800;';

    actionsDiv.appendChild(continueBtn);

    const longDiv = document.createElement('div');
    longDiv.className = 'ai-assist-long';
    longDiv.style.cssText = 'display: none;';

    container.appendChild(header);
    container.appendChild(shortDiv);
    container.appendChild(actionsDiv);
    container.appendChild(longDiv);

    return { container, toggle, shortDiv, actionsDiv, continueBtn, longDiv };
  }

  // Main entry point
  async function afterAnswer(opts) {
    const {
      quizId,
      questionText,
      userAnswer,
      correctAnswer,
      isCorrect,
      feedbackEl,
      autoAdvanceDelayMs = 5000,
      aiFetchTimeoutMs = 12000,
      aiEnabled = true,
      onAdvance,
      isStillCurrent
    } = opts;

    if (!feedbackEl) return;

    // Check if AI should be used for this question
    const aiEnabledForQuestion = aiEnabled && isAiEnabled();

    // Remove any existing AI UI
    const existing = feedbackEl.querySelector('.ai-assist');
    if (existing) existing.remove();

    let advanced = false;
    let autoAdvanceTimer = null;

    const advance = () => {
      if (advanced) return;
      advanced = true;
      if (autoAdvanceTimer) clearTimeout(autoAdvanceTimer);
      
      // Remove AI UI when continuing
      const aiContainer = feedbackEl.querySelector('.ai-assist');
      if (aiContainer) aiContainer.remove();
      
      if (onAdvance) onAdvance();
    };

    if (!aiEnabledForQuestion) {
      // Auto-advance after delay
      autoAdvanceTimer = setTimeout(advance, autoAdvanceDelayMs);
      return;
    }

    // AI enabled: create UI immediately
    const ui = createAiAssistUI();
    feedbackEl.appendChild(ui.container);
    ui.container.style.display = 'block';

    // Show Continue button immediately (no auto-advance)
    ui.actionsDiv.style.display = 'block';
    ui.continueBtn.onclick = advance;

    // Set loading state
    ui.shortDiv.textContent = 'Fetching AI explanation…';

    // Toggle handler
    ui.toggle.onclick = () => {
      const newState = !isAiEnabled();
      setAiEnabled(newState);
      ui.toggle.textContent = newState ? 'AI: On' : 'AI: Off';
    };

    // Generate question_id
    const questionId = await sha1Hex(quizId + '|' + questionText);

    // Fetch AI explanation
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), aiFetchTimeoutMs);

    try {
      const response = await fetch('/api/ai/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question_id: questionId,
          question_text: questionText,
          user_answer: userAnswer,
          correct_answer: correctAnswer,
          is_correct: isCorrect,
          quiz_id: quizId,
          difficulty: null,
          explanation_level: 'short',
          _timeout_ms: aiFetchTimeoutMs
        }),
        signal: controller.signal
      });

      clearTimeout(timeout);

      // Race safety: don't update if question changed
      if (!isStillCurrent()) return;
      if (advanced) return;

      const result = await response.json();

      if (result.ok && result.short_explanation) {
        ui.shortDiv.textContent = result.short_explanation;
      } else {
        ui.shortDiv.textContent = 'AI explanation unavailable right now. You can continue, or retry.';
      }

    } catch (err) {
      clearTimeout(timeout);

      // Race safety
      if (!isStillCurrent()) return;
      if (advanced) return;

      if (err.name === 'AbortError') {
        ui.shortDiv.textContent = 'AI explanation is taking too long or unavailable. You can continue, or retry.';
      } else {
        ui.shortDiv.textContent = 'AI explanation unavailable right now. You can continue, or retry.';
      }
    }
  }

  // Export to global scope
  window.CzechLessonAiQuizAssist = {
    afterAnswer
  };

})();
