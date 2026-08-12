chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(['darkMode'], (res) => {
    if (res.darkMode === undefined) {
      chrome.storage.sync.set({ darkMode: true });
    }
  });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Handle screenshot capture
  if (request.action === 'captureTab') {
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ dataUrl: dataUrl });
      }
    });
    return true;
  }

  // Optional cloud fallback. Primary OCR runs locally in the offscreen document.
  if (request.action === 'ocr') {
    const imageDataUrl = request.imageDataUrl;

    if (!request.apiKey) {
      sendResponse({ error: 'No OCR.Space fallback key is configured.' });
      return;
    }

    const formData = new FormData();
    formData.append('apikey', request.apiKey);
    formData.append('base64Image', imageDataUrl);
    formData.append('language', 'eng');
    formData.append('isOverlayRequired', 'false');
    formData.append('filetype', 'PNG');
    formData.append('detectOrientation', 'true');
    formData.append('scale', 'true');

    fetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      body: formData
    })
    .then(res => res.json())
    .then(data => {
      console.log('[CineLenz] OCR response:', data);
      if (data.IsErroredOnProcessing) {
        sendResponse({ error: data.ErrorMessage || 'OCR processing error' });
      } else if (!data.ParsedResults || data.ParsedResults.length === 0) {
        sendResponse({ text: '' });
      } else {
        const rawText = data.ParsedResults[0].ParsedText || '';
        sendResponse({ text: rawText });
      }
    })
    .catch(err => {
      console.error('[CineLenz] OCR fetch error:', err);
      sendResponse({ error: err.message || 'OCR network error' });
    });

    return true; // async
  }

  // Fetches the live model list from the caller's own Gemini account so
  // the dropdown stays accurate as Google adds/renames/retires models,
  // instead of a hardcoded list that goes stale. The ListModels API
  // doesn't expose which models are free-tier vs paid-only, so this
  // filters down to text-capable Gemini models suitable for OCR and lets
  // the popup surface Google's own quota page for the free-tier specifics.
  if (request.action === 'listGeminiModels') {
    const { apiKey } = request;
    if (!apiKey) {
      sendResponse({ error: 'No Gemini API key is configured.' });
      return;
    }

    fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${apiKey}`)
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          sendResponse({ error: data.error.message || 'Gemini API error' });
          return;
        }
        const EXCLUDE = /embedding|aqa|tts|image|imagen|veo|lyria|live|computer-use|robotics|-vision-|learnlm/i;
        const models = (data.models || [])
          .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
          .map(m => (m.name || '').replace(/^models\//, ''))
          .filter(id => id && !EXCLUDE.test(id))
          .filter((id, idx, arr) => arr.indexOf(id) === idx);

        // Sort so Flash-Lite (cheapest/highest free quota) leads, then
        // Flash, then Pro, then everything else, newest-first within
        // each group — keeps the recommended choice at the top without
        // hiding any model the account actually has access to.
        function rank(id) {
          if (/flash-lite/.test(id)) return 0;
          if (/flash/.test(id)) return 1;
          if (/pro/.test(id)) return 2;
          return 3;
        }
        models.sort((a, b) => rank(a) - rank(b) || b.localeCompare(a));

        sendResponse({ models });
      })
      .catch(err => {
        console.error('[CineLenz] listGeminiModels fetch error:', err);
        sendResponse({ error: err.message || 'Gemini network error' });
      });

    return true; // async
  }

  // Gemini vision-based OCR. Sends the cropped poster image straight to
  // the Gemini API and asks it to transcribe the title text. Unlike
  // Tesseract, Gemini reads the image semantically, so stylized, curvy,
  // and 3D movie-logo fonts that break classic OCR are usually fine.
  if (request.action === 'geminiOcr') {
    const { imageDataUrl, apiKey, model } = request;

    if (!apiKey) {
      sendResponse({ error: 'No Gemini API key is configured.' });
      return;
    }

    const base64Data = (imageDataUrl || '').split(',')[1] || '';
    const mimeMatch = /^data:([^;]+);base64,/.exec(imageDataUrl || '');
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
    const modelId = model || 'gemini-2.5-flash-lite';

    // Two things matter more than prompt wording for stylized 3D/curvy
    // logo fonts: (1) letting the model briefly reason about letterform
    // shapes before committing, and (2) giving it more than one shot —
    // a single best guess on a heavily stylized title is often *close*
    // but not exact, so asking for ranked alternates and trying each one
    // against the movie database dramatically improves the hit rate.
    const prompt = 'You are reading the title text off a movie or TV show ' +
      'poster/thumbnail. The title may use a highly stylized, decorative, ' +
      'curvy, warped, embossed, metallic, or 3D-rendered font where letters ' +
      'are distorted, merged, overlapped, or replaced with numbers/symbols ' +
      '(common in movie logos). Look closely at each letterform\'s shape, ' +
      'not just its color or texture. Ignore taglines, cast names, ratings, ' +
      'release dates, and studio logos.\n\n' +
      'First, briefly reason step-by-step about what the title says on a line ' +
      'starting with "REASONING:". Then, on the final lines, output up to 3 ' +
      'ranked guesses for the exact title text, most confident first, one per ' +
      'line, each starting with "GUESS:" and nothing else on that line ' +
      '(no numbering, quotes, or punctuation added). If you truly cannot make ' +
      'out any title text at all, output a single line: GUESS: NONE';

    fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType, data: base64Data } }
          ]
        }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 300 }
      })
    })
    .then(res => res.json())
    .then(data => {
      if (data.error) {
        sendResponse({ error: data.error.message || 'Gemini API error' });
        return;
      }
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const raw = parts.map(p => p.text || '').join('\n');

      const guesses = raw
        .split('\n')
        .map(line => line.trim())
        .filter(line => /^GUESS:/i.test(line))
        .map(line => line.replace(/^GUESS:/i, '').trim())
        .filter(line => line && !/^NONE$/i.test(line));

      // Model didn't follow the GUESS: format (can happen on some
      // models/edge cases) — fall back to treating the whole reply as
      // one guess rather than losing the reading entirely.
      const fallback = !guesses.length && raw.trim() && !/^NONE$/i.test(raw.trim())
        ? [raw.replace(/^REASONING:.*$/gim, '').trim()].filter(Boolean)
        : [];

      const finalGuesses = (guesses.length ? guesses : fallback).slice(0, 3);
      sendResponse({ text: finalGuesses[0] || '', guesses: finalGuesses });
    })
    .catch(err => {
      console.error('[CineLenz] Gemini OCR fetch error:', err);
      sendResponse({ error: err.message || 'Gemini network error' });
    });

    return true; // async
  }

  // Local (offline) OCR must run inside an offscreen document rather than
  // the content script: content scripts execute in the *page's* origin
  // (e.g. https://www.google.com), and Chrome blocks `new Worker()` on a
  // chrome-extension:// script from that origin ("cannot be accessed from
  // origin ..."). An offscreen document is an extension-owned page, so the
  // worker can be created there, and we relay messages to it.
  if (request.action === 'ensureOcrReady') {
    ensureOffscreenDocument()
      .then(() => chrome.runtime.sendMessage({
        target: 'imdbLensOffscreen',
        action: 'ocrEnsureReady'
      }))
      .then((result) => sendResponse(result || { error: 'No response from OCR engine.' }))
      .catch((err) => sendResponse({ error: err.message || 'Failed to start OCR engine.' }));
    return true;
  }

  if (request.action === 'ocrRecognize') {
    ensureOffscreenDocument()
      .then(() => chrome.runtime.sendMessage({
        target: 'imdbLensOffscreen',
        action: 'ocrRecognize',
        imageDataUrl: request.imageDataUrl,
        psm: request.psm
      }))
      .then((result) => sendResponse(result || { error: 'No response from OCR engine.' }))
      .catch((err) => sendResponse({ error: err.message || 'OCR engine error.' }));
    return true;
  }

});

let ensureOffscreenPromise = null;

function ensureOffscreenDocument() {
  // Guard the whole check-then-create sequence behind a single shared
  // promise set up-front (synchronously), so two OCR requests arriving
  // back-to-back can't both see "no document yet" and both call
  // createDocument() (which throws on the second call).
  if (!ensureOffscreenPromise) {
    ensureOffscreenPromise = (async () => {
      const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT']
      });
      if (existingContexts.length > 0) return;

      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Run the bundled Tesseract OCR engine to read movie poster titles offline.'
      });
    })().catch((err) => {
      ensureOffscreenPromise = null; // allow retry on failure
      throw err;
    });
  }
  return ensureOffscreenPromise;
}


chrome.tabs.onActivated.addListener(() => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'settingsUpdated' }).catch(() => {});
    }
  });
});
